using System.Text.Json;
using System.Text.Json.Serialization;

namespace Weft.Setup;

public sealed class ManifestFile
{
    [JsonPropertyName("path")] public string Path { get; set; } = "";
    [JsonPropertyName("size")] public long Size { get; set; }
    [JsonPropertyName("sha256")] public string Sha256 { get; set; } = "";
}

/// <summary>
/// 包清单。files 里是除清单自己以外的所有文件，路径用正斜杠、相对安装目录。
/// 安装时随载荷一起带来，也写一份到安装目录（install-manifest.json）。
/// </summary>
public sealed class Manifest
{
    public const string FileName = "install-manifest.json";

    [JsonPropertyName("schema")] public int Schema { get; set; } = 1;
    [JsonPropertyName("name")] public string Name { get; set; } = "Weft";
    [JsonPropertyName("version")] public string Version { get; set; } = "";
    [JsonPropertyName("files")] public List<ManifestFile> Files { get; set; } = new();

    static readonly JsonSerializerOptions Opts = new() { WriteIndented = false };

    public static Manifest Parse(Stream s)
    {
        var m = JsonSerializer.Deserialize<Manifest>(s, Opts) ?? throw new InvalidDataException("manifest 为空");
        m.Validate();
        return m;
    }

    public static Manifest Parse(string json)
    {
        var m = JsonSerializer.Deserialize<Manifest>(json, Opts) ?? throw new InvalidDataException("manifest 为空");
        m.Validate();
        return m;
    }

    public static Manifest? TryLoad(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            using var fs = File.OpenRead(path);
            return Parse(fs);
        }
        catch
        {
            return null;
        }
    }

    public string ToJson() => JsonSerializer.Serialize(this, Opts);

    public long TotalSize => Files.Sum(f => f.Size);

    void Validate()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in Files)
        {
            f.Path = f.Path.Replace('\\', '/');
            if (!PathUtil.IsSafeRelative(f.Path)) throw new InvalidDataException("manifest 含不安全的路径: " + f.Path);
            if (!seen.Add(f.Path)) throw new InvalidDataException("manifest 路径重复: " + f.Path);
            f.Sha256 = (f.Sha256 ?? "").ToLowerInvariant();
        }
    }
}

public sealed class DiffResult
{
    public List<ManifestFile> Write { get; } = new();
    public List<ManifestFile> Unchanged { get; } = new();
    public List<ManifestFile> Remove { get; } = new();
    public long WriteBytes => Write.Sum(f => f.Size);
}

public static class ManifestDiff
{
    /// <summary>
    /// 新旧清单对比。旧清单里同路径、同大小、同 SHA256，并且磁盘上现有文件大小也对得上，才算没变。
    /// diskSize 返回现有文件大小，不存在返回 null。prev 为 null 时全部要写。
    /// </summary>
    public static DiffResult Compute(Manifest? prev, Manifest next, Func<string, long?> diskSize)
    {
        var res = new DiffResult();
        var old = new Dictionary<string, ManifestFile>(StringComparer.OrdinalIgnoreCase);
        if (prev != null) foreach (var f in prev.Files) old[f.Path] = f;
        var nowPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in next.Files)
        {
            nowPaths.Add(f.Path);
            if (old.TryGetValue(f.Path, out var o)
                && o.Size == f.Size
                && string.Equals(o.Sha256, f.Sha256, StringComparison.OrdinalIgnoreCase)
                && diskSize(f.Path) == f.Size)
                res.Unchanged.Add(f);
            else
                res.Write.Add(f);
        }
        if (prev != null)
            foreach (var f in prev.Files)
                if (!nowPaths.Contains(f.Path)) res.Remove.Add(f);
        return res;
    }
}
