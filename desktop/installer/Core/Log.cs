namespace Weft.Setup;

public static class Log
{
    static readonly object Gate = new();
    public static string Path { get; set; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "Weft-Setup.log");

    public static void Write(string msg)
    {
        try
        {
            lock (Gate)
                File.AppendAllText(Path, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{Environment.ProcessId}] {msg}{Environment.NewLine}");
        }
        catch
        {
            // 日志写不进去不影响安装
        }
    }
}
