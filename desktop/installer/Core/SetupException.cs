namespace Weft.Setup;

public enum FailKind { Other, Running, Disk, Payload, Cancelled }

public sealed class SetupException : Exception
{
    public FailKind Kind { get; }
    public long NeededBytes { get; }

    public SetupException(FailKind kind, string message, long neededBytes = 0, Exception? inner = null)
        : base(message, inner)
    {
        Kind = kind;
        NeededBytes = neededBytes;
    }

    /// <summary>静默模式的进程退出码。</summary>
    public int ExitCode => Kind switch
    {
        FailKind.Running => 2,
        FailKind.Disk => 3,
        FailKind.Payload => 4,
        FailKind.Cancelled => 8,
        _ => 1,
    };

    public static bool IsDiskFull(Exception e)
    {
        // ERROR_HANDLE_DISK_FULL 39, ERROR_DISK_FULL 112
        var code = e.HResult & 0xFFFF;
        return e is IOException && (code == 39 || code == 112);
    }
}
