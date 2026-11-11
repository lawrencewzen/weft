using System.Drawing.Drawing2D;

namespace Weft.Setup.Ui;

/// <summary>自绘控件的公共部分：悬停、按下、键盘激活、焦点环。</summary>
public abstract class FlatControl : Control
{
    protected bool Hover, Down;
    protected float S => DeviceDpi / 96f;

    protected FlatControl()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.StandardClick, true);
        TabStop = true;
        Cursor = Cursors.Hand;
    }

    /// <summary>用过 Tab 之后才画焦点环，鼠标点击和刚打开时不画。</summary>
    public static bool KeyboardMode;
    protected override void OnMouseEnter(EventArgs e) { Hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { Hover = false; Down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { KeyboardMode = false; Down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { Down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    public void Activate() => OnClick(EventArgs.Empty);
    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode is Keys.Space or Keys.Enter) { OnClick(EventArgs.Empty); e.Handled = true; }
        base.OnKeyDown(e);
    }

    protected bool KeyboardFocus => Focused && KeyboardMode;

    protected void FocusRing(Graphics g, RectangleF r, float rad)
    {
        if (!KeyboardFocus) return;
        using var p = Theme.Round(RectangleF.Inflate(r, 2 * S, 2 * S), rad + 2 * S);
        using var pen = new Pen(Theme.G2, 2 * S);
        g.DrawPath(pen, p);
    }
}

public enum BtnKind { Normal, Primary, Danger }

public sealed class FlatButton : FlatControl
{
    public BtnKind Kind = BtnKind.Normal;
    readonly int _minW;

    public FlatButton(string text, BtnKind kind = BtnKind.Normal, int minW = 0)
    {
        Text = text; Kind = kind; _minW = minW;
    }

    public int PreferredWidth()
    {
        var w = TextRenderer.MeasureText(Text, Theme.Font(13 * S, Kind != BtnKind.Normal), new Size(1000, 100),
            TextFormatFlags.NoPadding).Width;
        return Math.Max((int)(_minW * S), w + (int)(44 * S));
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Theme.Win);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new RectangleF(0.5f, 0.5f, Width - 1, Height - 1);
        Color fill, border, text;
        switch (Kind)
        {
            case BtnKind.Primary:
                fill = Theme.Btn; border = Theme.Btn; text = Theme.OnBtn;
                if (Hover || Down) fill = Theme.Mix(fill, Theme.Win, .12);
                break;
            case BtnKind.Danger:
                fill = Theme.Err; border = Theme.Err; text = Color.White;
                if (Hover || Down) fill = Theme.Mix(fill, Theme.Win, .12);
                break;
            default:
                fill = Hover || Down ? Theme.Hover : Theme.Win; border = Theme.Line; text = Theme.Ink;
                break;
        }
        using (var path = Theme.Round(r, 6 * S))
        {
            using var b = new SolidBrush(fill);
            g.FillPath(b, path);
            using var pen = new Pen(border, 1f);
            g.DrawPath(pen, path);
        }
        TextRenderer.DrawText(g, Text, Theme.Font(13 * S, Kind != BtnKind.Normal), ClientRectangle, text,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
        FocusRing(g, r, 6 * S);
    }
}

/// <summary>带下划线的文字链接（「更改」「恢复默认」）。</summary>
public sealed class LinkButton : FlatControl
{
    public LinkButton(string text) { Text = text; }

    public int PreferredWidth() =>
        TextRenderer.MeasureText(Text, Theme.Font(12.5f * S), new Size(1000, 100), TextFormatFlags.NoPadding).Width + (int)(18 * S);

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Theme.Sub);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new RectangleF(0, 0, Width, Height);
        if (Hover || Down)
        {
            using var p = Theme.Round(r, 5 * S);
            using var b = new SolidBrush(Theme.Hover);
            g.FillPath(b, p);
        }
        var f = Theme.Font(12.5f * S);
        var sz = TextRenderer.MeasureText(Text, f, new Size(1000, 100), TextFormatFlags.NoPadding);
        var x = (Width - sz.Width) / 2;
        var y = (Height - sz.Height) / 2;
        TextRenderer.DrawText(g, Text, f, new Point(x, y), Theme.Ink, TextFormatFlags.NoPadding);
        using (var pen = new Pen(Theme.Faint, Math.Max(1f, S)))
            g.DrawLine(pen, x, y + sz.Height + 1 * S, x + sz.Width, y + sz.Height + 1 * S);
        FocusRing(g, r, 5 * S);
    }
}

