using Microsoft.Win32;

namespace Weft.Setup;

public sealed record Registered(string? Location, string? Version);

/// <summary>HKCU 下的「应用和功能」登记，按用户安装，不需要管理员。</summary>
public static class Registration
{
    public const string KeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Weft";

    public static Registered Read()
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(KeyPath);
            return new Registered(k?.GetValue("InstallLocation") as string, k?.GetValue("DisplayVersion") as string);
        }
        catch
        {
            return new Registered(null, null);
        }
    }

    public static bool Exists()
    {
        using var k = Registry.CurrentUser.OpenSubKey(KeyPath);
        return k != null;
    }

    public static void Write(string dir, string version, long sizeBytes)
    {
        var uninstaller = Path.Combine(dir, "uninstall.exe");
        using var k = Registry.CurrentUser.CreateSubKey(KeyPath, true);
        k.SetValue("DisplayName", "Weft");
        k.SetValue("DisplayVersion", version);
        k.SetValue("Publisher", "Weft");
        k.SetValue("InstallLocation", dir);
        k.SetValue("DisplayIcon", Path.Combine(dir, "Weft.exe") + ",0");
        k.SetValue("UninstallString", $"\"{uninstaller}\" /uninstall");
        k.SetValue("QuietUninstallString", $"\"{uninstaller}\" /uninstall /S");
        k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, sizeBytes / 1024), RegistryValueKind.DWord);
        k.SetValue("NoModify", 1, RegistryValueKind.DWord);
        k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
    }

    public static void Remove()
    {
        try { Registry.CurrentUser.DeleteSubKeyTree(KeyPath, false); }
        catch (Exception e) { Log.Write("删除登记失败: " + e.Message); }
    }

    /// <summary>跟随系统：true 为深色。读不到按浅色。</summary>
    public static bool SystemIsDark()
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return k?.GetValue("AppsUseLightTheme") is int v && v == 0;
        }
        catch
        {
            return false;
        }
    }
}
