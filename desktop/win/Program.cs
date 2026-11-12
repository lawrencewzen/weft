using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Weft.Desktop
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            StartupTimer.Begin();
            if (args.Length > 0 && args[0] == "--self-check") return SelfCheck.Run(args);
            if (args.Length > 0 && args[0] == "--service-check") return ServiceCheck.Run(args);
            bool first;
            using (var mutex = new Mutex(true, @"Local\Weft.Desktop.Shell", out first))
            {
                var activate = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\Weft.Desktop.Activate");
                StartupTimer.Mark("single_instance_checked");
                if (!first)
                {
                    StartupTimer.Note("second instance, woke the running one and exit");
                    StartupTimer.Flush(false);
                    // Wake the window of the running instance, then leave.
                    activate.Set();
                    return 0;
                }
                // The manifest already asks for PerMonitorV2; this keeps the intent explicit (returns false if already set).
                Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(activate));
                GC.KeepAlive(mutex);
            }
            return 0;
        }
    }

    // Startup timing for the desktop shell (T133-2). Measures only; no behaviour depends on it.
    // Each phase is logged to %LOCALAPPDATA%\Weft\shell.log as "STARTUP-PHASE name=... at_ms=...",
    // and one "STARTUP key=value ..." summary line is written after the first page finished loading.
    internal static class StartupTimer
    {
        private static readonly object gate = new object();
        private static readonly Stopwatch sw = new Stopwatch();
        private static readonly List<KeyValuePair<string, long>> marks = new List<KeyValuePair<string, long>>();
        private static readonly List<string> extras = new List<string>();
        private static long preMainMs = -1;
        private static bool flushed;

        public static string LogPath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Weft", "shell.log");
        }

        public static void Begin()
        {
            sw.Start();
            try { preMainMs = (long)Math.Max(0, (DateTime.Now - Process.GetCurrentProcess().StartTime).TotalMilliseconds); } catch { }
            Mark("process_start");
        }

        public static void Mark(string name)
        {
            long t = sw.ElapsedMilliseconds;
            lock (gate)
            {
                foreach (var m in marks) if (m.Key == name) return; // first hit only
                marks.Add(new KeyValuePair<string, long>(name, t));
            }
            Append("STARTUP-PHASE name=" + name + " at_ms=" + t);
        }

        public static void Note(string kv)
        {
            lock (gate) extras.Add(kv);
            Append("STARTUP-NOTE " + kv);
        }

        private static void Append(string line)
        {
            try
            {
                string path = LogPath();
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                lock (gate) File.AppendAllText(path, DateTime.Now.ToString("s") + " " + line + "\r\n");
            }
            catch { }
        }

        /// Writes the one-line summary (once). Phase values are ms since Main; "d_<name>" is the gap to the previous phase.
        public static void Flush(bool complete)
        {
            string line;
            lock (gate)
            {
                if (flushed) return;
                flushed = true;
                var sb = new StringBuilder("STARTUP");
                sb.Append(" complete=").Append(complete ? "1" : "0");
                sb.Append(" total_ms=").Append(sw.ElapsedMilliseconds);
                if (preMainMs >= 0) sb.Append(" pre_main_ms=").Append(preMainMs);
                long prev = 0;
                foreach (var m in marks)
                {
                    sb.Append(' ').Append(m.Key).Append("_ms=").Append(m.Value);
                    sb.Append(' ').Append("d_").Append(m.Key).Append("_ms=").Append(m.Value - prev);
                    prev = m.Value;
                }
                foreach (var e in extras) sb.Append(' ').Append(e);
                line = sb.ToString();
            }
            Append(line);
        }
    }

    internal enum RuntimeSource { None, Bundled, Evergreen }

    internal sealed class RuntimeChoice
    {
        public RuntimeSource Source;
        public string Folder;   // browser executable folder for Bundled, otherwise null
        public string Version;  // e.g. "157.0.4341.46", null when none
        public string Error;
    }

    // Picks the WebView2 runtime: the fixed version next to Weft.exe first, then the system Evergreen runtime.
    internal static class WebViewRuntime
    {
        public static string BundledDir()
        {
            string exeDir = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
            return Path.Combine(exeDir, "webview2");
        }

        public static RuntimeChoice Choose()
        {
            var c = new RuntimeChoice { Source = RuntimeSource.None };
            string dir = BundledDir();
            if (File.Exists(Path.Combine(dir, "msedgewebview2.exe")))
            {
                try
                {
                    c.Version = CoreWebView2Environment.GetAvailableBrowserVersionString(dir);
                    c.Source = RuntimeSource.Bundled;
                    c.Folder = dir;
                    return c;
                }
                catch (Exception ex) { c.Error = "bundled: " + ex.Message; }
            }
            try
            {
                c.Version = CoreWebView2Environment.GetAvailableBrowserVersionString();
                if (!string.IsNullOrEmpty(c.Version)) c.Source = RuntimeSource.Evergreen;
            }
            catch (WebView2RuntimeNotFoundException) { }
            catch (Exception ex) { c.Error = (c.Error == null ? "" : c.Error + "; ") + "evergreen: " + ex.Message; }
            return c;
        }

        // Fixed Version known issue: the folder must be readable and executable by ALL APPLICATION PACKAGES
        // (S-1-15-2-1) and ALL RESTRICTED APPLICATION PACKAGES (S-1-15-2-2), or the renderer sandbox fails on Windows 10.
        // https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution#details-about-the-fixed-version-runtime-distribution-mode
        private static readonly string[] PackageSids = { "S-1-15-2-1", "S-1-15-2-2" };

        public static bool PermissionsReady(string dir)
        {
            try
            {
                var rules = new DirectoryInfo(dir).GetAccessControl().GetAccessRules(true, true, typeof(SecurityIdentifier));
                foreach (string sid in PackageSids)
                {
                    bool ok = false;
                    foreach (FileSystemAccessRule r in rules)
                    {
                        if (r.IdentityReference.Value != sid || r.AccessControlType != AccessControlType.Allow) continue;
                        if ((r.FileSystemRights & FileSystemRights.ReadAndExecute) == FileSystemRights.ReadAndExecute) { ok = true; break; }
                    }
                    if (!ok) return false;
                }
                return true;
            }
            catch (Exception) { return false; }
        }

        // Grants the two package SIDs read+execute (inherited). Failure is returned as text, never thrown.
        public static string EnsurePermissions(string dir)
        {
            if (PermissionsReady(dir)) return null;
            var errors = new StringBuilder();
            foreach (string sid in PackageSids)
            {
                try
                {
                    var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "icacls.exe"))
                    {
                        Arguments = "\"" + dir + "\" /grant *" + sid + ":(OI)(CI)(RX) /T /C /Q",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                    };
                    using (var p = Process.Start(psi))
                    {
                        string o = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                        if (!p.WaitForExit(120000)) { try { p.Kill(); } catch { } errors.Append(sid + ": icacls timeout; "); }
                        else if (p.ExitCode != 0) errors.Append(sid + ": icacls exit " + p.ExitCode + " " + o.Trim() + "; ");
                    }
                }
                catch (Exception ex) { errors.Append(sid + ": " + ex.Message + "; "); }
            }
            return PermissionsReady(dir) ? null : (errors.Length > 0 ? errors.ToString() : "permissions still missing");
        }
    }

    // `Weft.exe --self-check [--out file]`: no window. Prints to the console it was started from (when there is one)
    // and, with --out, also to a file, because a WinExe has no console of its own in CI.
    internal static class SelfCheck
    {
        [DllImport("kernel32.dll")] private static extern bool AttachConsole(int pid);

        public static int Run(string[] args)
        {
            string outFile = null;
            for (int i = 1; i < args.Length - 1; i++) if (args[i] == "--out") outFile = args[i + 1];
            var sb = new StringBuilder();
            int code = 0;
            try
            {
                sb.AppendLine("dotnet: " + Environment.Version + " (" + System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription + ")");
                sb.AppendLine("os: " + Environment.OSVersion);
                // Regression guard for the .NET 8 missing-key throw: ApplyDataDir must fill in a missing WEFT_DATA_DIR.
                var probe = new ProcessStartInfo("node.exe");
                probe.Environment.Remove("WEFT_DATA_DIR");
                ServiceRunner.ApplyDataDir(probe);
                bool dataOk = probe.Environment["WEFT_DATA_DIR"] == ServiceRunner.DefaultDataDir();
                sb.AppendLine("datadir.default: " + (dataOk ? "ok" : "wrong"));
                if (!dataOk) code = 4;
                var c = WebViewRuntime.Choose();
                sb.AppendLine("webview2.source: " + c.Source.ToString().ToLowerInvariant());
                sb.AppendLine("webview2.version: " + (c.Version ?? "none"));
                if (c.Folder != null) sb.AppendLine("webview2.folder: " + c.Folder);
                if (c.Error != null) sb.AppendLine("webview2.note: " + c.Error);
                if (c.Source == RuntimeSource.Bundled)
                {
                    string err = WebViewRuntime.EnsurePermissions(c.Folder);
                    bool ready = WebViewRuntime.PermissionsReady(c.Folder);
                    sb.AppendLine("webview2.permissions: " + (ready ? "ready" : "missing"));
                    if (err != null) sb.AppendLine("webview2.permissions.error: " + err);
                    if (!ready) code = 2;
                }
                else
                {
                    sb.AppendLine("webview2.permissions: n/a");
                    if (c.Source == RuntimeSource.None) code = 3;
                }
            }
            catch (Exception ex)
            {
                sb.AppendLine("error: " + ex);
                code = 1;
            }
            sb.AppendLine("exit: " + code);
            Emit(sb.ToString(), outFile);
            return code;
        }

        public static void Emit(string text, string outFile)
        {
            try { AttachConsole(-1); Console.Out.Write(text); Console.Out.Flush(); } catch { }
            if (outFile != null) { try { File.WriteAllText(outFile, text, new UTF8Encoding(false)); } catch { } }
        }
    }

    internal sealed class MainForm : Form
    {
        private static readonly Regex PickFolderRegex = new Regex(@"^pick-folder:([A-Za-z0-9_-]{1,40})$", RegexOptions.Compiled);

        private readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        private readonly EventWaitHandle activate;
        private string origin;

        // The system title bar is removed from the very first window message (client area starts at the top)
        // and the page draws its own window buttons. Decided before the window exists, so nothing flashes.
        // Only chosen when the installed WebView2 Runtime can do non-client regions; otherwise the system title bar stays.
        private bool customFrame;
        private bool runtimeMissing;
        private RuntimeChoice choice;

        // Closing the window is handed to the page (it knows closeAction). The process
        // exits only after the page says quit, or when the page cannot answer yet.
        private volatile bool allowClose;
        private volatile bool quitting;
        private bool handingClose;
        private readonly object launchLock = new object();
        private Process launcherProcess;
        private NotifyIcon tray;
        private Icon trayIcon;

        private const int PageCloseTimeoutMs = 2000;
        private const string AskPageToCloseScript =
            "(function(){var b=document.querySelector('[data-testid=\"window-close\"]');if(!b)return 'missing';b.click();return 'ok';})()";

        // CoreWebView2Settings.IsNonClientRegionSupportEnabled first ships in Release SDK 1.0.2420.47, which
        // "requires WebView2 Runtime 123.0.2420.47 or later"
        // (https://learn.microsoft.com/microsoft-edge/webview2/release-notes/sdk/1-0-2420-47).
        private static readonly Version MinNonClientRuntime = new Version(123, 0, 2420, 47);

        // Page background used before the page is there: last real page colour (shell.json), else the default light theme.
        private readonly SplashBar splash;
        private bool lastMaximized;

        private const int WM_NCCALCSIZE = 0x0083;
        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int HTCAPTION = 2;
        private const int HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14;
        private const int TopGripPx = 4; // overlay strip above the web view that takes over top-edge resizing
        private const uint SWP_FRAMECHANGED = 0x0037; // NOMOVE|NOSIZE|NOZORDER|NOACTIVATE|FRAMECHANGED
        private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2;

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] private static extern int GetSystemMetricsForDpi(int index, uint dpi);
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr h);
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] private static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);

        private int ResizeFrame(bool vertical)
        {
            const int SM_CXSIZEFRAME = 32, SM_CYSIZEFRAME = 33, SM_CXPADDEDBORDER = 92;
            try
            {
                uint dpi = GetDpiForWindow(Handle);
                return GetSystemMetricsForDpi(vertical ? SM_CYSIZEFRAME : SM_CXSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
            }
            catch (EntryPointNotFoundException)
            {
                return GetSystemMetrics(vertical ? SM_CYSIZEFRAME : SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
            }
        }

        // Remove only the top title bar: the client area starts at the very top of the window.
        // Left, right and bottom keep the system's invisible resize borders and shadow.
        // The top non-client height must be exactly 0; any leftover makes Windows 10 still paint a caption above the page.
        protected override void WndProc(ref Message m)
        {
            if (customFrame && m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                int originalTop = Marshal.ReadInt32(m.LParam, 4);
                base.WndProc(ref m); // default shrinks all four sides (the top by frame + caption)
                // Ask Windows, not WindowState: Form only updates WindowState after this message.
                // Maximized windows overhang the screen by the frame width; push the top down by it so nothing is clipped.
                Marshal.WriteInt32(m.LParam, 4, originalTop + (IsZoomed(Handle) ? ResizeFrame(true) : 0));
                m.Result = IntPtr.Zero;
                return;
            }
            inWndProc++;
            try { base.WndProc(ref m); } finally { inWndProc--; }
            return;
        }

        // Leaving maximized, Form re-applies a remembered size computed as if the caption existed, so the
        // window grew by one caption height every time. While handling window messages keep the bounds Windows chose.
        private int inWndProc;
        protected override void SetBoundsCore(int x, int y, int w, int h, BoundsSpecified sp)
        {
            RECT r;
            if (customFrame && inWndProc > 0 && sp == BoundsSpecified.All && IsHandleCreated && WindowState == FormWindowState.Normal && GetWindowRect(Handle, out r))
            {
                x = r.Left; y = r.Top; w = r.Right - r.Left; h = r.Bottom - r.Top;
            }
            base.SetBoundsCore(x, y, w, h, sp);
        }

        // With no top non-client area the web view covers the top edge, so a thin strip above it takes over resizing.
        private sealed class TopGrip : Control
        {
            private readonly MainForm owner;
            internal TopGrip(MainForm owner)
            {
                this.owner = owner;
                SetStyle(ControlStyles.Opaque | ControlStyles.UserPaint, true);
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
                Visible = false;
            }
            // Layered at ~0% opacity: invisible, but it still receives the mouse, so the page shows through.
            protected override CreateParams CreateParams
            {
                get { var cp = base.CreateParams; cp.ExStyle |= 0x00080000; return cp; } // WS_EX_LAYERED
            }
            protected override void OnHandleCreated(EventArgs e)
            {
                base.OnHandleCreated(e);
                SetLayeredWindowAttributes(Handle, 0, 1, 0x2); // LWA_ALPHA
            }
            protected override void OnPaintBackground(PaintEventArgs e) { }
            protected override void OnPaint(PaintEventArgs e) { }
            private int Hit(int x)
            {
                int corner = owner.ResizeFrame(false);
                return x < corner ? HTTOPLEFT : x >= Width - corner ? HTTOPRIGHT : HTTOP;
            }
            protected override void OnMouseMove(MouseEventArgs e)
            {
                base.OnMouseMove(e);
                int h = Hit(e.X);
                Cursor = h == HTTOP ? Cursors.SizeNS : h == HTTOPLEFT ? Cursors.SizeNWSE : Cursors.SizeNESW;
            }
            protected override void OnMouseDown(MouseEventArgs e)
            {
                base.OnMouseDown(e);
                if (e.Button != MouseButtons.Left) return;
                ReleaseCapture();
                SendMessage(owner.Handle, WM_NCLBUTTONDOWN, (IntPtr)Hit(e.X), IntPtr.Zero);
            }
        }
        private readonly TopGrip grip;

        // Rare: the frame was removed up front but WebView2 refused non-client regions. Give the title bar back.
        private void DropCustomFrame()
        {
            customFrame = false;
            grip.Visible = false;
            HideSplash();
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, SWP_FRAMECHANGED);
        }

        private static string ShellFile
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Weft", "shell.json"); }
        }

        // What the shell needs to draw the page's window buttons before the page is up. The page reports the real
        // values (--bg, --ink, --mute, --hover, --fail, --term of the current theme, and the html zoom --ui-zoom);
        // until it has, these are the default light theme and its default zoom (app.css :root --ui-zoom).
        private Color bgColor = Color.FromArgb(0xfc, 0xfc, 0xfc);
        private Color inkColor = Color.FromArgb(0x1f, 0x1f, 0x1f);
        private Color muteColor = Color.FromArgb(0x6e, 0x6e, 0x6e);
        private Color hoverColor = Color.FromArgb(0xef, 0xef, 0xef);
        private Color failColor = Color.FromArgb(0xb9, 0x46, 0x42);
        private Color termColor = Color.FromArgb(0x1a, 0x1a, 0x1a);
        private double uiZoom = 0.9;

        private static Color ParseHex(string hex)
        {
            int v = int.Parse(hex.TrimStart('#'), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            return Color.FromArgb((v >> 16) & 255, (v >> 8) & 255, v & 255);
        }

        private static string Hex(Color c) { return "#" + c.R.ToString("x2") + c.G.ToString("x2") + c.B.ToString("x2"); }

        private void LoadTheme()
        {
            try
            {
                string json = File.ReadAllText(ShellFile);
                Func<string, string> hex = key =>
                {
                    var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"(#[0-9a-fA-F]{6})\"");
                    return m.Success ? m.Groups[1].Value : null;
                };
                string bg = hex("bg"), ink = hex("ink"), mute = hex("mute"), hover = hex("hover"), fail = hex("fail"), term = hex("term");
                var z = Regex.Match(json, "\"zoom\"\\s*:\\s*([0-9.]+)");
                double zoom;
                if (bg != null && ink != null && mute != null && hover != null && fail != null && term != null
                    && z.Success && double.TryParse(z.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out zoom) && zoom > 0.2 && zoom < 5)
                {
                    bgColor = ParseHex(bg); inkColor = ParseHex(ink); muteColor = ParseHex(mute);
                    hoverColor = ParseHex(hover); failColor = ParseHex(fail); termColor = ParseHex(term);
                    uiZoom = zoom;
                }
            }
            catch { }
        }

        // The page reports its palette whenever the theme changes; remember it for the next cold start.
        // Message: "theme:" + six #rrggbb (bg, ink, mute, hover, fail, term) + "," + zoom.
        private void SaveTheme(string[] f)
        {
            double zoom = double.Parse(f[6], CultureInfo.InvariantCulture);
            if (zoom <= 0.2 || zoom >= 5) return;
            var bg = ParseHex(f[0]);
            bool bgChanged = bg.ToArgb() != bgColor.ToArgb();
            bgColor = bg; inkColor = ParseHex(f[1]); muteColor = ParseHex(f[2]);
            hoverColor = ParseHex(f[3]); failColor = ParseHex(f[4]); termColor = ParseHex(f[5]);
            uiZoom = zoom;
            if (bgChanged) { BackColor = bg; splash.BackColor = bg; }
            splash.Invalidate();
            // Written even when it equals the fallback: the record, not the fallback, must win from now on.
            string json = "{\"bg\":\"" + Hex(bgColor) + "\",\"ink\":\"" + Hex(inkColor) + "\",\"mute\":\"" + Hex(muteColor)
                + "\",\"hover\":\"" + Hex(hoverColor) + "\",\"fail\":\"" + Hex(failColor) + "\",\"term\":\"" + Hex(termColor)
                + "\",\"zoom\":" + zoom.ToString("0.###", CultureInfo.InvariantCulture) + "}";
            try
            {
                if (File.Exists(ShellFile) && File.ReadAllText(ShellFile) == json) return;
                Directory.CreateDirectory(Path.GetDirectoryName(ShellFile));
                File.WriteAllText(ShellFile, json);
            }
            catch { }
        }

        private int Dpi()
        {
            try { return IsHandleCreated ? (int)GetDpiForWindow(Handle) : DeviceDpi; }
            catch (EntryPointNotFoundException) { return DeviceDpi; }
        }

        private void LayoutSplash()
        {
            if (!customFrame || splash == null) return;
            splash.Bounds = new Rectangle(0, 0, ClientSize.Width, ClientSize.Height);
        }

        // Covers the whole client area in the page colour until the page has painted (the web view shows an unstyled
        // canvas of its own for a moment on a dark system). Its top row drags the window and carries the same three
        // window buttons as the page's WindowControls (web/src/styles/app.css, "Desktop shell"): bar 52px, buttons 30x30,
        // gap 4px, 12px from the right edge, 14px icons with a 1.5 stroke, 7px radius; all multiplied by the page zoom
        // (html { zoom: var(--ui-zoom) }) and the window DPI.
        private sealed class SplashBar : Control
        {
            private readonly MainForm owner;
            private int hot = -1, pressed = -1; // 0 minimize, 1 maximize/restore, 2 close
            internal SplashBar(MainForm owner)
            {
                this.owner = owner;
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
                Visible = false;
            }
            private float K() { return (float)(owner.uiZoom * owner.Dpi() / 96.0); }
            private float BarHeight() { return 52f * K(); }
            private RectangleF ButtonRect(int i)
            {
                float k = K();
                float right = Width - 12f * k;
                float x = right - (3 - i) * 30f * k - (2 - i) * 4f * k;
                return new RectangleF(x, (52f - 30f) / 2f * k, 30f * k, 30f * k);
            }
            private int HitButton(Point p)
            {
                for (int i = 0; i < 3; i++) if (ButtonRect(i).Contains(p)) return i;
                return -1;
            }
            private static GraphicsPath RoundRect(RectangleF r, float radius)
            {
                var p = new GraphicsPath();
                float d = radius * 2;
                p.AddArc(r.X, r.Y, d, d, 180, 90);
                p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
                p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
                p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
                p.CloseFigure();
                return p;
            }
            // The same shapes as ICONS in WindowControls.tsx, in the 14x14 viewBox.
            private GraphicsPath Icon(int i)
            {
                var p = new GraphicsPath();
                if (i == 0) { p.AddLine(2.5f, 7f, 11.5f, 7f); return p; }
                if (i == 2) { p.AddLine(3f, 3f, 11f, 11f); p.StartFigure(); p.AddLine(11f, 3f, 3f, 11f); return p; }
                if (owner.WindowState != FormWindowState.Maximized) { p.AddPath(RoundRect(new RectangleF(2.5f, 2.5f, 9f, 9f), 1.5f), false); return p; }
                p.AddPath(RoundRect(new RectangleF(2.5f, 4.5f, 7f, 7f), 1.5f), false);
                p.StartFigure();
                p.AddLine(4.5f, 4.5f, 4.5f, 4f);
                p.AddArc(4.5f, 2.5f, 3f, 3f, 180, 90);
                p.AddLine(6f, 2.5f, 11.5f, 2.5f);
                p.AddLine(11.5f, 2.5f, 11.5f, 8f);
                p.AddArc(8.5f, 6.5f, 3f, 3f, 0, 90);
                p.AddLine(10f, 9.5f, 9.5f, 9.5f);
                return p;
            }
            protected override void OnPaint(PaintEventArgs e)
            {
                var g = e.Graphics;
                g.Clear(BackColor);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.Half; // pixel centres at +0.5, like Chromium; the default shifts everything half a pixel
                float k = K();
                for (int i = 0; i < 3; i++)
                {
                    var raw = ButtonRect(i);
                    // Chromium snaps box edges and the svg origin to whole device pixels; do the same so the icons land on the same pixels.
                    float x0 = (float)Math.Round(raw.Left), y0 = (float)Math.Round(raw.Top);
                    var r = new RectangleF(x0, y0, (float)Math.Round(raw.Right) - x0, (float)Math.Round(raw.Bottom) - y0);
                    float ix = (float)Math.Round(raw.X + (raw.Width - 14f * k) / 2f), iy = (float)Math.Round(raw.Y + (raw.Height - 14f * k) / 2f);
                    bool lit = hot == i;
                    if (lit)
                    {
                        using (var path = RoundRect(r, 7f * k))
                        using (var br = new SolidBrush(i == 2 ? owner.failColor : owner.hoverColor))
                            g.FillPath(br, path);
                    }
                    var ink = lit ? (i == 2 ? owner.termColor : owner.inkColor) : owner.muteColor;
                    using (var pen = new Pen(ink, 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                    using (var icon = Icon(i))
                    {
                        var state = g.Save();
                        g.TranslateTransform(ix, iy);
                        g.ScaleTransform(k, k);
                        g.DrawPath(pen, icon);
                        g.Restore(state);
                    }
                }
            }
            protected override void OnMouseMove(MouseEventArgs e)
            {
                base.OnMouseMove(e);
                int h = HitButton(e.Location);
                if (h != hot) { hot = h; Invalidate(); }
            }
            protected override void OnMouseLeave(EventArgs e)
            {
                base.OnMouseLeave(e);
                if (hot != -1 || pressed != -1) { hot = -1; pressed = -1; Invalidate(); }
            }
            protected override void OnMouseDown(MouseEventArgs e)
            {
                base.OnMouseDown(e);
                if (e.Button != MouseButtons.Left) return;
                int b = HitButton(e.Location);
                if (b >= 0) { pressed = b; return; }
                if (e.Y >= BarHeight()) return; // below the top row the cover is only a backdrop
                if (e.Clicks >= 2)
                {
                    owner.WindowState = owner.WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                    return;
                }
                ReleaseCapture();
                SendMessage(owner.Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
            }
            protected override void OnMouseUp(MouseEventArgs e)
            {
                base.OnMouseUp(e);
                int b = pressed;
                pressed = -1;
                if (b < 0 || HitButton(e.Location) != b) return;
                if (b == 0) owner.WindowState = FormWindowState.Minimized;
                else if (b == 1) owner.WindowState = owner.WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                else owner.Close();
            }
        }

        // Hand the top row over to the page once it is loaded, has switched on its own window buttons and has
        // drawn them. The page announces that with its first theme message, which is sent after React rendered;
        // between "navigation completed" and that render the bare page canvas shows, and on a dark system it is
        // not the page colour. If the message never comes, a timer lets go anyway.
        private System.Windows.Forms.Timer handOverTimer;
        private void HideSplash()
        {
            if (handOverTimer != null) { handOverTimer.Stop(); handOverTimer.Dispose(); handOverTimer = null; }
            splash.Visible = false;
            // The page background stand-in set at document creation is no longer needed.
            var core = web.CoreWebView2;
            if (core != null) { try { core.ExecuteScriptAsync("document.documentElement.style.removeProperty('background')"); } catch { } }
        }

        // The page reports after it painted, but the web view needs a moment to present that frame; uncovering at once shows its old surface.
        private void HideSplashSoon(int ms)
        {
            if (!splash.Visible) return;
            if (handOverTimer != null) { handOverTimer.Stop(); handOverTimer.Dispose(); }
            handOverTimer = new System.Windows.Forms.Timer { Interval = ms };
            handOverTimer.Tick += (o, a) => HideSplash();
            handOverTimer.Start();
        }

        private async Task HandOverToPage(CoreWebView2 core)
        {
            if (!splash.Visible || handOverTimer != null) return;
            try
            {
                string flag = await core.ExecuteScriptAsync("document.documentElement.dataset.desktopShell||''");
                if (flag != "\"1\"") return;
            }
            catch { return; }
            if (!splash.Visible || handOverTimer != null) return;
            HideSplashSoon(5000); // fallback if the page never reports
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            LayoutSplash();
            ApplyWindowIcons();
            // Windows 11 rounded corners; Windows 10 rejects the attribute and that is fine.
            try { int round = DWMWCP_ROUND; DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int)); } catch { }
        }

        private const int WM_SETICON = 0x0080;

        // Form.Icon carries one size only. Pick the 16/32-class frame for the title bar and taskbar
        // (ICON_SMALL) and the 48/256-class frame for Alt+Tab and the large taskbar icon (ICON_BIG),
        // both from the ico embedded in the exe, at the window's DPI.
        private void ApplyWindowIcons()
        {
            try
            {
                uint dpi = GetDpiForWindow(Handle);
                if (dpi == 0) dpi = 96;
                int small = GetSystemMetricsForDpi(49, dpi); // SM_CXSMICON
                int big = GetSystemMetricsForDpi(11, dpi);   // SM_CXICON
                using (var s = typeof(MainForm).Assembly.GetManifestResourceStream("weft.ico"))
                {
                    if (s == null) return;
                    var buf = new byte[s.Length];
                    int n = 0;
                    while (n < buf.Length) { int r = s.Read(buf, n, buf.Length - n); if (r <= 0) break; n += r; }
                    smallIcon = new Icon(new MemoryStream(buf), new Size(small, small));
                    bigIcon = new Icon(new MemoryStream(buf), new Size(big, big));
                }
                SendMessage(Handle, WM_SETICON, (IntPtr)0, smallIcon.Handle);
                SendMessage(Handle, WM_SETICON, (IntPtr)1, bigIcon.Handle);
            }
            catch { }
        }

        private Icon smallIcon, bigIcon;

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            LayoutSplash();
            PushMaximized();
        }

        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            LayoutSplash();
        }

        private void PushMaximized()
        {
            bool max = WindowState == FormWindowState.Maximized;
            if (max == lastMaximized && !pushForce) return;
            lastMaximized = max;
            pushForce = false;
            grip.Visible = customFrame && !max;
            var core = web.CoreWebView2;
            if (!customFrame || core == null) return;
            core.ExecuteScriptAsync(max
                ? "document.documentElement.dataset.windowMaximized='1'"
                : "delete document.documentElement.dataset.windowMaximized");
        }
        private bool pushForce;

        private void OnShellMessage(CoreWebView2WebMessageReceivedEventArgs a)
        {
            // Only our own page may drive the window.
            // Page -> shell: minimize, toggle-maximize, close, hide-to-tray, quit, theme, pick-folder.
            // Shell -> page: confirm-quit (tray "退出 Weft"), posted with PostWebMessageAsString.
            if (!SameOrigin(a.Source)) return;
            string msg;
            try { msg = a.TryGetWebMessageAsString(); } catch (ArgumentException) { return; }
            if (Regex.IsMatch(msg, "^theme:#[0-9a-fA-F]{6}(,#[0-9a-fA-F]{6}){5},[0-9]{1,2}(\\.[0-9]{1,3})?$"))
            {
                SaveTheme(msg.Substring(6).Split(','));
                HideSplashSoon(150);
                return;
            }
            var mPick = PickFolderRegex.Match(msg);
            if (mPick.Success)
            {
                HandlePickFolder(mPick.Groups[1].Value);
                return;
            }
            switch (msg)
            {
                case "minimize": WindowState = FormWindowState.Minimized; break;
                case "toggle-maximize":
                    WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                    break;
                case "close": HandCloseToPage(); break;
                case "hide-to-tray": HideToTray(); break;
                case "quit": QuitProcess(); break;
            }
        }

        // The page draws the close button and applies closeAction. A system close (Alt+F4, the
        // splash close button) asks that button to run. If the page is not up yet, quit outright.
        private async void HandCloseToPage()
        {
            if (quitting || handingClose || allowClose) return;
            handingClose = true;
            bool accepted = false;
            try { accepted = await AskPageToHandleClose(); }
            catch { accepted = false; }
            if (!accepted && !quitting) QuitProcess();
            if (!quitting) handingClose = false;
        }

        private async Task<bool> AskPageToHandleClose()
        {
            var core = web.CoreWebView2;
            if (core == null || splash.Visible) return false;
            var script = core.ExecuteScriptAsync(AskPageToCloseScript);
            var finished = await Task.WhenAny(script, Task.Delay(PageCloseTimeoutMs));
            if (finished != script) return false;
            return await script == "\"ok\"";
        }

        private void HideToTray()
        {
            if (quitting) return;
            try { EnsureTray(); }
            catch { return; }
            if (tray == null) return;
            tray.Visible = true;
            ShowInTaskbar = false;
            Hide();
        }

        private void ShowFromTray()
        {
            ShowInTaskbar = true;
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
        }

        private void EnsureTray()
        {
            if (tray != null) return;
            trayIcon = TrayIconImage();
            tray = new NotifyIcon
            {
                Icon = trayIcon,
                Text = "Weft",
                Visible = false,
            };
            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("打开 Weft");
            open.Click += (o, e) => ShowFromTray();
            var quit = new ToolStripMenuItem("退出 Weft");
            quit.Click += (o, e) => RequestConfirmQuit();
            menu.Items.Add(open);
            menu.Items.Add(quit);
            tray.ContextMenuStrip = menu;
            tray.MouseDoubleClick += (o, e) =>
            {
                if (e.Button == MouseButtons.Left) ShowFromTray();
            };
        }

        private Icon TrayIconImage()
        {
            if (smallIcon != null) return (Icon)smallIcon.Clone();
            if (Icon != null) return (Icon)Icon.Clone();
            try
            {
                var extracted = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (extracted != null) return extracted;
            }
            catch { }
            return (Icon)SystemIcons.Application.Clone();
        }

        private void DisposeTray()
        {
            if (tray != null)
            {
                tray.Visible = false;
                tray.Dispose();
                tray = null;
            }
            if (trayIcon != null)
            {
                trayIcon.Dispose();
                trayIcon = null;
            }
        }

        // Tray "退出 Weft": if the window is hidden, show it first, then ask the page to confirm.
        private void RequestConfirmQuit()
        {
            if (quitting) return;
            if (!Visible || WindowState == FormWindowState.Minimized) ShowFromTray();
            else Activate();
            BeginInvoke(new Action(PostConfirmQuit));
        }

        private void PostConfirmQuit()
        {
            if (quitting) return;
            var core = web.CoreWebView2;
            if (core == null || splash.Visible)
            {
                QuitProcess();
                return;
            }
            try { core.PostWebMessageAsString("confirm-quit"); }
            catch { QuitProcess(); }
        }

        // Hide first, stop the service the same way as `weft stop`, then exit.
        // Exit 2 (a task is still running) leaves the window open; the service stays up.
        private void QuitProcess()
        {
            if (quitting) return;
            quitting = true;
            bool hadTray = tray != null && tray.Visible;
            if (tray != null) tray.Visible = false;
            Hide();
            Task.Run(() =>
            {
                StopLauncher();
                int code = 1;
                string detail = "";
                try { code = RunWeftStop(out detail); }
                catch (Exception ex) { detail = ex.Message; }
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        if (code == 0)
                        {
                            FinishQuit();
                            return;
                        }
                        quitting = false;
                        if (hadTray)
                        {
                            EnsureTray();
                            tray.Visible = true;
                        }
                        ShowFromTray();
                        string text = code == 2
                            ? "服务正在运行任务，没有停止"
                            : "停止服务失败。" + (string.IsNullOrWhiteSpace(detail) ? "" : "\n\n" + detail);
                        MessageBox.Show(this, text, "Weft", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }));
                }
                catch
                {
                    Environment.Exit(code == 0 ? 0 : 1);
                }
            });
        }

        private void FinishQuit()
        {
            allowClose = true;
            DisposeTray();
            Close();
        }

        private void CloseLeavingService()
        {
            allowClose = true;
            Close();
        }

        private void StopLauncher()
        {
            Process p;
            lock (launchLock) p = launcherProcess;
            if (p == null) return;
            try
            {
                if (!p.HasExited) p.Kill();
            }
            catch { }
        }

        // Same command as Weft-stop.cmd: `node app\bin\weft.mjs stop`. Exit 0 means the service is gone.
        private int RunWeftStop(out string detail)
        {
            return ServiceRunner.Stop(AppDomain.CurrentDomain.BaseDirectory, out detail);
        }

        private bool isPickingFolder;

        private void HandlePickFolder(string requestId)
        {
            if (isPickingFolder)
            {
                // Only one folder picker dialog is allowed at a time.
                // Concurrent requests are immediately replied to as cancelled.
                SendPickFolderResult(requestId, "cancelled", null);
                return;
            }

            isPickingFolder = true;
            try
            {
                BeginInvoke(new Action(() =>
                {
                    try
                    {
                        string path = PickFolderModern(Handle);
                        if (!string.IsNullOrEmpty(path))
                        {
                            SendPickFolderResult(requestId, "picked", path);
                        }
                        else
                        {
                            SendPickFolderResult(requestId, "cancelled", null);
                        }
                    }
                    finally
                    {
                        isPickingFolder = false;
                    }
                }));
            }
            catch
            {
                isPickingFolder = false;
            }
        }

        private void SendPickFolderResult(string requestId, string status, string path)
        {
            var core = web.CoreWebView2;
            if (core == null) return;
            string json;
            if (status == "picked" && !string.IsNullOrEmpty(path))
            {
                json = "{\"type\":\"pick-folder-result\",\"id\":" + EscapeJsonString(requestId)
                    + ",\"status\":\"picked\",\"path\":" + EscapeJsonString(path) + "}";
            }
            else
            {
                json = "{\"type\":\"pick-folder-result\",\"id\":" + EscapeJsonString(requestId)
                    + ",\"status\":\"cancelled\"}";
            }
            try { core.PostWebMessageAsJson(json); } catch { }
        }

        private static string EscapeJsonString(string s)
        {
            if (s == null) return "null";
            var sb = new System.Text.StringBuilder();
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 32) sb.AppendFormat(CultureInfo.InvariantCulture, "\\u{0:x4}", (int)c);
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        private const uint FOS_PICKFOLDERS = 0x00000020;
        private const uint FOS_FORCEFILESYSTEM = 0x00000040;
        private const uint SIGDN_FILESYSPATH = 0x80058000;
        private const uint SIGDN_DESKTOPABSOLUTEPARSING = 0x80028000;
        private const int ERROR_CANCELLED_HR = unchecked((int)0x800704C7);

        private string PickFolderModern(IntPtr ownerHandle)
        {
            try
            {
                var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
                try
                {
                    uint options;
                    dialog.GetOptions(out options);
                    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
                    int hr = dialog.Show(ownerHandle);
                    if (hr == 0)
                    {
                        IShellItem item;
                        dialog.GetResult(out item);
                        if (item != null)
                        {
                            try
                            {
                                string path;
                                try
                                {
                                    item.GetDisplayName(SIGDN_FILESYSPATH, out path);
                                }
                                catch
                                {
                                    item.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, out path);
                                }
                                return path;
                            }
                            finally
                            {
                                Marshal.ReleaseComObject(item);
                            }
                        }
                    }
                    if (hr == ERROR_CANCELLED_HR)
                    {
                        return null;
                    }
                }
                finally
                {
                    Marshal.ReleaseComObject(dialog);
                }
            }
            catch
            {
                // Modern COM dialog failed, fall back to WinForms FolderBrowserDialog
            }

            try
            {
                using (var fbd = new FolderBrowserDialog())
                {
                    fbd.ShowNewFolderButton = true;
                    if (fbd.ShowDialog(this) == DialogResult.OK)
                    {
                        return fbd.SelectedPath;
                    }
                }
            }
            catch { }

            return null;
        }

        private bool SameOrigin(string uri)
        {
            Uri u;
            return origin != null && Uri.TryCreate(uri, UriKind.Absolute, out u)
                && string.Equals(u.GetLeftPart(UriPartial.Authority), origin, StringComparison.OrdinalIgnoreCase);
        }

        // Also paints the page's bare canvas in the splash colour: before the page CSS arrives a dark system shows Chromium's own
        // dark canvas (#121212) instead, which flashed for half a second between the splash and the first page paint.
        private string ShellScript()
        {
            return "(function(){var f=function(){var e=document.documentElement;e.dataset.desktopShell='1';e.style.background='#"
                + bgColor.R.ToString("x2") + bgColor.G.ToString("x2") + bgColor.B.ToString("x2") + "'};"
            + "if(document.documentElement)f();else new MutationObserver(function(_,o){if(document.documentElement){o.disconnect();f()}})"
            + ".observe(document,{childList:true})})();";
        }

        // The frame is already custom (runtime version checked up front). If WebView2 still refuses, fall back to the system title bar.
        private async Task TryEnableCustomFrame(CoreWebView2 core)
        {
            try
            {
                core.Settings.IsNonClientRegionSupportEnabled = true;
                await core.AddScriptToExecuteOnDocumentCreatedAsync(ShellScript());
                core.WebMessageReceived += (o, a) => OnShellMessage(a);
                core.NavigationCompleted += async (o, a) =>
                {
                    pushForce = true;
                    PushMaximized();
                    if (a.IsSuccess) await HandOverToPage(core);
                };
            }
            catch (Exception)
            {
                try { core.Settings.IsNonClientRegionSupportEnabled = false; } catch { }
                if (customFrame) DropCustomFrame();
            }
        }

        internal MainForm(EventWaitHandle activate)
        {
            this.activate = activate;
            Text = "Weft";
            LoadTheme();
            BackColor = bgColor;
            web.BackColor = bgColor;
            web.DefaultBackgroundColor = bgColor;
            DecideFrame();
            if (customFrame)
            {
                // No title bar: the 1280x800 client area is the window minus the side and bottom borders.
                int f = GetSystemMetrics(32) + GetSystemMetrics(92);
                Size = new Size(1280 + 2 * f, 800 + f);
            }
            else ClientSize = new Size(1280, 800);
            MinimumSize = new Size(800, 560);
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            // Real icons are applied per size once the handle exists (ApplyWindowIcons).
            grip = new TopGrip(this);
            grip.Bounds = new Rectangle(0, 0, ClientSize.Width, TopGripPx);
            splash = new SplashBar(this) { BackColor = bgColor };
            Controls.Add(web);
            Controls.Add(splash);
            Controls.Add(grip);
            grip.BringToFront(); // overlays the top edge of the web view
            if (customFrame)
            {
                splash.Visible = true;
                splash.BringToFront();
                splash.Size = ClientSize;
                grip.Visible = true;
                grip.BringToFront();
            }

            var waiter = new Thread(() =>
            {
                while (activate.WaitOne())
                {
                    try { BeginInvoke(new Action(Bring)); } catch { return; }
                }
            }) { IsBackground = true };
            waiter.Start();
        }

        private void Bring()
        {
            ShowFromTray();
        }

        private void DecideFrame()
        {
            try
            {
                choice = WebViewRuntime.Choose();
                runtimeMissing = choice.Source == RuntimeSource.None;
                // e.g. "123.0.2420.47" or "125.0.2535.13 beta"
                Version ver;
                customFrame = !runtimeMissing && choice.Version != null
                    && Version.TryParse(choice.Version.Split(' ')[0], out ver) && ver >= MinNonClientRuntime;
            }
            catch (Exception) { }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Logoff must not be held up by the page. The service is stopped with the session.
            if (e.CloseReason == CloseReason.WindowsShutDown)
            {
                allowClose = true;
            }
            if (allowClose)
            {
                base.OnFormClosing(e);
                return;
            }
            // Let the page apply closeAction. Cancel so the window stays until it answers.
            e.Cancel = true;
            if (!quitting) BeginInvoke(new Action(HandCloseToPage));
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            DisposeTray();
            base.OnFormClosed(e);
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            StartupTimer.Mark("window_shown");
            try { await Start(); }
            catch (Exception ex) { Fail("启动失败：" + ex.Message); }
        }

        private async Task Start()
        {
            StartupTimer.Mark("service_launch_begin");
            string url = await Task.Run(() => LaunchService());
            if (quitting || url == null) return;
            StartupTimer.Mark("service_ready");
            origin = new Uri(url).GetLeftPart(UriPartial.Authority);

            if (runtimeMissing)
            {
                MessageBox.Show(this, "没有找到 WebView2 运行库，将改用默认浏览器打开 Weft。\n如需独立窗口，请先安装 Microsoft Edge WebView2 Runtime。",
                    "Weft", MessageBoxButtons.OK, MessageBoxIcon.Information);
                OpenExternal(url);
                // The browser keeps using the service, so this close must not run weft stop.
                CloseLeavingService();
                return;
            }

            string userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Weft", "WebView2");
            StartupTimer.Note("webview2_userdata=" + userData);
            StartupTimer.Note("webview2_userdata_first_run=" + (Directory.Exists(userData) ? "0" : "1"));
            StartupTimer.Note("webview2_source=" + (choice == null ? "none" : choice.Source.ToString().ToLowerInvariant()));
            string browserDir = null;
            if (choice != null && choice.Source == RuntimeSource.Bundled)
            {
                browserDir = choice.Folder;
                // Failure is only logged: the user may have extracted the folder somewhere we cannot change.
                string permErr = await Task.Run(() => WebViewRuntime.EnsurePermissions(browserDir));
                if (permErr != null)
                {
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(userData));
                        File.AppendAllText(Path.Combine(Path.GetDirectoryName(userData), "shell.log"),
                            DateTime.Now.ToString("s") + " WebView2 folder permissions: " + permErr + "\r\n");
                    }
                    catch { }
                }
            }
            StartupTimer.Mark("webview2_env_begin");
            var env = await CoreWebView2Environment.CreateAsync(browserDir, userData);
            StartupTimer.Mark("webview2_env_created");
            await web.EnsureCoreWebView2Async(env);
            StartupTimer.Mark("webview2_core_ready");

            var core = web.CoreWebView2;
            var s = core.Settings;
            s.AreDevToolsEnabled = false;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            // Ctrl+F and other page shortcuts stay on; only the status bar and zoom are off.

            core.NavigationStarting += (o, a) =>
            {
                if (IsExternal(a.Uri)) { a.Cancel = true; OpenExternal(a.Uri); }
            };
            core.NewWindowRequested += (o, a) =>
            {
                a.Handled = true;
                if (IsExternal(a.Uri)) OpenExternal(a.Uri);
                else core.Navigate(a.Uri);
            };
            core.DownloadStarting += OnDownloadStarting;
            await TryEnableCustomFrame(core);
            core.NavigationCompleted += (o, a) =>
            {
                StartupTimer.Mark("first_navigation_completed");
                StartupTimer.Note("first_navigation_success=" + (a.IsSuccess ? "1" : "0"));
                StartupTimer.Flush(true);
            };
            StartupTimer.Mark("navigate_start");
            core.Navigate(url);
        }

        /// Downloads from this service (the problem report zip) get a Save As window instead of the
        /// WebView2 download bubble; the saved file is then selected in Explorer. Other origins keep the default.
        private void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs a)
        {
            Uri u;
            if (!Uri.TryCreate(a.DownloadOperation.Uri, UriKind.Absolute, out u)
                || !string.Equals(u.GetLeftPart(UriPartial.Authority), origin, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(u.Host, "127.0.0.1", StringComparison.Ordinal))
            {
                // blob: downloads are created by the page itself; treat them as ours too.
                if (!a.DownloadOperation.Uri.StartsWith("blob:http://127.0.0.1", StringComparison.OrdinalIgnoreCase)) return;
            }
            var op = a.DownloadOperation;
            string suggested = Path.GetFileName(a.ResultFilePath ?? "");
            if (string.IsNullOrEmpty(suggested)) suggested = "weft-report.zip";
            string chosen = null;
            using (var dlg = new SaveFileDialog())
            {
                dlg.FileName = suggested;
                dlg.Filter = "zip (*.zip)|*.zip";
                dlg.DefaultExt = "zip";
                dlg.AddExtension = true;
                dlg.OverwritePrompt = true;
                try { dlg.InitialDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"); } catch { }
                if (dlg.ShowDialog(this) == DialogResult.OK) chosen = dlg.FileName;
            }
            if (chosen == null) { a.Cancel = true; return; }
            a.ResultFilePath = chosen;
            a.Handled = true;
            op.StateChanged += (o, e) =>
            {
                if (op.State != CoreWebView2DownloadState.Completed) return;
                try { Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + chosen + "\"") { UseShellExecute = true }); } catch { }
            };
        }

        private bool IsExternal(string uri)
        {
            if (uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)
                || uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
                || uri.StartsWith("blob:", StringComparison.OrdinalIgnoreCase)) return false;
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) return false;
            return !string.Equals(u.GetLeftPart(UriPartial.Authority), origin, StringComparison.OrdinalIgnoreCase);
        }

        private static void OpenExternal(string uri)
        {
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) return;
            if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return;
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { }
        }

        /// Runs on a worker thread. Starts or reuses the service and returns the login URL, or null after showing an error.
        private string LaunchService()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            var lines = new List<string>();
            try
            {
                string hit = ServiceRunner.Launch(dir, lines, p => { lock (launchLock) launcherProcess = p; }, () => quitting);
                // The shell always runs `weft open --print`; whether that started a new service or reused a running one is decided by node.
                StartupTimer.Note("service_path=weft-open-print");
                if (hit != null) return hit;
            }
            catch (Exception ex)
            {
                if (quitting) return null;
                lines.Add(ex.Message);
            }
            if (quitting) return null;
            string head;
            lock (lines) head = string.Join("\n", lines.GetRange(0, Math.Min(5, lines.Count)));
            Fail("Weft 服务启动失败。\n\n" + head);
            return null;
        }

        private void Fail(string message)
        {
            if (quitting || allowClose) return;
            if (InvokeRequired) { Invoke(new Action(() => Fail(message))); return; }
            if (quitting || allowClose) return;
            MessageBox.Show(this, message, "Weft", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    [ComImport]
    [Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOpenDialog
    {
        [PreserveSig]
        int Show([In] IntPtr parent);

        void SetFileTypes([In] uint cFileTypes, [In] IntPtr rgFilterSpec);
        void SetFileTypeIndex([In] uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise([In] IntPtr pfde, out uint pdwCookie);
        void Unadvise([In] uint dwCookie);
        void SetOptions([In] uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder([In, MarshalAs(UnmanagedType.Interface)] IShellItem psi);
        void SetFolder([In, MarshalAs(UnmanagedType.Interface)] IShellItem psi);
        void GetFolder([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
        void GetCurrentSelection([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
        void SetFileName([In, MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([In, MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([In, MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([In, MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
        void AddPlace([In, MarshalAs(UnmanagedType.Interface)] IShellItem psi, int fdap);
        void SetDefaultExtension([In, MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close([MarshalAs(UnmanagedType.Error)] int hr);
        void SetClientGuid([In] ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);

        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport]
    [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler([In, MarshalAs(UnmanagedType.Interface)] IntPtr pbc, [In] ref Guid bhid, [In] ref Guid riid, out IntPtr ppv);
        void GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
        void GetDisplayName([In] uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes([In] uint sfgaoMask, out uint psfgaoAttribs);
        void Compare([In, MarshalAs(UnmanagedType.Interface)] IShellItem psi, [In] uint hint, out int piOrder);
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    internal class FileOpenDialogRCW
    {
    }
}
