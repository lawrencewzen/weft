using System.Drawing.Drawing2D;

namespace Weft.Setup.Ui;

/// <summary>颜色取自原型 design/installer/index.html 的 CSS 变量。</summary>
public static class Theme
{
    public static bool Dark;
    public static Color Win, Ink, Mute, Faint, Line, Sub, Hover, Btn, OnBtn, Track, Err, ErrBg, WinBd;
    public static readonly Color G1 = Color.FromArgb(0x34, 0xd3, 0x99), G2 = Color.FromArgb(0x06, 0xb6, 0xd4), G3 = Color.FromArgb(0x8b, 0x5c, 0xf6);
    public static readonly Color CloseHover = Color.FromArgb(0xe8, 0x11, 0x23);
    public const string FontName = "Microsoft YaHei UI";

    static Theme() => Apply(false);

    static Color C(int rgb) => Color.FromArgb(0xff, (rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);

    public static void Apply(bool dark)
    {
        Dark = dark;
        if (!dark)
        {
            Win = C(0xffffff); Ink = C(0x1f1f1f); Mute = C(0x6e6e6e); Faint = C(0x999999); Line = C(0xe6e6ea); Sub = C(0xf4f4f7);
            Hover = C(0xececf1); Btn = C(0x2b2b2b); OnBtn = C(0xffffff); Track = C(0xe8e8ee); Err = C(0xd14343); ErrBg = C(0xfbeeee); WinBd = C(0xd9d9e0);
        }
        else
        {
            Win = C(0x1b1b20); Ink = C(0xe4e4e4); Mute = C(0x8f8f8f); Faint = C(0x6b6b6b); Line = C(0x2c2c33); Sub = C(0x242429);
            Hover = C(0x2b2b32); Btn = C(0xe4e4e4); OnBtn = C(0x181818); Track = C(0x2a2a31); Err = C(0xf27171); ErrBg = C(0x2c1f21); WinBd = C(0x33333b);
        }
    }

    public static Color Mix(Color a, Color b, double t) => Color.FromArgb(
        255, (int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));

    static readonly Dictionary<(float, bool), Font> FontCache = new();

    /// <summary>按像素字号取字体（和原型 CSS px 一致），缓存。</summary>
    public static Font Font(float px, bool bold = false)
    {
        px = (float)Math.Round(px * 4) / 4;
        lock (FontCache)
        {
            if (!FontCache.TryGetValue((px, bold), out var f))
                FontCache[(px, bold)] = f = new Font(FontName, px, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel);
            return f;
        }
    }

    public static GraphicsPath Round(RectangleF r, float rad)
    {
        var p = new GraphicsPath();
        var d = Math.Max(0.1f, rad * 2);
        if (rad <= 0.1f) { p.AddRectangle(r); return p; }
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static LinearGradientBrush Gradient(RectangleF r, float angle = 0)
    {
        if (r.Width < 1) r.Width = 1;
        if (r.Height < 1) r.Height = 1;
        var b = new LinearGradientBrush(r, G1, G3, angle)
        {
            InterpolationColors = new ColorBlend
            {
                Colors = new[] { G1, G2, G3 },
                Positions = new[] { 0f, 0.5f, 1f },
            },
        };
        return b;
    }

    /// <summary>Weft 图标：深色圆角底 + 渐变波浪线。r 为目标矩形（正方形）。</summary>
    public static void DrawLogo(Graphics g, RectangleF r)
    {
        var s = r.Width / 64f;
        var st = g.Save();
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var bg = Round(r, 15 * s))
        using (var br = new LinearGradientBrush(r, Color.FromArgb(0x1d, 0x1a, 0x2b), Color.FromArgb(0x11, 0x0f, 0x1a), 90f))
        {
            g.FillPath(br, bg);
            using var pen = new Pen(Color.FromArgb(26, 255, 255, 255), Math.Max(1f, s));
            g.DrawPath(pen, bg);
        }
        PointF P(float x, float y) => new(r.X + x * s, r.Y + y * s);
        using var path = new GraphicsPath();
        path.AddBezier(P(10, 22), P(12, 46), P(22, 48), P(26, 34));
        path.AddBezier(P(26, 34), P(29, 24), P(35, 24), P(38, 34));
        path.AddBezier(P(38, 34), P(42, 48), P(52, 46), P(54, 22));
        var cb = new ColorBlend { Colors = new[] { G1, G2, G3 }, Positions = new[] { 0f, 0.55f, 1f } };
        using var lg = new LinearGradientBrush(P(10, 22), P(54, 46), G1, G3) { InterpolationColors = cb };
        using var wave = new Pen(lg, 7 * s) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        g.DrawPath(wave, path);
        g.Restore(st);
    }
}
