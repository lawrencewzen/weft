using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Weft.Setup;

/// <summary>找出并停止属于安装目录的 Weft 进程：先 Weft.exe --quit，再 Weft-stop.cmd 和关窗口，超时才结束。</summary>
public static class ProcessStopper
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder buf, ref int size);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    public static string? ImagePath(int pid)
    {
        var h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            var sb = new StringBuilder(1024);
            var size = sb.Capacity;
            return QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString(0, size) : null;
        }
        finally
        {
            CloseHandle(h);
        }
    }

    /// <summary>当前正在运行的 Weft.exe 的完整路径。</summary>
    public static List<string> RunningWeftExePaths()
    {
        var res = new List<string>();
        foreach (var p in Process.GetProcessesByName("Weft"))
        {
            using (p)
            {
                if (p.Id == Environment.ProcessId) continue;
                var path = ImagePath(p.Id);
                if (path != null && string.Equals(Path.GetFileName(path), "Weft.exe", StringComparison.OrdinalIgnoreCase))
                    res.Add(path);
            }
        }
        return res;
    }

    /// <summary>位于 dir 之内的所有进程（Weft.exe、node.exe、WebView2 子进程等），不含自己。</summary>
    public static List<Process> FindInDir(string dir)
    {
        var res = new List<Process>();
        var self = Environment.ProcessPath;
        foreach (var p in Process.GetProcesses())
        {
            var keep = false;
            try
            {
                if (p.Id == Environment.ProcessId) continue;
                var path = ImagePath(p.Id);
                if (path == null) continue;
                if (self != null && string.Equals(path, self, StringComparison.OrdinalIgnoreCase)) continue;
                keep = PathUtil.IsUnder(dir, path);
            }
            catch
            {
            }
            if (keep) res.Add(p); else p.Dispose();
        }
        return res;
    }

    public static bool AnyRunning(string dir)
    {
        var l = FindInDir(dir);
        try { return l.Count > 0; }
        finally { foreach (var p in l) p.Dispose(); }
    }

    /// <summary>停不掉抛 SetupException(Running)。顺序：Weft.exe --quit（正常退出）→ stop 脚本 → 关窗口 → 结束进程。</summary>
    public static void StopAll(string dir, CancellationToken ct)
    {
        if (!AnyRunning(dir)) return;
        var total = Stopwatch.StartNew();
        var step = Stopwatch.StartNew();
        Log.Write("停止 Weft: " + dir);

        // 1. 让桌面壳自己退出（停服务、收托盘）；旧版 Weft.exe 不认识 --quit，直接跳过
        if (RequestShellQuit(dir, ct))
        {
            Log.Write($"Weft.exe --quit 已发出 ({step.ElapsedMilliseconds} ms)");
            var gone = WaitGone(dir, 8000, ct);
            Log.Write($"等待正常退出：{(gone ? "完成" : "未退出")} ({step.ElapsedMilliseconds} ms)");
            if (gone)
            {
                Log.Write($"停止完成，共 {total.ElapsedMilliseconds} ms");
                return;
            }
        }
        else Log.Write("未使用 --quit（没有运行中的 Weft.exe，或版本过旧），走兜底流程");

        // 2. 兜底：stop 脚本
        step.Restart();
        RunStopScript(dir, ct);
        var ok = WaitGone(dir, 4000, ct);
        Log.Write($"stop 脚本阶段：{(ok ? "完成" : "仍有进程")} ({step.ElapsedMilliseconds} ms)");
        if (ok)
        {
            Log.Write($"停止完成，共 {total.ElapsedMilliseconds} ms");
            return;
        }

        // 3. 正常关闭：给有窗口的进程发关闭消息
        step.Restart();
        foreach (var p in FindInDir(dir))
        {
            try { if (p.MainWindowHandle != IntPtr.Zero) p.CloseMainWindow(); } catch { }
            p.Dispose();
        }
        ok = WaitGone(dir, 8000, ct);
        Log.Write($"关闭窗口阶段：{(ok ? "完成" : "仍有进程")} ({step.ElapsedMilliseconds} ms)");
        if (ok)
        {
            Log.Write($"停止完成，共 {total.ElapsedMilliseconds} ms");
            return;
        }

        // 4. 超时，才结束
        Log.Write("正常关闭超时，结束残留进程");
        foreach (var p in FindInDir(dir))
        {
            try { p.Kill(false); Log.Write($"kill {p.ProcessName} {p.Id}"); }
            catch (Exception e) { Log.Write($"kill 失败 {p.Id}: {e.Message}"); }
            p.Dispose();
        }
        if (WaitGone(dir, 6000, ct))
        {
            Log.Write($"停止完成（强制），共 {total.ElapsedMilliseconds} ms");
            return;
        }
        throw new SetupException(FailKind.Running, "Weft 仍在运行，无法停止");
    }

    /// <summary>安装目录里有运行中的新版 Weft.exe 时，调用它的 --quit。返回是否发出。</summary>
    static bool RequestShellQuit(string dir, CancellationToken ct)
    {
        try
        {
            var exe = Path.Combine(dir, "Weft.exe");
            if (!File.Exists(exe)) return false;
            var running = false;
            foreach (var p in Process.GetProcessesByName("Weft"))
            {
                using (p)
                {
                    var path = p.Id == Environment.ProcessId ? null : ImagePath(p.Id);
                    if (path != null && PathUtil.IsUnder(dir, path)) running = true;
                }
            }
            if (!running || !SupportsQuit(exe)) return false;
            var psi = new ProcessStartInfo(exe) { Arguments = "--quit", UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = dir };
            using var proc = Process.Start(psi);
            if (proc == null) return false;
            var until = Environment.TickCount64 + 5000;
            while (!proc.HasExited)
            {
                ct.ThrowIfCancellationRequested();
                if (Environment.TickCount64 >= until) { try { proc.Kill(); } catch { } break; }
                Thread.Sleep(50);
            }
            return true;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception e)
        {
            Log.Write("Weft.exe --quit 失败: " + e.Message);
            return false;
        }
    }

    // 新版 Weft.exe 的 #US 堆里有这个事件名（UTF-16）；旧版没有，说明不认识 --quit。
    static bool SupportsQuit(string exe)
    {
        var needle = Encoding.Unicode.GetBytes(@"Local\Weft.Desktop.Quit");
        var data = File.ReadAllBytes(exe);
        for (int i = 0; i + needle.Length <= data.Length; i++)
        {
            if (data[i] != needle[0]) continue;
            var j = 1;
            while (j < needle.Length && data[i + j] == needle[j]) j++;
            if (j == needle.Length) return true;
        }
        return false;
    }

    static bool WaitGone(string dir, int ms, CancellationToken ct)
    {
        var until = Environment.TickCount64 + ms;
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            if (!AnyRunning(dir)) return true;
            if (Environment.TickCount64 >= until) return false;
            Thread.Sleep(200);
        }
    }

    static void RunStopScript(string dir, CancellationToken ct)
    {
        try
        {
            var cmd = Path.Combine(dir, "Weft-stop.cmd");
            var node = Path.Combine(dir, "node", "node.exe");
            var cli = Path.Combine(dir, "app", "bin", "weft.mjs");
            ProcessStartInfo psi;
            if (File.Exists(cmd))
            {
                psi = new ProcessStartInfo("cmd.exe") { Arguments = $"/d /s /c \"\"{cmd}\"\"" };
            }
            else if (File.Exists(node) && File.Exists(cli))
            {
                psi = new ProcessStartInfo(node) { Arguments = $"\"{cli}\" stop" };
            }
            else return;
            psi.WorkingDirectory = dir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            // 脚本失败时会 pause 等按键，CI 变量让它直接退出
            psi.Environment["CI"] = "1";
            using var proc = Process.Start(psi);
            if (proc == null) return;
            var until = Environment.TickCount64 + 20000;
            while (!proc.HasExited)
            {
                ct.ThrowIfCancellationRequested();
                if (Environment.TickCount64 >= until)
                {
                    try { proc.Kill(true); } catch { }
                    break;
                }
                Thread.Sleep(100);
            }
            Log.Write("stop 脚本退出码 " + (proc.HasExited ? proc.ExitCode.ToString() : "超时"));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception e) when (e is Win32Exception or InvalidOperationException)
        {
            Log.Write("运行 stop 脚本失败: " + e.Message);
        }
    }
}
