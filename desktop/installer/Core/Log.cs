namespace Weft.Setup;

public static class Log
{
    static readonly object Gate = new();
    public static string Path { get; set; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "Weft-Setup.log");

    // 界面「详细信息」用的最近日志：环形缓冲，写入只是一次加锁和赋值，不拖慢写文件
    public const int RingSize = 200;
    static readonly string[] Ring = new string[RingSize];
    static long _seq;

    public static void Write(string msg)
    {
        var now = DateTime.Now;
        AddToRing($"{now:HH:mm:ss.fff} {msg}");
        try
        {
            lock (Gate)
                File.AppendAllText(Path, $"{now:yyyy-MM-dd HH:mm:ss.fff} [{Environment.ProcessId}] {msg}{Environment.NewLine}");
        }
        catch
        {
            // 日志写不进去不影响安装
        }
    }

    public static void AddToRing(string line)
    {
        line = line.Replace("\r", "").Replace("\n", " | ");
        lock (Ring) { Ring[_seq % RingSize] = line; _seq++; }
    }

    public static void ResetRing() { lock (Ring) { Array.Clear(Ring); _seq = 0; } }

    /// <summary>seq 之后新增的行（最多 RingSize 行），并把 seq 推进到最新。</summary>
    public static string[] Since(ref long seq)
    {
        lock (Ring)
        {
            var n = (int)Math.Min(_seq - seq, RingSize);
            if (n <= 0) { seq = _seq; return Array.Empty<string>(); }
            var res = new string[n];
            for (var i = 0; i < n; i++) res[i] = Ring[(_seq - n + i) % RingSize];
            seq = _seq;
            return res;
        }
    }

    public static string[] Snapshot(out long seq)
    {
        seq = 0;
        return Since(ref seq);
    }
}
