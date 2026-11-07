using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
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

        // True once WebView2 non-client regions are on: the system title bar is removed
        // (client area starts at the top) and the page draws its own window buttons.
        private bool customFrame;
        private bool lastMaximized;

        private const int WM_NCCALCSIZE = 0x0083;
        private const int WM_NCHITTEST = 0x0084;
        private const int HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14;
        private const int TopGripPx = 2; // keep a thin non-client strip so the top edge can still be dragged to resize
        private const uint SWP_FRAMECHANGED = 0x0037; // NOMOVE|NOSIZE|NOZORDER|NOACTIVATE|FRAMECHANGED

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] private static extern int GetSystemMetricsForDpi(int index, uint dpi);
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr h);

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

        // Remove only the top title bar. Left, right and bottom keep the system's invisible resize borders and shadow.
        protected override void WndProc(ref Message m)
        {
            if (customFrame && m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                int originalTop = Marshal.ReadInt32(m.LParam, 4);
                base.WndProc(ref m); // default shrinks left, right, bottom (and top)
                bool max = WindowState == FormWindowState.Maximized;
                // Maximized windows overhang the screen by the frame width; push the top down by it so nothing is clipped.
                Marshal.WriteInt32(m.LParam, 4, originalTop + (max ? ResizeFrame(true) : TopGripPx));
                m.Result = IntPtr.Zero;
                return;
            }
            if (customFrame && m.Msg == WM_NCHITTEST && WindowState == FormWindowState.Normal)
            {
                long l = m.LParam.ToInt64();
                int x = (short)(l & 0xFFFF), y = (short)((l >> 16) & 0xFFFF);
                RECT r;
                if (GetWindowRect(Handle, out r) && y >= r.Top && y < r.Top + TopGripPx && x >= r.Left && x < r.Right)
                {
                    int corner = ResizeFrame(false);
                    m.Result = (IntPtr)(x < r.Left + corner ? HTTOPLEFT : x >= r.Right - corner ? HTTOPRIGHT : HTTOP);
                    return;
                }
            }
            base.WndProc(ref m);
        }

        private void UseCustomFrame()
        {
            customFrame = true;
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, SWP_FRAMECHANGED);
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            PushMaximized();
        }

        private void PushMaximized()
        {
            bool max = WindowState == FormWindowState.Maximized;
            if (max == lastMaximized && !pushForce) return;
            lastMaximized = max;
            pushForce = false;
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

        private const string ShellScript =
            "(function(){var f=function(){document.documentElement.dataset.desktopShell='1'};"
            + "if(document.documentElement)f();else new MutationObserver(function(_,o){if(document.documentElement){o.disconnect();f()}})"
            + ".observe(document,{childList:true})})();";

        // Needs a runtime with non-client region support. Any failure keeps the system title bar and leaves the page untouched.
        private async Task TryEnableCustomFrame(CoreWebView2 core)
        {
            try
            {
                core.Settings.IsNonClientRegionSupportEnabled = true;
                await core.AddScriptToExecuteOnDocumentCreatedAsync(ShellScript);
                core.WebMessageReceived += (o, a) => OnShellMessage(a);
                core.NavigationCompleted += (o, a) => { pushForce = true; PushMaximized(); };
                UseCustomFrame();
            }
            catch (Exception)
            {
                try { core.Settings.IsNonClientRegionSupportEnabled = false; } catch { }
            }
        }

        internal MainForm(EventWaitHandle activate)
        {
            this.activate = activate;
            Text = "Weft";
            ClientSize = new Size(1280, 800);
            MinimumSize = new Size(800, 560);
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            Controls.Add(web);

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

            try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (WebView2RuntimeNotFoundException)
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
