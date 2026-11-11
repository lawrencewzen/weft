using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Weft.Desktop
{
    // The one code path that starts and stops the Weft service. MainForm (normal start) and
    // `Weft.exe --service-check` both go through it, so CI exercises what users run.
    internal static class ServiceRunner
    {
        public static readonly Regex LoginUrl = new Regex(@"http://127\.0\.0\.1:\d+/auth\?code=\S+", RegexOptions.Compiled);
        public static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(60);
        public const int StopTimeoutMs = 20000;

        // %APPDATA%. Honours the APPDATA variable first (CI points it at a temp dir; the known-folder API ignores it).
        public static string AppDataRoot()
        {
            string v = Environment.GetEnvironmentVariable("APPDATA");
            if (!string.IsNullOrWhiteSpace(v)) return v;
            return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        }

        public static string DefaultDataDir() { return Path.Combine(AppDataRoot(), "Weft"); }

        // psi.EnvironmentVariables[...] / psi.Environment[...] throw KeyNotFoundException on a missing key under .NET 8
        // (.NET Framework returned null), so always go through TryGetValue.
        public static void ApplyDataDir(ProcessStartInfo psi)
        {
            string cur;
            if (!psi.Environment.TryGetValue("WEFT_DATA_DIR", out cur) || string.IsNullOrWhiteSpace(cur))
                psi.Environment["WEFT_DATA_DIR"] = DefaultDataDir();
        }

        public static ProcessStartInfo NewNodePsi(string baseDir, string cliArgs)
        {
            string node = Path.Combine(baseDir, "node", "node.exe");
            string cli = Path.Combine(baseDir, "app", "bin", "weft.mjs");
            var psi = new ProcessStartInfo(node)
            {
                Arguments = "\"" + cli + "\" " + cliArgs,
                WorkingDirectory = baseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            ApplyDataDir(psi);
            return psi;
        }

        public static bool HasRuntime(string baseDir)
        {
            return File.Exists(Path.Combine(baseDir, "node", "node.exe")) && File.Exists(Path.Combine(baseDir, "app", "bin", "weft.mjs"));
        }

        public static Process StartCollecting(ProcessStartInfo psi, List<string> lines)
        {
            var p = new Process { StartInfo = psi };
            DataReceivedEventHandler collect = (o, a) => { if (a.Data != null) lock (lines) lines.Add(a.Data); };
            p.OutputDataReceived += collect;
            p.ErrorDataReceived += collect;
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return p;
        }

        public static string FindUrl(List<string> lines)
        {
            lock (lines)
            {
                for (int i = lines.Count - 1; i >= 0; i--)
                {
                    var m = LoginUrl.Match(lines[i]);
                    if (m.Success) return m.Value;
                }
            }
            return null;
        }

        /// Starts `weft open --print` and waits for the login URL. Returns null on failure/timeout/cancel (reason in lines).
        public static string Launch(string baseDir, List<string> lines, Action<Process> onStarted, Func<bool> cancelled)
        {
            var p = StartCollecting(NewNodePsi(baseDir, "open --print"), lines);
            if (onStarted != null) onStarted(p);
            var deadline = DateTime.UtcNow + StartTimeout;
            while (DateTime.UtcNow < deadline)
            {
                if (cancelled()) return null;
                string hit = FindUrl(lines);
                if (hit != null) return cancelled() ? null : hit;
                if (p.HasExited)
                {
                    Thread.Sleep(300); // let the last output lines arrive
                    hit = FindUrl(lines);
                    if (hit != null) return cancelled() ? null : hit;
                    lock (lines) lines.Add("(open --print 已退出，退出码 " + p.ExitCode + "，没有登录地址)");
                    return null;
                }
                Thread.Sleep(100);
            }
            if (cancelled()) return null;
            if (!p.HasExited)
            {
                try { p.Kill(); } catch { }
                lock (lines) lines.Add("(等待 " + (int)StartTimeout.TotalSeconds + " 秒仍无结果，已超时)");
            }
            return null;
        }

        /// `node app\bin\weft.mjs stop`. Exit 0 means the service is gone (also when nothing was installed to start).
        public static int Stop(string baseDir, out string detail)
        {
            detail = "";
            if (!HasRuntime(baseDir)) return 0;
            var lines = new List<string>();
            var p = StartCollecting(NewNodePsi(baseDir, "stop"), lines);
            if (!p.WaitForExit(StopTimeoutMs))
            {
                try { p.Kill(); } catch { }
                detail = "停止服务超时";
                return 1;
            }
            p.WaitForExit();
            string text;
            lock (lines) text = string.Join("\n", lines.GetRange(0, Math.Min(5, lines.Count)));
            if (text.Length > 500) text = text.Substring(0, 500);
            detail = text;
            return p.ExitCode;
        }
    }

    // `Weft.exe --service-check [--out file]`: no window. Runs the real start path (ApplyDataDir, node, weft open --print),
    // waits until the service answers, then stops it the normal way. Exit 0 only if every step passed.
    internal static class ServiceCheck
    {
        public static int Run(string[] args)
        {
            string outFile = null;
            for (int i = 1; i < args.Length - 1; i++) if (args[i] == "--out") outFile = args[i + 1];
            var sb = new StringBuilder();
            var total = Stopwatch.StartNew();
            Action<string> log = s => sb.AppendLine("[" + total.ElapsedMilliseconds.ToString().PadLeft(6) + " ms] " + s);
            int code = 0;
            bool started = false;
            string dir = AppContext.BaseDirectory;
            try
            {
                string inherited = Environment.GetEnvironmentVariable("WEFT_DATA_DIR");
                log("inherited WEFT_DATA_DIR: " + (string.IsNullOrWhiteSpace(inherited) ? "(unset)" : inherited));
                var probe = new ProcessStartInfo("node.exe");
                ServiceRunner.ApplyDataDir(probe);
                log("effective WEFT_DATA_DIR: " + probe.Environment["WEFT_DATA_DIR"]);
                log("base dir: " + dir);
                if (!ServiceRunner.HasRuntime(dir)) throw new InvalidOperationException("missing node\\node.exe or app\\bin\\weft.mjs");
                log("node + cli found");

                var lines = new List<string>();
                var step = Stopwatch.StartNew();
                started = true;
                string url = ServiceRunner.Launch(dir, lines, null, () => false);
                lock (lines) foreach (var l in lines) log("open> " + l);
                if (url == null) throw new InvalidOperationException("service did not report a login url");
                log("login url ready in " + step.ElapsedMilliseconds + " ms");

                step.Restart();
                string home = Regex.Replace(url, @"/auth\?code=.*$", "/");
                using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) })
                {
                    var resp = http.GetAsync(home).GetAwaiter().GetResult();
                    string html = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                    log("GET " + home + " -> " + (int)resp.StatusCode + " (" + step.ElapsedMilliseconds + " ms)");
                    if (!resp.IsSuccessStatusCode) throw new InvalidOperationException("health check HTTP " + (int)resp.StatusCode);
                    if (html.IndexOf("<title>Weft</title>", StringComparison.Ordinal) < 0) throw new InvalidOperationException("homepage is not the Weft frontend");
                }
            }
            catch (Exception ex)
            {
                log("FAILED: " + ex.Message);
                code = 1;
            }
            finally
            {
                if (started)
                {
                    try
                    {
                        var step = Stopwatch.StartNew();
                        string detail;
                        int sc = ServiceRunner.Stop(dir, out detail);
                        log("stop exit " + sc + " (" + step.ElapsedMilliseconds + " ms)" + (string.IsNullOrEmpty(detail) ? "" : ": " + detail.Replace("\n", " | ")));
                        if (sc != 0) code = code == 0 ? 2 : code;
                    }
                    catch (Exception ex) { log("stop FAILED: " + ex.Message); if (code == 0) code = 2; }
                }
            }
            sb.AppendLine("exit: " + code);
            SelfCheck.Emit(sb.ToString(), outFile);
            return code;
        }
    }
}
