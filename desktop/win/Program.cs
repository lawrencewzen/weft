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
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Weft.Desktop
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            bool first;
            using (var mutex = new Mutex(true, @"Local\Weft.Desktop.Shell", out first))
            {
                var activate = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\Weft.Desktop.Activate");
                if (!first)
                {
                    // Wake the window of the running instance, then leave.
                    activate.Set();
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(activate));
                GC.KeepAlive(mutex);
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private static readonly Regex LoginUrl = new Regex(@"http://127\.0\.0\.1:\d+/auth\?code=\S+", RegexOptions.Compiled);
        private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(60);

        private readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        private readonly EventWaitHandle activate;
        private string origin;

        // The system title bar is removed from the very first window message (client area starts at the top)
        // and the page draws its own window buttons. Decided before the window exists, so nothing flashes.
        // Only chosen when the installed WebView2 Runtime can do non-client regions; otherwise the system title bar stays.
        private bool customFrame;
        private bool runtimeMissing;

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
            // Windows 11 rounded corners; Windows 10 rejects the attribute and that is fine.
            try { int round = DWMWCP_ROUND; DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int)); } catch { }
        }

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
            // Only our own service may drive the window, and only these three actions.
            if (!SameOrigin(a.Source)) return;
            string msg;
            try { msg = a.TryGetWebMessageAsString(); } catch (ArgumentException) { return; }
            if (Regex.IsMatch(msg, "^theme:#[0-9a-fA-F]{6}(,#[0-9a-fA-F]{6}){5},[0-9]{1,2}(\\.[0-9]{1,3})?$"))
            {
                SaveTheme(msg.Substring(6).Split(','));
                HideSplashSoon(150);
                return;
            }
            switch (msg)
            {
                case "minimize": WindowState = FormWindowState.Minimized; break;
                case "toggle-maximize":
                    WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                    break;
                case "close": Close(); break; // window only; the service keeps running
            }
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
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        private void DecideFrame()
        {
            try
            {
                string v = CoreWebView2Environment.GetAvailableBrowserVersionString();
                // e.g. "123.0.2420.47" or "125.0.2535.13 beta"
                Version ver;
                customFrame = Version.TryParse(v.Split(' ')[0], out ver) && ver >= MinNonClientRuntime;
            }
            catch (WebView2RuntimeNotFoundException) { runtimeMissing = true; }
            catch (Exception) { }
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            try { await Start(); }
            catch (Exception ex) { Fail("启动失败：" + ex.Message); }
        }

        private async Task Start()
        {
            string url = await Task.Run(() => LaunchService());
            if (url == null) return;
            origin = new Uri(url).GetLeftPart(UriPartial.Authority);

            if (runtimeMissing)
            {
                MessageBox.Show(this, "没有找到 WebView2 运行库，将改用默认浏览器打开 Weft。\n如需独立窗口，请先安装 Microsoft Edge WebView2 Runtime。",
                    "Weft", MessageBoxButtons.OK, MessageBoxIcon.Information);
                OpenExternal(url);
                Close();
                return;
            }

            string userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Weft", "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await web.EnsureCoreWebView2Async(env);

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
            await TryEnableCustomFrame(core);
            core.Navigate(url);
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
            string node = Path.Combine(dir, "node", "node.exe");
            string cli = Path.Combine(dir, "app", "bin", "weft.mjs");
            var lines = new List<string>();
            try
            {
                var psi = new ProcessStartInfo(node)
                {
                    Arguments = "\"" + cli + "\" open --print",
                    WorkingDirectory = dir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = System.Text.Encoding.UTF8,
                    StandardErrorEncoding = System.Text.Encoding.UTF8,
                };
                if (string.IsNullOrWhiteSpace(psi.EnvironmentVariables["WEFT_DATA_DIR"]))
                    psi.EnvironmentVariables["WEFT_DATA_DIR"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Weft");

                var p = new Process { StartInfo = psi };
                DataReceivedEventHandler collect = (o, a) => { if (a.Data != null) lock (lines) lines.Add(a.Data); };
                p.OutputDataReceived += collect;
                p.ErrorDataReceived += collect;
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();

                var deadline = DateTime.UtcNow + StartTimeout;
                while (DateTime.UtcNow < deadline)
                {
                    string hit = FindUrl(lines);
                    if (hit != null) return hit;
                    if (p.HasExited)
                    {
                        Thread.Sleep(300); // let the last output lines arrive
                        hit = FindUrl(lines);
                        if (hit != null) return hit;
                        break;
                    }
                    Thread.Sleep(100);
                }
                if (!p.HasExited)
                {
                    try { p.Kill(); } catch { }
                    lines.Add("(等待 " + (int)StartTimeout.TotalSeconds + " 秒仍无结果，已超时)");
                }
            }
            catch (Exception ex)
            {
                lines.Add(ex.Message);
            }
            string head;
            lock (lines) head = string.Join("\n", lines.GetRange(0, Math.Min(5, lines.Count)));
            Fail("Weft 服务启动失败。\n\n" + head);
            return null;
        }

        private static string FindUrl(List<string> lines)
        {
            lock (lines)
            {
                for (int i = lines.Count - 1; i >= 0; i--)
                {
                    var m = LoginUrl.Match(lines[i]);
                    if (m.Success) return m.Value;
                }
            }
            return null;
        }

        private void Fail(string message)
        {
            if (InvokeRequired) { Invoke(new Action(() => Fail(message))); return; }
            MessageBox.Show(this, message, "Weft", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }
}
