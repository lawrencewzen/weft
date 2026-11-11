using System.Security.Cryptography;
using System.Text;

namespace Weft.Setup;

public sealed record PayloadInfo(long Offset, long Length, byte[] Sha256);

/// <summary>
/// 安装程序 = 安装器 exe + 载荷 zip + 64 字节尾部标记。
/// 尾部：offset(u64 LE) length(u64 LE) sha256(32) magic(16)。
/// </summary>
public static class Payload
{
    public const int TrailerSize = 64;
    public static readonly byte[] Magic = Encoding.ASCII.GetBytes("WEFTSETUPPAYLOAD");

    public static byte[] BuildTrailer(long offset, long length, byte[] sha256)
    {
        if (sha256.Length != 32) throw new ArgumentException("sha256 必须 32 字节");
        var t = new byte[TrailerSize];
        BitConverter.TryWriteBytes(t.AsSpan(0, 8), offset);
        BitConverter.TryWriteBytes(t.AsSpan(8, 8), length);
        sha256.CopyTo(t, 16);
        Magic.CopyTo(t, 48);
        return t;
    }

    public static PayloadInfo? ParseTrailer(byte[] trailer, long fileLength)
    {
        if (trailer.Length != TrailerSize) return null;
        if (!trailer.AsSpan(48, 16).SequenceEqual(Magic)) return null;
        var offset = BitConverter.ToInt64(trailer, 0);
        var length = BitConverter.ToInt64(trailer, 8);
        if (offset <= 0 || length <= 0 || offset + length + TrailerSize != fileLength) return null;
        return new PayloadInfo(offset, length, trailer.AsSpan(16, 32).ToArray());
    }

    /// <summary>没有载荷（比如 uninstall.exe）返回 null。</summary>
    public static PayloadInfo? TryRead(string exePath)
    {
        using var fs = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (fs.Length < TrailerSize) return null;
        fs.Seek(-TrailerSize, SeekOrigin.End);
        var t = new byte[TrailerSize];
        fs.ReadExactly(t);
        return ParseTrailer(t, fs.Length);
    }

    /// <summary>流式校验载荷 SHA256，不整个读进内存。</summary>
    public static void Verify(string exePath, PayloadInfo info, Action<double>? progress = null, CancellationToken ct = default)
    {
        using var s = Open(exePath, info);
        using var h = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buf = new byte[1 << 20];
        long done = 0;
        int n;
        while ((n = s.Read(buf, 0, buf.Length)) > 0)
        {
            ct.ThrowIfCancellationRequested();
            h.AppendData(buf, 0, n);
            done += n;
            progress?.Invoke((double)done / info.Length);
        }
        if (!h.GetHashAndReset().AsSpan().SequenceEqual(info.Sha256))
            throw new SetupException(FailKind.Payload, "安装包已损坏（校验失败）");
    }

    public static Stream Open(string exePath, PayloadInfo info)
    {
        var fs = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, FileOptions.RandomAccess);
        return new SubStream(fs, info.Offset, info.Length);
    }

    /// <summary>把安装器本体（载荷之前的部分）复制出来，用作 uninstall.exe。</summary>
    public static void CopyHead(string exePath, long headLength, string destPath)
    {
        using var src = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var dst = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None);
        var buf = new byte[1 << 20];
        long left = headLength;
        while (left > 0)
        {
            var n = src.Read(buf, 0, (int)Math.Min(buf.Length, left));
            if (n <= 0) throw new EndOfStreamException();
            dst.Write(buf, 0, n);
            left -= n;
        }
    }
}

/// <summary>基础流上的只读窗口 [offset, offset+length)，可寻址，ZipArchive 要用。</summary>
public sealed class SubStream : Stream
{
    readonly Stream _inner;
    readonly long _offset;
    readonly long _length;
    long _pos;

    public SubStream(Stream inner, long offset, long length)
    {
        _inner = inner;
        _offset = offset;
        _length = length;
    }

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => _length;
    public override long Position { get => _pos; set => Seek(value, SeekOrigin.Begin); }
    public override void Flush() { }

    public override int Read(byte[] buffer, int offset, int count)
    {
        var left = _length - _pos;
        if (left <= 0) return 0;
        if (count > left) count = (int)left;
        _inner.Seek(_offset + _pos, SeekOrigin.Begin);
        var n = _inner.Read(buffer, offset, count);
        _pos += n;
        return n;
    }

    public override long Seek(long off, SeekOrigin origin)
    {
        var p = origin switch
        {
            SeekOrigin.Begin => off,
            SeekOrigin.Current => _pos + off,
            _ => _length + off,
        };
        if (p < 0) throw new IOException("seek 到流之前");
        _pos = p;
        return _pos;
    }

    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing) _inner.Dispose();
        base.Dispose(disposing);
    }
}
