namespace Weft.Setup.Ui;

/// <summary>--render-preview：不安装任何东西，按指定缩放把各界面状态渲染成 PNG，便于不上真机看画面。</summary>
public static class PreviewRenderer
{
    public static readonly string[] States =
    {
        "install", "progress", "progress-files", "progress-stalled", "progress-log", "error-log", "done", "upgrade", "done-upgrade", "error-running", "error-disk", "uninstall", "quit-confirm",
    };

    public static int Run(CliOptions cli)
    {
        var dir = Path.GetFullPath(cli.PreviewDir!);
        Directory.CreateDirectory(dir);
        var themes = cli.PreviewTheme == null ? new[] { "dark", "light" } : new[] { cli.PreviewTheme };
        LogPane.Offscreen = true;
        var n = 0;
        var cur = "";
        // 总超时：整个预览渲染不允许超过 90 秒，到点输出已渲染数量并退出
        var guard = new Thread(() =>
        {
            Thread.Sleep(90_000);
            var msg = $"预览渲染超时，已渲染 {n} 张，卡在 {cur}";
            Log.Write(msg);
            Console.Error.WriteLine(msg);
            Environment.Exit(3);
        }) { IsBackground = true };
        guard.Start();
        try
        {
            foreach (var theme in themes)
            foreach (var scale in cli.PreviewScales)
            foreach (var state in States)
            {
                cur = $"{theme} {scale}x {state}";
                Log.Write("预览 " + cur);
                Theme.Apply(theme == "dark");
                Dpi.Override = (float)scale;
                var ctx = new SetupContext
                {
                    Mode = InstallMode.Install, NewVersion = "0.1.3", OldVersion = "0.1.2", DesktopShortcut = true,
                    Dir = Engine.DefaultDir,
                };
                // 窗口放在屏幕外并 Show：没 Show 过的窗体 DrawToBitmap 画不出子控件（实测全空白）。
                // 日志区不用 TextBox（LogPane.Offscreen），不进 Application.Run，不弹任何对话框。
                using var form = new MainForm(ctx, null, preview: true)
                {
                    StartPosition = FormStartPosition.Manual,
                    ShowInTaskbar = false,
                    Location = new Point(-20000, -20000),
                };
                form.Show();
                Log.Write("预览 构建完成");
                form.ShowPreviewState(state);
                Application.DoEvents();
                Log.Write("预览 状态就绪");
                using var bmp = new Bitmap(form.Width, form.Height);
                form.DrawToBitmap(bmp, new Rectangle(0, 0, form.Width, form.Height));
                var name = $"{theme}-{scale.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)}x-{state}.png";
                bmp.Save(Path.Combine(dir, name), System.Drawing.Imaging.ImageFormat.Png);
                n++;
            }
        }
        catch (Exception e)
        {
            Log.Write("预览渲染失败: " + e);
            Console.Error.WriteLine(e);
            return 1;
        }
        finally { Dpi.Override = null; }
        Log.Write($"预览渲染完成 {n} 张 → {dir}");
        return 0;
    }
}
