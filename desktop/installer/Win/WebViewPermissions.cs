using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace Weft.Setup;

/// <summary>
/// 随包的 WebView2 固定版要求目录对 ALL APPLICATION PACKAGES / ALL RESTRICTED APPLICATION PACKAGES 可读可执行，
/// 否则 Windows 10 上渲染器沙箱起不来。和 Weft.exe 里的 EnsurePermissions 一致：安装时就补上，首次启动不用再跑 icacls。
/// </summary>
public static class WebViewPermissions
{
    static readonly string[] PackageSids = { "S-1-15-2-1", "S-1-15-2-2" };

    public static bool Ready(string dir)
    {
        try
        {
            var rules = new DirectoryInfo(dir).GetAccessControl().GetAccessRules(true, true, typeof(SecurityIdentifier));
            foreach (var sid in PackageSids)
            {
                var ok = false;
                foreach (FileSystemAccessRule r in rules)
                {
                    if (r.IdentityReference.Value != sid || r.AccessControlType != AccessControlType.Allow) continue;
                    if ((r.FileSystemRights & FileSystemRights.ReadAndExecute) == FileSystemRights.ReadAndExecute) { ok = true; break; }
                }
                if (!ok) return false;
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>失败只记日志，不让安装失败（Weft.exe 首次启动还会再试一次）。</summary>
    public static void Ensure(string installDir, CancellationToken ct)
    {
        var dir = Path.Combine(installDir, "webview2");
        if (!Directory.Exists(dir)) return;
        if (Ready(dir)) { Log.Write("webview2 权限已就绪"); return; }
        var sw = Stopwatch.StartNew();
        var errors = new StringBuilder();
        foreach (var sid in PackageSids)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "icacls.exe"))
                {
                    Arguments = $"\"{dir}\" /grant *{sid}:(OI)(CI)(RX) /T /C /Q",
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                };
                using var p = Process.Start(psi)!;
                var o = p.StandardOutput.ReadToEndAsync();
                var e = p.StandardError.ReadToEndAsync();
                if (!p.WaitForExit(180000)) { try { p.Kill(true); } catch { } errors.Append(sid + ": icacls 超时; "); }
                else if (p.ExitCode != 0) errors.Append($"{sid}: icacls exit {p.ExitCode} {o.Result.Trim()} {e.Result.Trim()}; ");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                errors.Append(sid + ": " + ex.Message + "; ");
            }
        }
        Log.Write($"webview2 权限 ready={Ready(dir)} 耗时 {sw.ElapsedMilliseconds} ms {errors}");
    }
}
