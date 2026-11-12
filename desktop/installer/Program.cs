using Weft.Setup.Ui;

namespace Weft.Setup;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        var cli = CliOptions.Parse(args);
        Log.Write("启动 " + string.Join(' ', args));

        if (cli.PreviewDir != null && cli.Error == null)
        {
            ApplicationConfiguration.Initialize();
            return PreviewRenderer.Run(cli);
        }

        using var mutex = new Mutex(true, @"Local\Weft-Setup-Instance", out var first);
        if (!first)
        {
            Log.Write("已有另一个安装程序在运行");
            return 7;
        }

        if (cli.Error != null && cli.Silent)
        {
            Log.Write(cli.Error);
            return 5;
        }

        var ctx = Engine.BuildContext(cli, out var fatal);
        if (fatal != null) Log.Write(fatal);

        try
        {
            if (cli.Silent) return RunSilent(cli, ctx);

            ApplicationConfiguration.Initialize();
            var form = new MainForm(ctx, fatal ?? cli.Error);
            Application.Run(form);
            return form.ResultCode;
        }
        finally
        {
            Engine.RunPendingSelfDelete();
        }
    }

    static int RunSilent(CliOptions cli, SetupContext? ctx)
    {
        if (ctx == null) return cli.Uninstall ? 9 : 4;
        ProgressFn none = (_, _) => { };
        try
        {
            if (ctx.Mode == InstallMode.Uninstall) Engine.Uninstall(ctx, none, CancellationToken.None);
            else Engine.Install(ctx, none, CancellationToken.None);
            return 0;
        }
        catch (SetupException e)
        {
            return e.ExitCode;
        }
        catch (Exception e)
        {
            Log.Write("未处理的错误: " + e);
            return 1;
        }
    }
}
