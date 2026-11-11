using System.Diagnostics;
using System.IO.Compression;

namespace Weft.Setup;

public sealed class SetupContext
{
    public InstallMode Mode;
    public string Dir = "";
    public string? OldVersion;
    public string NewVersion = "";
    public bool DesktopShortcut;
    public bool DeleteData;
    public string ExePath = Environment.ProcessPath ?? "";
    public PayloadInfo? Payload;
}

public delegate void ProgressFn(string step, double pct);

public static class Engine
{
    public const string PayloadManifestEntry = Manifest.FileName;

    public static string StartMenuLnk => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Weft.lnk");
    public static string DesktopLnk => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Weft.lnk");
    public static string DefaultDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Weft");

    static string Join(string a, string b) => Path.Combine(a, b);

    public static Manifest ReadPayloadManifest(string exePath, PayloadInfo info)
    {
        using var s = Payload.Open(exePath, info);
        using var zip = new ZipArchive(s, ZipArchiveMode.Read);
        var e = zip.GetEntry(PayloadManifestEntry) ?? throw new SetupException(FailKind.Payload, "安装包缺少 " + PayloadManifestEntry);
        using var es = e.Open();
        try { return Manifest.Parse(es); }
        catch (Exception ex) when (ex is not SetupException) { throw new SetupException(FailKind.Payload, "安装包清单无效: " + ex.Message, 0, ex); }
    }

    // ---- 安装 / 升级 ----

    public static ApplyStats Install(SetupContext c, ProgressFn report, CancellationToken ct)
    {
        try
        {
            return InstallCore(c, report, ct);
        }
        catch (Exception e)
        {
            var w = FileInstaller.Wrap(e);
            Log.Write($"安装失败 kind={((SetupException)w).Kind}: {e}");
            throw w;
        }
    }

    static ApplyStats InstallCore(SetupContext c, ProgressFn report, CancellationToken ct)
    {
        var info = c.Payload ?? throw new SetupException(FailKind.Payload, "这个文件里没有安装包");
        var upgrade = c.Mode == InstallMode.Upgrade;
        var dir = PathUtil.Norm(c.Dir);
        if (!PathUtil.IsAcceptableInstallDir(dir)) throw new SetupException(FailKind.Other, "安装位置无效: " + dir);
        Log.Write($"开始{(upgrade ? "升级" : "安装")} {c.NewVersion} -> {dir}（旧版本 {c.OldVersion ?? "无"}）");

        // 阶段边界
        double verifyEnd = upgrade ? 4 : 6, stopEnd = upgrade ? 15 : 6, copyEnd = upgrade ? 70 : 60, envEnd = upgrade ? 92 : 90;
        var lnkLabel = upgrade ? "正在更新快捷方式" : "正在创建快捷方式";

        report("正在校验安装包", 0);
        var swVerify = Stopwatch.StartNew();
        Payload.Verify(c.ExePath, info, p => report("正在校验安装包", p * verifyEnd), ct);
        Log.Write($"载荷校验通过 bytes={info.Length} 耗时 {swVerify.ElapsedMilliseconds} ms");

        using var stream = Payload.Open(c.ExePath, info);
        using var zip = new ZipArchive(stream, ZipArchiveMode.Read);
        var me = zip.GetEntry(PayloadManifestEntry) ?? throw new SetupException(FailKind.Payload, "安装包缺少清单");
        Manifest next;
        using (var ms = me.Open()) next = Manifest.Parse(ms);
        var prev = Manifest.TryLoad(Join(dir, Manifest.FileName));
        var diff = ManifestDiff.Compute(prev, next, rel => FileInstaller.DiskSize(dir, rel));

        CheckDisk(dir, diff);

        if (Directory.Exists(dir))
        {
            report("正在停止 Weft", verifyEnd);
            ProcessStopper.StopAll(dir, ct);
        }
        report(upgrade ? "正在复制文件" : "正在复制文件", stopEnd);

        var swApply = Stopwatch.StartNew();
        var stats = FileInstaller.Apply(zip, next, prev, dir, (done, total) =>
            report("正在复制文件", stopEnd + (copyEnd - stopEnd) * done / total), ct, diff);
        Log.Write($"文件写入完成 {stats} 耗时 {swApply.ElapsedMilliseconds} ms");

        report("正在准备运行环境", copyEnd);
        WebViewPermissions.Ensure(dir, ct);
        WriteUninstaller(c, dir, info);
        Registration.Write(dir, next.Version, next.TotalSize);
        report("正在准备运行环境", envEnd);

        report(lnkLabel, envEnd);
        var weftExe = Join(dir, "Weft.exe");
        TryLink(StartMenuLnk, weftExe, dir);
        if (c.DesktopShortcut) TryLink(DesktopLnk, weftExe, dir);
        report(lnkLabel, 100);
        Log.Write("完成 " + stats);
        return stats;
    }