public sealed class CheckRow : FlatControl
{
    bool _checked;
    public bool Checked
    {
        get => _checked;
        set { if (_checked != value) { _checked = value; Invalidate(); CheckedChanged?.Invoke(this, EventArgs.Empty); } }
    }
    public event EventHandler? CheckedChanged;

    public CheckRow(string text, bool isChecked) { Text = text; _checked = isChecked; }

    public int PreferredWidth() =>
        (int)(25 * S) + TextRenderer.MeasureText(Text, Theme.Font(13 * S), new Size(1000, 100), TextFormatFlags.NoPadding).Width + (int)(4 * S);

    protected override void OnClick(EventArgs e) { Checked = !Checked; base.OnClick(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Theme.Win);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var bs = 16 * S;
        var box = new RectangleF(1, (Height - bs) / 2, bs - 1, bs - 1);
        using (var p = Theme.Round(box, 4 * S))
        {
            if (_checked)
            {
                using var b = new SolidBrush(Theme.Btn);
                g.FillPath(b, p);
                using var pen = new Pen(Theme.Btn, 1.5f * S);
                g.DrawPath(pen, p);
                var k = 10 * S; var ox = box.X + (box.Width - k) / 2; var oy = box.Y + (box.Height - k) / 2;
                using var tick = new Pen(Theme.OnBtn, 2.2f * S * 0.8f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
                g.DrawLines(tick, new[]
                {
                    new PointF(ox + 1.5f * k / 10, oy + 5.2f * k / 10),
                    new PointF(ox + 3.9f * k / 10, oy + 7.6f * k / 10),
                    new PointF(ox + 8.5f * k / 10, oy + 2.6f * k / 10),
                });
            }
            else
            {
                using var pen = new Pen(Theme.Faint, 1.5f * S);
                g.DrawPath(pen, p);
            }
        }
        TextRenderer.DrawText(g, Text, Theme.Font(13 * S), new Rectangle((int)(25 * S), 0, Width - (int)(25 * S), Height), Theme.Ink,
            TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
        FocusRing(g, box, 4 * S);
    }
}

public sealed class ProgressTrack : Control
{
    double _v;
    public double Value { get => _v; set { _v = Math.Clamp(value, 0, 100); Invalidate(); } }
    float S => DeviceDpi / 96f;

    public ProgressTrack()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        TabStop = false;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Theme.Win);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new RectangleF(0, 0, Width, Height);
        using (var p = Theme.Round(r, Height / 2f))
        using (var b = new SolidBrush(Theme.Track))
            g.FillPath(b, p);
        var w = (float)(Width * _v / 100.0);
        if (w >= 1)
        {
            var fr = new RectangleF(0, 0, Math.Max(w, Height), Height);
            if (w < Height) fr.Width = Height;
            using var p = Theme.Round(fr, Height / 2f);
            using var br = Theme.Gradient(fr);
            g.FillPath(br, p);
        }
    }
}

public sealed class LogoBox : Control
{
    public LogoBox()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        TabStop = false;
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(Theme.Win);
        Theme.DrawLogo(e.Graphics, new RectangleF(0, 0, Width - 1, Height - 1));
    }
}

public enum BadgeKind { Ok, Error }

