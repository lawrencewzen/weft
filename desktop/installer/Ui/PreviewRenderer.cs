namespace Weft.Setup.Ui;

/// <summary>--render-preview：不安装任何东西，按指定缩放把各界面状态渲染成 PNG，便于不上真机看画面。</summary>
public static class PreviewRenderer
{
    public static readonly string[] States =
    {
        "install", "progress", "progress-files", "progress-stalled", "done", "upgrade", "done-upgrade", "error-running", "error-disk", "uninstall", "quit-confirm",
    };

    public static int Run(CliOptions cli)
    {
        var dir = Path.GetFullPath(cli.PreviewDir!);
        Directory.CreateDirectory(dir);
        var themes = cli.PreviewTheme == null ? new[] { "dark", "light" } : new[] { cli.PreviewTheme };
        var n = 0;
        try
        {
            foreach (var theme in themes)
            foreach (var scale in cli.PreviewScales)
            foreach (var state in States)
            {
                Theme.Apply(theme == "dark");
                Dpi.Override = (float)scale;
                var ctx = new SetupContext
                {
                    Mode = InstallMode.Install, NewVersion = "0.1.3", OldVersion = "0.1.2", DesktopShortcut = true,
                    Dir = Engine.DefaultDir,
                };
                using var form = new MainForm(ctx, null, preview: true)
                {
                    StartPosition = FormStartPosition.Manual,
                    ShowInTaskbar = false,
                    Location = new Point(-20000, -20000),
                };
                form.Show();
                form.ShowPreviewState(state);
                Application.DoEvents();
                using var bmp = new Bitmap(form.Width, form.Height);
                form.DrawToBitmap(bmp, new Rectangle(0, 0, form.Width, form.Height));
                var name = $"{theme}-{scale.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)}x-{state}.png";
                bmp.Save(Path.Combine(dir, name), System.Drawing.Imaging.ImageFormat.Png);
                form.Close();
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