    static void CheckDisk(string dir, DiffResult diff)
    {
        long largest = diff.Write.Count == 0 ? 0 : diff.Write.Max(f => f.Size);
        var need = DiskSpace.Required(diff.WriteBytes, largest);
        try
        {
            var root = Path.GetPathRoot(dir);
            if (string.IsNullOrEmpty(root) || root.StartsWith(@"\\")) return;
            var free = new DriveInfo(root).AvailableFreeSpace;
            Log.Write($"磁盘：需要 {need}，可用 {free}");
            if (free < need) throw new SetupException(FailKind.Disk, "磁盘空间不足", need);
        }
        catch (SetupException)
        {
            throw;
        }
        catch (Exception e)
        {
            Log.Write("磁盘空间检查跳过: " + e.Message);
        }
    }

    static void WriteUninstaller(SetupContext c, string dir, PayloadInfo info)
    {
        var dest = Join(dir, "uninstall.exe");
        var tmp = dest + ".weft-new";
        try
        {
            Payload.CopyHead(c.ExePath, info.Offset, tmp);
            File.Move(tmp, dest, true);
        }
        catch
        {
            try { File.Delete(tmp); } catch { }
            throw;
        }
    }

    static void TryLink(string lnk, string target, string dir)
    {
        try { ShellLink.Create(lnk, target, dir, "Weft"); Log.Write("快捷方式 " + lnk); }
        catch (Exception e) { Log.Write("快捷方式失败（忽略）" + lnk + ": " + e.Message); }
    }

    // ---- 卸载 ----

    public static void Uninstall(SetupContext c, ProgressFn report, CancellationToken ct)
    {
        try
        {
            UninstallCore(c, report, ct);
        }
        catch (Exception e)
        {
            var w = FileInstaller.Wrap(e);
            Log.Write($"卸载失败 kind={((SetupException)w).Kind}: {e}");
            throw w;
        }
    }

    static void UninstallCore(SetupContext c, ProgressFn report, CancellationToken ct)
    {
        var dir = PathUtil.Norm(c.Dir);
        Log.Write($"开始卸载 {dir} deleteData={c.DeleteData}");
        report("正在停止 Weft", 0);
        if (Directory.Exists(dir)) ProcessStopper.StopAll(dir, ct);

        report("正在删除文件", 15);
        var manifest = Manifest.TryLoad(Join(dir, Manifest.FileName));
        var failed = Directory.Exists(dir)
            ? FileInstaller.RemoveInstalled(dir, manifest, (i, n) => report("正在删除文件", 15 + 55.0 * i / Math.Max(1, n)), ct)
            : 0;
        if (failed > 0) throw new SetupException(FailKind.Running, $"{failed} 个文件被占用，无法删除");

        report("正在移除快捷方式", 70);
        var self = Environment.ProcessPath;
        var uninst = Join(dir, "uninstall.exe");
        var selfInside = self != null && string.Equals(Path.GetFullPath(self), Path.GetFullPath(uninst), StringComparison.OrdinalIgnoreCase);
        if (!selfInside)
        {
            try { if (File.Exists(uninst)) File.Delete(uninst); } catch (Exception e) { Log.Write("删除 uninstall.exe 失败: " + e.Message); }
        }
        foreach (var l in new[] { StartMenuLnk, DesktopLnk })
        {
            try { if (File.Exists(l)) File.Delete(l); } catch (Exception e) { Log.Write("删除快捷方式失败 " + l + ": " + e.Message); }
        }
        report("正在移除快捷方式", 82);
        Registration.Remove();

        if (c.DeleteData)
        {
            foreach (var root in new[] { Environment.SpecialFolder.ApplicationData, Environment.SpecialFolder.LocalApplicationData })
            {
                var d = Join(Environment.GetFolderPath(root), "Weft");
                try { if (Directory.Exists(d)) { Directory.Delete(d, true); Log.Write("已删除数据 " + d); } }
                catch (Exception e) { Log.Write("删除数据失败 " + d + ": " + e.Message); }
            }
        }
        report("正在移除快捷方式", 95);

        if (selfInside) _pendingSelfDelete = (self!, dir);
        else
        {
            FileInstaller.RemoveEmptyDirs(dir, keepRoot: true);
            try { if (Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir); } catch { }
        }
        report("正在移除快捷方式", 100);
        Log.Write("卸载完成");
    }

