using System.IO.Compression;
using System.Security.Cryptography;

namespace Weft.Setup;

public sealed class ApplyStats
{
    public int Total, Written, Skipped, Removed;
    public long BytesWritten;
    public override string ToString() =>
        $"total={Total} written={Written} skipped={Skipped} removed={Removed} bytesWritten={BytesWritten}";
}

/// <summary>
/// 把载荷里有变化的文件写进安装目录：临时文件 + 替换；失败或取消时回滚已替换的文件。
/// 只用 System.IO，所以能在 mac / Linux 上跑单测。
/// </summary>
public static class FileInstaller
{
    public const long SlowMs = 5000;
    const string NewSuffix = ".weft-new";
    const string OldSuffix = ".weft-old";

    sealed class Op
    {
        public string Dest = "";
        public string? Backup;   // 被替换 / 被删除的旧文件
        public bool Created;     // 目标原本不存在
    }

    public static Dictionary<string, ZipArchiveEntry> IndexEntries(ZipArchive zip)
    {
        var map = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in zip.Entries)
        {
            if (e.FullName.EndsWith('/')) continue;
            map[e.FullName.Replace('\\', '/')] = e;
        }
        return map;
    }

    public static ApplyStats Apply(ZipArchive zip, Manifest next, Manifest? prev, string dir,
        Action<long, long>? bytes, CancellationToken ct, DiffResult? precomputed = null,
        Action<string, int, int>? onFile = null)
    {
        var entries = IndexEntries(zip);
        var diff = precomputed ?? ManifestDiff.Compute(prev, next, rel => DiskSize(dir, rel));
        var stats = new ApplyStats { Total = next.Files.Count, Skipped = diff.Unchanged.Count };
        var journal = new List<Op>();
        var totalBytes = Math.Max(1, diff.WriteBytes);
        long doneBytes = 0;
        try
        {
            Directory.CreateDirectory(dir);
            var fileNo = 0;
            foreach (var f in diff.Write)
            {
                ct.ThrowIfCancellationRequested();
                fileNo++;
                onFile?.Invoke(f.Path, fileNo, diff.Write.Count);
                Log.Write($"写入 {f.Path} ({f.Size} B) [{fileNo}/{diff.Write.Count}]");
                var swFile = System.Diagnostics.Stopwatch.StartNew();
                if (!entries.TryGetValue(f.Path, out var entry))
                    throw new SetupException(FailKind.Payload, "安装包缺少文件: " + f.Path);
                var dest = Path.Combine(dir, PathUtil.ToLocal(f.Path));
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                var tmp = dest + NewSuffix;
                try
                {
                    CopyVerified(entry, tmp, f, ct, n =>
                    {
                        doneBytes += n;
                        bytes?.Invoke(doneBytes, totalBytes);
                    });
                    Replace(tmp, dest, journal);
                }
                finally
                {
                    TryDelete(tmp);
                }
                stats.Written++;
                stats.BytesWritten += f.Size;
                var ms = swFile.ElapsedMilliseconds;
                Log.Write($"{(ms > SlowMs ? "SLOW " : "")}写入完成 {f.Path} {ms} ms");
            }

            foreach (var f in diff.Remove)
            {
                ct.ThrowIfCancellationRequested();
                var dest = Path.Combine(dir, PathUtil.ToLocal(f.Path));
                if (!File.Exists(dest)) continue;
                var backup = dest + OldSuffix;
                TryDelete(backup);
                ClearReadOnly(dest);
                File.Move(dest, backup);
                journal.Add(new Op { Dest = dest, Backup = backup });
                stats.Removed++;
            }

            // 清单最后写：中途失败时目录里还是旧清单
            ct.ThrowIfCancellationRequested();
            var manifestDest = Path.Combine(dir, Manifest.FileName);
            var manifestTmp = manifestDest + NewSuffix;
            try
            {
                File.WriteAllText(manifestTmp, next.ToJson());
                Replace(manifestTmp, manifestDest, journal);
            }
            finally
            {
                TryDelete(manifestTmp);
            }
        }
        catch (Exception e)
        {
            Rollback(journal);
            throw Wrap(e);
        }

        foreach (var op in journal)
            if (op.Backup != null) TryDelete(op.Backup);
        foreach (var f in diff.Remove) TryRemoveEmptyParents(dir, Path.Combine(dir, PathUtil.ToLocal(f.Path)));
        return stats;
    }

    public static Exception Wrap(Exception e)
    {
        if (e is SetupException) return e;
        if (e is OperationCanceledException) return new SetupException(FailKind.Cancelled, "已取消", 0, e);
        if (SetupException.IsDiskFull(e)) return new SetupException(FailKind.Disk, "磁盘空间不足", 0, e);
        if (e is IOException or UnauthorizedAccessException)
            return new SetupException(FailKind.Running, "文件被占用或没有写入权限: " + e.Message, 0, e);
        return new SetupException(FailKind.Other, e.Message, 0, e);
    }

    static void CopyVerified(ZipArchiveEntry entry, string tmp, ManifestFile f, CancellationToken ct, Action<int> onBytes)
    {
        using var h = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long total = 0;
        using (var src = entry.Open())
        using (var dst = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
        {
            var buf = new byte[1 << 17];
            int n;
            while ((n = src.Read(buf, 0, buf.Length)) > 0)
            {
                ct.ThrowIfCancellationRequested();
                dst.Write(buf, 0, n);
                h.AppendData(buf, 0, n);
                total += n;
                onBytes(n);
            }
        }
        var hex = Convert.ToHexString(h.GetHashAndReset()).ToLowerInvariant();
        if (total != f.Size || hex != f.Sha256)
            throw new SetupException(FailKind.Payload, "安装包内文件校验失败: " + f.Path);
    }

    static void Replace(string tmp, string dest, List<Op> journal)
    {
        if (File.Exists(dest))
        {
            var backup = dest + OldSuffix;
            TryDelete(backup);
            ClearReadOnly(dest);
            File.Replace(tmp, dest, backup);
            journal.Add(new Op { Dest = dest, Backup = backup });
        }
        else
        {
            File.Move(tmp, dest);
            journal.Add(new Op { Dest = dest, Created = true });
        }
    }

    static void Rollback(List<Op> journal)
    {
        for (var i = journal.Count - 1; i >= 0; i--)
        {
            var op = journal[i];
            try
            {
                if (op.Backup != null && File.Exists(op.Backup))
                {
                    TryDelete(op.Dest);
                    File.Move(op.Backup, op.Dest);
                }
                else if (op.Created)
                {
                    TryDelete(op.Dest);
                }
            }
            catch (Exception e)
            {
                Log.Write("回滚失败 " + op.Dest + ": " + e.Message);
            }
        }
    }

    public static long? DiskSize(string dir, string rel)
    {
        try
        {
            var fi = new FileInfo(Path.Combine(dir, PathUtil.ToLocal(rel)));
            return fi.Exists ? fi.Length : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 卸载：按清单删文件，再删清单和空目录。不递归删整个目录，装在别人的文件夹里也不会误删别的东西。
    /// 返回没删掉的文件数。
    /// </summary>
    public static int RemoveInstalled(string dir, Manifest? manifest, Action<int, int>? progress, CancellationToken ct)
    {
        var failed = 0;
        var list = manifest?.Files ?? new List<ManifestFile>();
        for (var i = 0; i < list.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var p = Path.Combine(dir, PathUtil.ToLocal(list[i].Path));
            if (!TryDeleteStrict(p)) failed++;
            progress?.Invoke(i + 1, list.Count);
        }
        if (!TryDeleteStrict(Path.Combine(dir, Manifest.FileName))) failed++;
        if (Directory.Exists(dir))
        {
            foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                if (f.EndsWith(NewSuffix, StringComparison.OrdinalIgnoreCase) || f.EndsWith(OldSuffix, StringComparison.OrdinalIgnoreCase))
                    TryDelete(f);
            RemoveEmptyDirs(dir, keepRoot: true);
        }
        return failed;
    }

    static bool TryDeleteStrict(string p)
    {
        try
        {
            if (!File.Exists(p)) return true;
            ClearReadOnly(p);
            File.Delete(p);
            return true;
        }
        catch (Exception e)
        {
            Log.Write("删除失败 " + p + ": " + e.Message);
            return false;
        }
    }

    public static void RemoveEmptyDirs(string dir, bool keepRoot)
    {
        try
        {
            foreach (var sub in Directory.GetDirectories(dir)) RemoveEmptyDirs(sub, false);
            if (!keepRoot && !Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir);
        }
        catch
        {
            // 占用或权限问题，留着
        }
    }

    static void TryRemoveEmptyParents(string root, string file)
    {
        try
        {
            var d = Path.GetDirectoryName(file);
            while (!string.IsNullOrEmpty(d) && PathUtil.IsUnder(root, d) && !Directory.EnumerateFileSystemEntries(d).Any())
            {
                Directory.Delete(d);
                d = Path.GetDirectoryName(d);
            }
        }
        catch
        {
        }
    }

    static void ClearReadOnly(string p)
    {
        try { File.SetAttributes(p, FileAttributes.Normal); } catch { }
    }

    static void TryDelete(string p)
    {
        try { if (File.Exists(p)) File.Delete(p); } catch { }
    }
}