/// <summary>完成页的绿色对勾 / 出错页的红色感叹号圆标。</summary>
public sealed class Badge : Control
{
    public BadgeKind Kind = BadgeKind.Ok;
    public Badge()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        TabStop = false;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Theme.Win);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new RectangleF(0, 0, Width - 1, Height - 1);
        var s = Width / 56f;
        var k = 26 * s / 24f; // svg viewBox 24 → 26px
        var ox = (Width - 26 * s) / 2f; var oy = ox;
        PointF P(float x, float y) => new(ox + x * k, oy + y * k);
        if (Kind == BadgeKind.Ok)
        {
            using var br = new LinearGradientBrush(r, Theme.G1, Theme.G2, 45f);
            g.FillEllipse(br, r);
            using var pen = new Pen(Color.White, 2.4f * k) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
            g.DrawLines(pen, new[] { P(5, 12.5f), P(9.5f, 17), P(19, 7.5f) });
        }
        else
        {
            using var br = new SolidBrush(Theme.ErrBg);
            g.FillEllipse(br, r);
            using var pen = new Pen(Theme.Err, 2.4f * k) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            g.DrawLine(pen, P(12, 6), P(12, 13));
            g.DrawLine(pen, P(12, 17.5f), P(12, 17.51f));
        }
    }
}

/// <summary>升级页：0.1.2 → 0.1.3，旧版灰、新版渐变。</summary>
public sealed class VersionLine : Control
{
    public string Old = "", New = "";
    float S => DeviceDpi / 96f;
    public VersionLine()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        TabStop = false;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Theme.Win);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        var fOld = Theme.Font(22 * S);
        var fNew = Theme.Font(22 * S, true);
        var flags = TextFormatFlags.NoPadding | TextFormatFlags.SingleLine;
        var wOld = TextRenderer.MeasureText(Old, fOld, new Size(1000, 100), flags);
        var wNew = TextRenderer.MeasureText(New, fNew, new Size(1000, 100), flags);
        float gap = 10 * S, arW = 22 * S, arH = 12 * S;
        var total = wOld.Width + gap + arW + gap + wNew.Width;
        var x = (Width - total) / 2f;
        var y = (Height - wOld.Height) / 2f;
        TextRenderer.DrawText(g, Old, fOld, new Point((int)x, (int)y), Theme.Faint, flags);
        x += wOld.Width + gap;
        var cy = Height / 2f;
        using (var pen = new Pen(Theme.G2, 1.8f * S) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
        {
            float k = arW / 22f;
            g.DrawLine(pen, x + 1 * k, cy, x + 20 * k, cy);
            g.DrawLines(pen, new[] { new PointF(x + 15 * k, cy - 5 * k), new PointF(x + 20 * k, cy), new PointF(x + 15 * k, cy + 5 * k) });
        }
        x += arW + gap;
        var rect = new RectangleF(x, y, wNew.Width, wNew.Height);
        using var br = Theme.Gradient(rect);
        using var sf = new StringFormat(StringFormat.GenericTypographic) { FormatFlags = StringFormatFlags.NoWrap | StringFormatFlags.NoClip };
        g.DrawString(New, fNew, br, new PointF(x, y), sf);
    }
}

public enum CaptionKind { Minimize, Close }

public sealed class CaptionButton : Control
{
    public CaptionKind Kind;
    bool _hover;
    float S => DeviceDpi / 96f;

    public CaptionButton(CaptionKind kind)
    {
        Kind = kind;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.StandardClick, true);
        TabStop = false;
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var close = Kind == CaptionKind.Close;
        var bg = _hover ? (close ? Theme.CloseHover : Theme.Hover) : Theme.Win;
        g.Clear(bg);
        var fg = _hover ? (close ? Color.White : Theme.Ink) : Theme.Mute;
        using var pen = new Pen(fg, Math.Max(1f, 1.1f * S));
        var sz = 10 * S;
        var x = (Width - sz) / 2f;
        var y = (Height - sz) / 2f;
        if (close)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.DrawLine(pen, x, y, x + sz, y + sz);
            g.DrawLine(pen, x + sz, y, x, y + sz);
        }
        else
        {
            g.SmoothingMode = SmoothingMode.None;
            var yy = (float)Math.Round(y + sz / 2);
            g.DrawLine(pen, x, yy, x + sz, yy);
        }
    }
}