    static (string Exe, string Dir)? _pendingSelfDelete;

    /// <summary>
    /// 自己（uninstall.exe）在安装目录里，运行中删不掉。进程退出前（Main 末尾）起一个延时的 cmd，
    /// 等本进程退出后删 exe 和空目录。放在退出前而不是卸载完成时，界面上停留多久都不影响。
    /// </summary>
    public static void RunPendingSelfDelete()
    {
        if (_pendingSelfDelete == null) return;
        var (exe, dir) = _pendingSelfDelete.Value;
        _pendingSelfDelete = null;
        try
        {
            var psi = new ProcessStartInfo("cmd.exe")
            {
                Arguments = $"/d /s /c \"ping -n 3 127.0.0.1 >nul & del /f /q \"{exe}\" & rmdir \"{dir}\"\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            Process.Start(psi)?.Dispose();
            Log.Write("已安排延时删除 " + exe);
        }
        catch (Exception e)
        {
            Log.Write("延时删除失败: " + e.Message);
        }
    }

    // ---- 启动前的判断 ----

    public static SetupContext? BuildContext(CliOptions cli, out string? fatal)
    {
        fatal = null;
        var exe = Environment.ProcessPath ?? "";
        PayloadInfo? payload = null;
        try { payload = Payload.TryRead(exe); } catch (Exception e) { Log.Write("读取载荷失败: " + e.Message); }
        var reg = Registration.Read();
        var selfName = Path.GetFileName(exe);
        var isUninstaller = payload == null && string.Equals(selfName, "uninstall.exe", StringComparison.OrdinalIgnoreCase);

        if (cli.Uninstall || isUninstaller)
        {
            string? dir = cli.Dir;
            if (dir == null && isUninstaller)
            {
                var d = Path.GetDirectoryName(exe);
                if (d != null && File.Exists(Join(d, "Weft.exe"))) dir = d;
            }
            dir ??= reg.Location;
            if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
            {
                fatal = "没有找到已安装的 Weft。";
                return null;
            }
            var m = Manifest.TryLoad(Join(dir, Manifest.FileName));
            return new SetupContext
            {
                Mode = InstallMode.Uninstall, Dir = dir, OldVersion = m?.Version ?? reg.Version ?? "", ExePath = exe,
                DeleteData = cli.DeleteData,
            };
        }

        if (payload == null)
        {
            fatal = "这个文件里没有安装包，请使用完整的 Weft-Setup 安装程序。";
            return null;
        }
        Manifest next;
        try { next = ReadPayloadManifest(exe, payload); }
        catch (Exception e) { fatal = "安装包已损坏：" + e.Message; return null; }

        var det = cli.Dir != null
            ? new Detection(File.Exists(Join(cli.Dir, "Weft.exe")) ? InstallMode.Upgrade : InstallMode.Install, cli.Dir, "cli")
            : InstallDetector.Detect(reg.Location, d => File.Exists(Join(d, "Weft.exe")), ProcessStopper.RunningWeftExePaths(), DefaultDir);
        Log.Write($"识别：{det.Mode} {det.Dir}（{det.Source}）");

        string? old = null;
        if (det.Mode == InstallMode.Upgrade)
            old = Manifest.TryLoad(Join(det.Dir, Manifest.FileName))?.Version ?? reg.Version ?? "旧版本";
        return new SetupContext
        {
            Mode = det.Mode, Dir = det.Dir, OldVersion = old, NewVersion = next.Version, ExePath = exe, Payload = payload,
            DesktopShortcut = det.Mode == InstallMode.Upgrade ? File.Exists(DesktopLnk) : !cli.NoDesktop,
        };
    }
}
