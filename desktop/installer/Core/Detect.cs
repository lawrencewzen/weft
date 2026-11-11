using System.Text;

namespace Weft.Setup;

public enum InstallMode { Install, Upgrade, Uninstall }

public sealed record Detection(InstallMode Mode, string Dir, string Source);

public static class PathUtil
{
    public static bool IsSafeRelative(string rel)
    {
        if (string.IsNullOrEmpty(rel)) return false;
        if (rel.StartsWith('/') || rel.Contains(':')) return false;
        foreach (var part in rel.Split('/'))
            if (part == ".." || part.Length == 0) return false;
        return true;
    }

    public static string Norm(string p)
    {
        var full = Path.GetFullPath(p.Replace('/', Path.DirectorySeparatorChar));
        return full.Length > 3 ? full.TrimEnd('\\', '/') : full;
    }

    /// <summary>path 是否在 dir 目录之内（含 dir 本身下的子路径），忽略大小写。</summary>
    public static bool IsUnder(string dir, string path)
    {
        try
        {
            var d = Norm(dir).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
            var p = Norm(path);
            return p.StartsWith(d, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    public static string ToLocal(string manifestPath) => manifestPath.Replace('/', Path.DirectorySeparatorChar);

    /// <summary>驱动器根、空串、系统目录不能当安装目录。</summary>
    public static bool IsAcceptableInstallDir(string dir)
    {
        if (string.IsNullOrWhiteSpace(dir)) return false;
        try
        {
            var full = Path.GetFullPath(dir);
            var root = Path.GetPathRoot(full);
            if (string.IsNullOrEmpty(root)) return false;
            return !string.Equals(full.TrimEnd('\\', '/'), root.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}

public static class InstallDetector
{
    /// <summary>
    /// 先看登记里的 InstallLocation，且该目录有 Weft.exe → 升级；
    /// 否则取正在运行的 Weft.exe 所在目录 → 升级；都没有 → 首次安装（默认目录）。
    /// </summary>
    public static Detection Detect(string? registeredLocation, Func<string, bool> hasWeftExe,
        IEnumerable<string> runningWeftExePaths, string defaultDir)
    {
        if (!string.IsNullOrWhiteSpace(registeredLocation) && hasWeftExe(registeredLocation))
            return new Detection(InstallMode.Upgrade, registeredLocation, "registry");
        foreach (var exe in runningWeftExePaths)
        {
            var dir = Path.GetDirectoryName(exe);
            if (!string.IsNullOrEmpty(dir) && hasWeftExe(dir))
                return new Detection(InstallMode.Upgrade, dir, "process");
        }
        return new Detection(InstallMode.Install, defaultDir, "default");
    }
}

public sealed class CliOptions
{
    public bool Silent { get; set; }
    public bool Uninstall { get; set; }
    public bool DeleteData { get; set; }
    public bool NoDesktop { get; set; }
    public string? Dir { get; set; }
    public string? Error { get; set; }

    /// <summary>隐藏命令行 --render-preview &lt;目录&gt;：把各界面状态渲染成 PNG，不安装任何东西。</summary>
    public string? PreviewDir { get; set; }
    public double[] PreviewScales { get; set; } = { 1.0, 1.25, 1.5, 2.0 };
    /// <summary>"dark" / "light"；null 表示两个都出。</summary>
    public string? PreviewTheme { get; set; }

    public static double[]? ParseScales(string s)
    {
        var list = new List<double>();
        foreach (var part in s.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!double.TryParse(part, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v)
                || v < 0.5 || v > 4) return null;
            list.Add(v);
        }
        return list.Count == 0 ? null : list.ToArray();
    }

    /// <summary>
    /// /S 静默；/D=路径（可带空格，也可被引号包住）；/uninstall；/deletedata；/nodesktop。
    /// 大小写不敏感，/ 和 - 开头都认。
    /// </summary>
    public static CliOptions Parse(IReadOnlyList<string> args)
    {
        var o = new CliOptions();
        for (var i = 0; i < args.Count; i++)
        {
            var a = args[i];
            var key = a.TrimStart('/', '-');
            if (a.Length == 0 || (a[0] != '/' && a[0] != '-')) { o.Error = "无法识别的参数: " + a; continue; }
            if (key.StartsWith("D=", StringComparison.OrdinalIgnoreCase))
            {
                var sb = new StringBuilder(key[2..]);
                // NSIS 风格：/D= 不加引号时路径里的空格会把它拆成多个参数，拼回去
                while (i + 1 < args.Count && !(args[i + 1].StartsWith('/') && args[i + 1].Length > 1 && char.IsLetter(args[i + 1][1])))
                {
                    i++;
                    sb.Append(' ').Append(args[i]);
                }
                o.Dir = sb.ToString().Trim().Trim('"');
                continue;
            }
            switch (key.ToLowerInvariant())
            {
                case "render-preview":
                    if (i + 1 < args.Count) o.PreviewDir = args[++i]; else o.Error = "--render-preview 缺少输出目录";
                    break;
                case "scale":
                    if (i + 1 < args.Count && ParseScales(args[i + 1]) is { } sc) { o.PreviewScales = sc; i++; }
                    else o.Error = "--scale 参数无效";
                    break;
                case "theme":
                    if (i + 1 < args.Count && args[i + 1].ToLowerInvariant() is "dark" or "light") o.PreviewTheme = args[++i].ToLowerInvariant();
                    else o.Error = "--theme 参数无效";
                    break;
                case "s": case "silent": o.Silent = true; break;
                case "uninstall": o.Uninstall = true; break;
                case "deletedata": o.DeleteData = true; break;
                case "nodesktop": o.NoDesktop = true; break;
                default: o.Error = "无法识别的参数: " + a; break;
            }
        }
        return o;
    }
}

public static class DiskSpace
{
    public const long Margin = 32L << 20;

    /// <summary>需要的可用空间：要写入的字节数 + 最大文件（临时文件）+ 余量。</summary>
    public static long Required(long writeBytes, long largestFile) => writeBytes + largestFile + Margin;

    public static string FormatMb(long bytes) => $"{Math.Max(1, (bytes + (1 << 20) - 1) >> 20)} MB";
}
