namespace Weft.Setup.Ui;

/// <summary>缩放系数。Override 仅供 --render-preview 使用：不依赖系统 DPI，直接指定。</summary>
public static class Dpi
{
    public static float? Override;

    public static float Of(Control c) => Override ?? c.DeviceDpi / 96f;
}
