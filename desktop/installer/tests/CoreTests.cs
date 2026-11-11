using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Xunit;

namespace Weft.Setup.Tests;

static class H
{
    public static string Sha(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();

    public static string Tmp()
    {
        var d = Path.Combine(Path.GetTempPath(), "weft-setup-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(d);
        return d;
    }

    public static Manifest Make(string version, params (string path, string content)[] files)
    {
        var m = new Manifest { Version = version };
        foreach (var (p, c) in files)
        {
            var b = Encoding.UTF8.GetBytes(c);
            m.Files.Add(new ManifestFile { Path = p, Size = b.Length, Sha256 = Sha(b) });
        }
        return m;
    }

    /// <summary>内存里造一个载荷 zip。entries 里的内容可以和清单不一致，用来测校验失败。</summary>
    public static ZipArchive Zip(Manifest m, params (string path, string content)[] files)
    {
        var ms = new MemoryStream();
        using (var z = new ZipArchive(ms, ZipArchiveMode.Create, true))
        {
            foreach (var (p, c) in files)
            {
                var e = z.CreateEntry(p);
                using var s = e.Open();
                s.Write(Encoding.UTF8.GetBytes(c));
            }
        }
        ms.Position = 0;
        return new ZipArchive(ms, ZipArchiveMode.Read);
    }
}

public class ManifestTests
{
    [Fact]
    public void RoundTripAndNormalize()
    {
        var m = H.Make("1.0.0", ("app/a.mjs", "a"), ("node/node.exe", "n"));
        var m2 = Manifest.Parse(m.ToJson());
        Assert.Equal("1.0.0", m2.Version);
        Assert.Equal(2, m2.Files.Count);
        Assert.Equal(m.Files[0].Sha256, m2.Files[0].Sha256);
        Assert.Equal(2, m2.TotalSize);
    }

    [Theory]
    [InlineData("../evil")]
    [InlineData("/abs")]
    [InlineData("C:/x")]
    [InlineData("a/../b")]
    public void RejectsUnsafePaths(string p)
    {
        var json = $"{{\"version\":\"1\",\"files\":[{{\"path\":\"{p}\",\"size\":1,\"sha256\":\"aa\"}}]}}";
        Assert.Throws<InvalidDataException>(() => Manifest.Parse(json));
    }

    [Fact]
    public void RejectsDuplicates()
    {
        var json = "{\"version\":\"1\",\"files\":[{\"path\":\"a\",\"size\":1,\"sha256\":\"aa\"},{\"path\":\"A\",\"size\":1,\"sha256\":\"aa\"}]}";
        Assert.Throws<InvalidDataException>(() => Manifest.Parse(json));
    }
}

public class DiffTests
{
    [Fact]
    public void NoPrevWritesAll()
    {
        var n = H.Make("2", ("a", "1"), ("b", "22"));
        var d = ManifestDiff.Compute(null, n, _ => null);
        Assert.Equal(2, d.Write.Count);
        Assert.Empty(d.Unchanged);
        Assert.Empty(d.Remove);
        Assert.Equal(3, d.WriteBytes);
    }

    [Fact]
    public void SkipsSameHashRemovesGoneWritesChanged()
    {
        var p = H.Make("1", ("keep", "k"), ("change", "old"), ("gone", "g"));
        var n = H.Make("2", ("keep", "k"), ("change", "new!"), ("added", "x"));
        var d = ManifestDiff.Compute(p, n, rel => p.Files.First(f => f.Path == rel).Size);
        Assert.Equal(new[] { "keep" }, d.Unchanged.Select(f => f.Path));
        Assert.Equal(new[] { "change", "added" }, d.Write.Select(f => f.Path));
        Assert.Equal(new[] { "gone" }, d.Remove.Select(f => f.Path));
    }

    [Fact]
    public void MissingOrResizedOnDiskIsRewritten()
    {
        var p = H.Make("1", ("a", "aa"), ("b", "bb"));
        var d = ManifestDiff.Compute(p, p, rel => rel == "a" ? null : 99);
        Assert.Equal(2, d.Write.Count);
    }
}

public class PayloadTests
{
    [Fact]
    public void TrailerRoundTrip()
    {
        var sha = SHA256.HashData(new byte[] { 1 });
        var t = Payload.BuildTrailer(1000, 500, sha);
        Assert.Equal(Payload.TrailerSize, t.Length);
        var info = Payload.ParseTrailer(t, 1000 + 500 + Payload.TrailerSize)!;
        Assert.Equal(1000, info.Offset);
        Assert.Equal(500, info.Length);
        Assert.Equal(sha, info.Sha256);
        Assert.Null(Payload.ParseTrailer(t, 12345)); // 长度对不上
        t[50] ^= 1;
        Assert.Null(Payload.ParseTrailer(t, 1000 + 500 + Payload.TrailerSize)); // 标记损坏
    }

    static string MakeSetup(string dir, byte[] head, byte[] payload, bool tamper = false)
    {
        var path = Path.Combine(dir, "setup.exe");
        using var fs = File.Create(path);
        fs.Write(head);
        var p = (byte[])payload.Clone();
        var sha = SHA256.HashData(p);
        if (tamper) p[p.Length / 2] ^= 0xff;
        fs.Write(p);
        fs.Write(Payload.BuildTrailer(head.Length, p.Length, sha));
        return path;
    }

    [Fact]
    public void ReadVerifyAndSubStream()
    {
        var d = H.Tmp();
        var head = Encoding.ASCII.GetBytes("MZ-head-bytes");
        var payload = new byte[300_000];
        new Random(1).NextBytes(payload);
        var exe = MakeSetup(d, head, payload);
        var info = Payload.TryRead(exe)!;
        Assert.Equal(head.Length, info.Offset);
        Assert.Equal(payload.Length, info.Length);
        Payload.Verify(exe, info);
        using (var s = Payload.Open(exe, info))
        {
            Assert.Equal(payload.Length, s.Length);
            s.Seek(-10, SeekOrigin.End);
            var tail = new byte[20];
            Assert.Equal(10, s.Read(tail, 0, 20));
            Assert.Equal(payload[^10..], tail[..10]);
        }
        var copy = Path.Combine(d, "uninstall.exe");
        Payload.CopyHead(exe, info.Offset, copy);
        Assert.Equal(head, File.ReadAllBytes(copy));
        Assert.Null(Payload.TryRead(copy)); // 不带载荷的卸载程序
    }

    [Fact]
    public void VerifyDetectsTamper()
    {
        var d = H.Tmp();
        var exe = MakeSetup(d, new byte[] { 1, 2, 3 }, new byte[4096].Select((_, i) => (byte)i).ToArray(), tamper: true);
        var info = Payload.TryRead(exe)!;
        var ex = Assert.Throws<SetupException>(() => Payload.Verify(exe, info));
        Assert.Equal(FailKind.Payload, ex.Kind);
    }
}

public class DetectTests
{
    [Fact]
    public void RegistryWinsWhenWeftExePresent()
    {
        var d = InstallDetector.Detect(@"D:\Weft", p => p == @"D:\Weft", new[] { @"E:\Other\Weft.exe" }, @"C:\def");
        Assert.Equal(InstallMode.Upgrade, d.Mode);
        Assert.Equal(@"D:\Weft", d.Dir);
        Assert.Equal("registry", d.Source);
    }

    [Fact]
    public void RegistryWithoutExeFallsBackToRunningProcess()
    {
        // Windows 路径分隔符在 mac 上不被 Path 认，所以用不含目录分隔差异的写法
        var sep = Path.DirectorySeparatorChar;
        var dir = $"{sep}opt{sep}weft";
        var exe = $"{dir}{sep}Weft.exe";
        var d = InstallDetector.Detect("/gone", p => p == dir, new[] { exe }, "/default");
        Assert.Equal(InstallMode.Upgrade, d.Mode);
        Assert.Equal(dir, d.Dir);
        Assert.Equal("process", d.Source);
    }

    [Fact]
    public void NothingFoundIsFreshInstall()
    {
        var d = InstallDetector.Detect(null, _ => false, Array.Empty<string>(), "/default");
        Assert.Equal(InstallMode.Install, d.Mode);
        Assert.Equal("/default", d.Dir);
        var d2 = InstallDetector.Detect("  ", _ => false, new[] { "/x/Weft.exe" }, "/default");
        Assert.Equal(InstallMode.Install, d2.Mode);
    }

    [Fact]
    public void IsUnderIgnoresCaseAndPrefixTraps()
    {
        var sep = Path.DirectorySeparatorChar;
        var root = $"{sep}Apps{sep}Weft";
        Assert.True(PathUtil.IsUnder(root, $"{sep}apps{sep}weft{sep}node{sep}node.exe"));
        Assert.False(PathUtil.IsUnder(root, $"{sep}Apps{sep}Weft-other{sep}node.exe"));
        Assert.False(PathUtil.IsUnder(root, root));
    }

    [Fact]
    public void InstallDirRules()
    {
        Assert.False(PathUtil.IsAcceptableInstallDir(""));
        Assert.True(PathUtil.IsAcceptableInstallDir(Path.Combine(Path.GetTempPath(), "Weft")));
        Assert.False(PathUtil.IsAcceptableInstallDir(Path.GetPathRoot(Path.GetTempPath())!));
    }
}

public class CliTests
{
    [Fact]
    public void Silent()
    {
        var o = CliOptions.Parse(new[] { "/S" });
        Assert.True(o.Silent); Assert.False(o.Uninstall); Assert.Null(o.Dir); Assert.Null(o.Error);
    }

    [Fact]
    public void DirWithSpacesSplitByShell()
    {
        var o = CliOptions.Parse(new[] { "/S", @"/D=C:\Program Files\我的 Weft" });
        Assert.Equal(@"C:\Program Files\我的 Weft", o.Dir);
        var o2 = CliOptions.Parse(new[] { "/S", @"/D=C:\a", "b", "c" });
        Assert.Equal(@"C:\a b c", o2.Dir);
        Assert.True(o2.Silent);
    }

    [Fact]
    public void UninstallFlags()
    {
        var o = CliOptions.Parse(new[] { "/uninstall", "/s", "/DELETEDATA" });
        Assert.True(o.Uninstall && o.Silent && o.DeleteData);
        Assert.Equal("无法识别的参数: /x", CliOptions.Parse(new[] { "/x" }).Error);
    }
}

public class FileInstallerTests
{
    [Fact]
    public void FreshInstallThenUpgradeSkipsUnchanged()
    {
        var dir = Path.Combine(H.Tmp(), "Weft 中文");
        var files1 = new[] { ("Weft.exe", "exe1"), ("app/a.mjs", "aaa"), ("app/old.mjs", "old") };
        var m1 = H.Make("1", files1);
        var s1 = FileInstaller.Apply(H.Zip(m1, files1), m1, null, dir, null, default);
        Assert.Equal(3, s1.Written);
        Assert.Equal("aaa", File.ReadAllText(Path.Combine(dir, "app", "a.mjs")));
        Assert.True(File.Exists(Path.Combine(dir, Manifest.FileName)));

        var files2 = new[] { ("Weft.exe", "exe2!"), ("app/a.mjs", "aaa"), ("app/new/b.mjs", "bbb") };
        var m2 = H.Make("2", files2);
        var prev = Manifest.TryLoad(Path.Combine(dir, Manifest.FileName))!;
        var s2 = FileInstaller.Apply(H.Zip(m2, files2), m2, prev, dir, null, default);
        Assert.Equal(2, s2.Written);
        Assert.Equal(1, s2.Skipped);
        Assert.Equal(1, s2.Removed);
        Assert.Equal("exe2!", File.ReadAllText(Path.Combine(dir, "Weft.exe")));
        Assert.False(File.Exists(Path.Combine(dir, "app", "old.mjs")));
        Assert.Empty(Directory.GetFiles(dir, "*.weft-*", SearchOption.AllDirectories));
        Assert.Equal("2", Manifest.TryLoad(Path.Combine(dir, Manifest.FileName))!.Version);
        // 同一个包再装一次：全部跳过
        var prev2 = Manifest.TryLoad(Path.Combine(dir, Manifest.FileName))!;
        var s3 = FileInstaller.Apply(H.Zip(m2, files2), m2, prev2, dir, null, default);
        Assert.Equal(0, s3.Written);
        Assert.Equal(3, s3.Skipped);
    }

    [Fact]
    public void CorruptEntryRollsBackEverything()
    {
        var dir = Path.Combine(H.Tmp(), "Weft");
        var v1 = new[] { ("a", "a1"), ("b", "b1") };
        var m1 = H.Make("1", v1);
        FileInstaller.Apply(H.Zip(m1, v1), m1, null, dir, null, default);

        var m2 = H.Make("2", ("a", "a2"), ("b", "b2"), ("c", "c2"));
        // b 的内容和清单里的哈希对不上，c 之前就已经写了 a
        var zip = H.Zip(m2, ("a", "a2"), ("b", "BAD!"), ("c", "c2"));
        var prev = Manifest.TryLoad(Path.Combine(dir, Manifest.FileName))!;
        var ex = Assert.Throws<SetupException>(() => FileInstaller.Apply(zip, m2, prev, dir, null, default));
        Assert.Equal(FailKind.Payload, ex.Kind);
        Assert.Equal("a1", File.ReadAllText(Path.Combine(dir, "a")));
        Assert.Equal("b1", File.ReadAllText(Path.Combine(dir, "b")));
        Assert.False(File.Exists(Path.Combine(dir, "c")));
        Assert.Equal("1", Manifest.TryLoad(Path.Combine(dir, Manifest.FileName))!.Version);
        Assert.Empty(Directory.GetFiles(dir, "*.weft-*", SearchOption.AllDirectories));
    }

    [Fact]
    public void CancelRollsBack()
    {
        var dir = Path.Combine(H.Tmp(), "Weft");
        var v1 = new[] { ("a", "a1") };
        var m1 = H.Make("1", v1);
        FileInstaller.Apply(H.Zip(m1, v1), m1, null, dir, null, default);
        var v2 = new[] { ("a", "a2"), ("b", "b2") };
        var m2 = H.Make("2", v2);
        using var cts = new CancellationTokenSource();
        var n = 0;
        var ex = Assert.Throws<SetupException>(() => FileInstaller.Apply(H.Zip(m2, v2), m2,
            Manifest.TryLoad(Path.Combine(dir, Manifest.FileName)), dir, (_, _) => { if (++n == 1) cts.Cancel(); }, cts.Token));
        Assert.Equal(FailKind.Cancelled, ex.Kind);
        Assert.Equal("a1", File.ReadAllText(Path.Combine(dir, "a")));
        Assert.False(File.Exists(Path.Combine(dir, "b")));
    }

    [Fact]
    public void LockedTargetBecomesRunningError()
    {
        if (!OperatingSystem.IsWindows()) return; // 只有 Windows 上打开的文件才会挡住替换
        var dir = Path.Combine(H.Tmp(), "Weft");
        var v1 = new[] { ("a", "a1") };
        var m1 = H.Make("1", v1);
        FileInstaller.Apply(H.Zip(m1, v1), m1, null, dir, null, default);
        var v2 = new[] { ("a", "a2") };
        var m2 = H.Make("2", v2);
        using var held = new FileStream(Path.Combine(dir, "a"), FileMode.Open, FileAccess.Read, FileShare.Read);
        var ex = Assert.Throws<SetupException>(() => FileInstaller.Apply(H.Zip(m2, v2), m2,
            Manifest.TryLoad(Path.Combine(dir, Manifest.FileName)), dir, null, default));
        Assert.Equal(FailKind.Running, ex.Kind);
    }

    [Fact]
    public void RemoveInstalledKeepsForeignFiles()
    {
        var dir = Path.Combine(H.Tmp(), "shared");
        var v = new[] { ("app/a", "a"), ("b", "b") };
        var m = H.Make("1", v);
        FileInstaller.Apply(H.Zip(m, v), m, null, dir, null, default);
        File.WriteAllText(Path.Combine(dir, "mine.txt"), "keep me");
        var failed = FileInstaller.RemoveInstalled(dir, Manifest.TryLoad(Path.Combine(dir, Manifest.FileName)), null, default);
        Assert.Equal(0, failed);
        Assert.True(File.Exists(Path.Combine(dir, "mine.txt")));
        Assert.False(File.Exists(Path.Combine(dir, "b")));
        Assert.False(Directory.Exists(Path.Combine(dir, "app")));
        Assert.False(File.Exists(Path.Combine(dir, Manifest.FileName)));
    }
}

public class DiskTests
{
    [Fact]
    public void RequiredAndFormat()
    {
        Assert.Equal(100 + 10 + DiskSpace.Margin, DiskSpace.Required(100, 10));
        Assert.Equal("1 MB", DiskSpace.FormatMb(1));
        Assert.Equal("33 MB", DiskSpace.FormatMb((32L << 20) + 1));
    }
}

/// <summary>
/// 用 scripts/build-installer.mjs 生成的真 Setup 文件验证 node 和 C# 两边的载荷格式一致。
/// 设置环境变量 WEFT_TEST_SETUP_EXE 才跑，否则跳过。
/// </summary>
public class NodeInteropTests
{
    [Fact]
    public void ReadsSetupBuiltByNodeScript()
    {
        var exe = Environment.GetEnvironmentVariable("WEFT_TEST_SETUP_EXE");
        if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) return;
        var info = Payload.TryRead(exe) ?? throw new Exception("没有读到尾部标记");
        Payload.Verify(exe, info);
        using var s = Payload.Open(exe, info);
        using var zip = new ZipArchive(s, ZipArchiveMode.Read);
        var me = zip.GetEntry(Manifest.FileName)!;
        Manifest m;
        using (var es = me.Open()) m = Manifest.Parse(es);
        var dir = Path.Combine(H.Tmp(), "装 Weft");
        var st = FileInstaller.Apply(zip, m, null, dir, null, default);
        Assert.Equal(m.Files.Count, st.Written);
        var st2 = FileInstaller.Apply(zip, m, Manifest.TryLoad(Path.Combine(dir, Manifest.FileName)), dir, null, default);
        Assert.Equal(m.Files.Count, st2.Skipped);
        Assert.Equal(0, st2.Written);
    }

    [Fact]
    public void LogRingKeepsLast200AndSinceWorks()
    {
        Log.Path = Path.Combine(H.Tmp(), "t.log");
        Log.ResetRing();
        long seq = 0;
        for (var i = 0; i < 250; i++) Log.Write("line " + i);
        var all = Log.Snapshot(out var s2);
        Assert.Equal(200, all.Length);
        Assert.EndsWith("line 249", all[^1]);
        Assert.EndsWith("line 50", all[0]);
        Log.Write("more");
        var more = Log.Since(ref s2);
        Assert.Single(more);
        Assert.Empty(Log.Since(ref s2));
        Assert.Equal(200, Log.Since(ref seq).Length);
    }

    [Fact]
    public void RenderPreviewArgsParse()
    {
        var o = CliOptions.Parse(new[] { "--render-preview", "out", "--scale", "1,1.5", "--theme", "dark" });
        Assert.Null(o.Error);
        Assert.Equal("out", o.PreviewDir);
        Assert.Equal(new[] { 1.0, 1.5 }, o.PreviewScales);
        Assert.Equal("dark", o.PreviewTheme);

        var d = CliOptions.Parse(new[] { "--render-preview", "out" });
        Assert.Equal(new[] { 1.0, 1.25, 1.5, 1.75 }, d.PreviewScales);
        Assert.Null(d.PreviewTheme);

        Assert.NotNull(CliOptions.Parse(new[] { "--render-preview" }).Error);
        Assert.NotNull(CliOptions.Parse(new[] { "--render-preview", "o", "--scale", "abc" }).Error);
        Assert.NotNull(CliOptions.Parse(new[] { "--render-preview", "o", "--theme", "blue" }).Error);
    }
}
