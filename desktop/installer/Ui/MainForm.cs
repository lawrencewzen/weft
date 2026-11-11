using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Weft.Setup.Ui;

/// <summary>560×400 无边框自绘窗口，界面照 design/installer/index.html。</summary>
public sealed class MainForm : Form
{
    const int W = 560, H = 400, TitleH = 36;

    readonly SetupContext? _ctx;
    readonly string? _fatal;
    readonly List<(Label L, float Px, bool Bold, Func<Color> Color)> _labels = new();
    readonly List<Panel> _views = new();

    // 标题栏
    readonly CaptionButton _min = new(CaptionKind.Minimize), _close = new(CaptionKind.Close);
    string _title = "Weft 安装程序";

    // 首次安装
    Panel _vInstall = null!;
    LogoBox _iLogo = null!; Label _iH1 = null!, _iSub = null!, _iLbl = null!;
    PathBox _iPath = null!; CheckRow _iLink = null!; FlatButton _iGo = null!;
    string _chosen = "";

    // 升级
    Panel _vUpgrade = null!;
    LogoBox _uLogo = null!; Label _uH1 = null!, _uSub = null!, _uPath = null!; VersionLine _uVer = null!; FlatButton _uGo = null!;

    // 进度
    Panel _vProg = null!;
    LogoBox _pLogo = null!; Label _pH1 = null!, _pSub = null!, _pStep = null!, _pPct = null!; ProgressTrack _pBar = null!;

    // 完成 / 出错
    Panel _vDone = null!, _vErr = null!;
    Badge _dBadge = null!, _eBadge = null!; Label _dH = null!, _dP = null!, _eH = null!, _eP = null!;
    FlatButton _dFin = null!, _dOpen = null!, _eCancel = null!, _eRetry = null!;

    // 卸载确认
    Panel _vUn = null!;
    LogoBox _nLogo = null!; Label _nH1 = null!, _nSub = null!, _nHint = null!; CheckRow _nDel = null!;
    FlatButton _nCancel = null!, _nGo = null!;

    // 退出确认
    ConfirmMask _mask = null!;

    Panel? _current;
    bool _busy, _quitting, _forceClose;
    CancellationTokenSource? _cts;
    readonly System.Windows.Forms.Timer _tick = new() { Interval = 50 };
    volatile string _step = "";
    long _pctBits;
    SetupException? _lastError;

    public int ResultCode { get; private set; } = 1;

    float S => Dpi.Of(this);
    int Sc(double v) => (int)Math.Round(v * S);

    readonly bool _preview;

    public MainForm(SetupContext? ctx, string? fatal, bool preview = false)
    {
        _ctx = ctx;
        _fatal = fatal;
        _preview = preview;
        if (!preview) Theme.Apply(Registration.SystemIsDark());
        SetStyle(ControlStyles.ResizeRedraw | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        SuspendLayout();
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        ShowIcon = true;
        DoubleBuffered = true;
        AutoScaleMode = AutoScaleMode.None;
        KeyPreview = false;
        BackColor = Theme.Win;
        Text = "Weft 安装程序";
        try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? Application.ExecutablePath); } catch { }

        BuildChrome();
        BuildInstall();
        BuildUpgrade();
        BuildProgress();
        BuildDone();
        BuildError();
        BuildUninstall();
        _mask = new ConfirmMask { Visible = false };
        _mask.Quit.Click += (_, _) => ConfirmQuit();
        _mask.Keep.Click += (_, _) => HideMask();
        Controls.Add(_mask);

        _tick.Tick += (_, _) => PaintProgress();
        ResumeLayout(false);
        ApplyLayout();
        if (_preview) return;
        SystemEvents.UserPreferenceChanged += OnUserPref;
        Start();
    }

    // ---------- 创建控件 ----------

    Label L(Control parent, float px, bool bold, Func<Color> color, ContentAlignment align = ContentAlignment.TopLeft)
    {
        var l = new Label
        {
            AutoSize = false, UseMnemonic = false, UseCompatibleTextRendering = false, TextAlign = align,
            BackColor = Theme.Win, AutoEllipsis = true,
        };
        parent.Controls.Add(l);
        _labels.Add((l, px, bold, color));
        return l;
    }

    Panel View()
    {
        var p = new Panel { Visible = false, BackColor = Theme.Win };
        Controls.Add(p);
        _views.Add(p);
        return p;
    }

    void BuildChrome()
    {
        _min.Click += (_, _) => WindowState = FormWindowState.Minimized;
        _close.Click += (_, _) => Close();
        Controls.Add(_min);
        Controls.Add(_close);
    }

    void BuildHead(Panel p, out LogoBox logo, out Label h1, out Label sub)
    {
        logo = new LogoBox(); p.Controls.Add(logo);
        h1 = L(p, 24, true, () => Theme.Ink, ContentAlignment.MiddleLeft);
        sub = L(p, 13, false, () => Theme.Mute, ContentAlignment.TopLeft);
    }

    void BuildInstall()
    {
        _vInstall = View();
        BuildHead(_vInstall, out _iLogo, out _iH1, out _iSub);
        _iH1.Text = "Weft";
        _iLbl = L(_vInstall, 12, false, () => Theme.Mute);
        _iLbl.Text = "安装位置";
        _iPath = new PathBox(); _vInstall.Controls.Add(_iPath);
        _iPath.Change.Click += (_, _) => ChangePath();
        _iLink = new CheckRow("创建桌面快捷方式", true); _vInstall.Controls.Add(_iLink);
        _iGo = new FlatButton("安装", BtnKind.Primary, 96); _vInstall.Controls.Add(_iGo);
        _iGo.Click += (_, _) => StartRun();
    }

    void BuildUpgrade()
    {
        _vUpgrade = View();
        BuildHead(_vUpgrade, out _uLogo, out _uH1, out _uSub);
        _uH1.Text = "Weft"; _uSub.Text = "检测到已安装的版本";
        _uVer = new VersionLine(); _vUpgrade.Controls.Add(_uVer);
        _uPath = L(_vUpgrade, 12, false, () => Theme.Faint, ContentAlignment.TopCenter);
        _uPath.AutoEllipsis = true;
        _uGo = new FlatButton("更新", BtnKind.Primary, 96); _vUpgrade.Controls.Add(_uGo);
        _uGo.Click += (_, _) => StartRun();
    }

    void BuildProgress()
    {
        _vProg = View();
        BuildHead(_vProg, out _pLogo, out _pH1, out _pSub);
        _pBar = new ProgressTrack(); _vProg.Controls.Add(_pBar);
        _pStep = L(_vProg, 12.5f, false, () => Theme.Mute);
        _pPct = L(_vProg, 12.5f, false, () => Theme.Mute, ContentAlignment.TopRight);
        _pPct.Text = "0%";
    }

    void BuildDone()
    {
        _vDone = View();
        _dBadge = new Badge { Kind = BadgeKind.Ok }; _vDone.Controls.Add(_dBadge);
        _dH = L(_vDone, 20, true, () => Theme.Ink, ContentAlignment.MiddleCenter);
        _dP = L(_vDone, 12.5f, false, () => Theme.Mute, ContentAlignment.TopCenter);
        _dFin = new FlatButton("完成"); _dOpen = new FlatButton("打开 Weft", BtnKind.Primary, 96);
        _vDone.Controls.Add(_dFin); _vDone.Controls.Add(_dOpen);
        _dFin.Click += (_, _) => { ResultCode = 0; _forceClose = true; Close(); };
        _dOpen.Click += (_, _) => OpenWeft();
    }

    void BuildError()
    {
        _vErr = View();
        _eBadge = new Badge { Kind = BadgeKind.Error }; _vErr.Controls.Add(_eBadge);
        _eH = L(_vErr, 20, true, () => Theme.Ink, ContentAlignment.MiddleCenter);
        _eP = L(_vErr, 12.5f, false, () => Theme.Mute, ContentAlignment.TopCenter);
        _eCancel = new FlatButton("取消"); _eRetry = new FlatButton("重试", BtnKind.Primary, 96);
        _vErr.Controls.Add(_eCancel); _vErr.Controls.Add(_eRetry);
        _eCancel.Click += (_, _) => { _forceClose = true; Close(); };
        _eRetry.Click += (_, _) => StartRun();
    }

    void BuildUninstall()
    {
        _vUn = View();
        BuildHead(_vUn, out _nLogo, out _nH1, out _nSub);
        _nH1.Text = "卸载 Weft";
        _nDel = new CheckRow("同时删除数据（对话、设置）", false); _vUn.Controls.Add(_nDel);
        _nHint = L(_vUn, 12, false, () => Theme.Mute);
        _nHint.Text = "数据会保留，重新安装后可继续使用。";
        _nDel.CheckedChanged += (_, _) =>
            _nHint.Text = _nDel.Checked ? "对话和设置将被永久删除，无法恢复。" : "数据会保留，重新安装后可继续使用。";
        _nCancel = new FlatButton("取消"); _nGo = new FlatButton("卸载", BtnKind.Danger, 96);
        _vUn.Controls.Add(_nCancel); _vUn.Controls.Add(_nGo);
        _nCancel.Click += (_, _) => { _forceClose = true; Close(); };
        _nGo.Click += (_, _) => StartRun();
    }

    // ---------- 布局 ----------

    void P(Control c, double x, double y, double w, double h)
    {
        var pr = c.Parent!.Bounds;
        c.Bounds = new Rectangle(Sc(x) - pr.X, Sc(y) - pr.Y, Sc(w), Sc(h));
    }

    void Foot(params FlatButton[] leftToRight)
    {
        var x = Sc(524);
        for (var i = leftToRight.Length - 1; i >= 0; i--)
        {
            var b = leftToRight[i];
            var w = b.PreferredWidth();
            x -= w;
            var pr = b.Parent!.Bounds;
            b.Bounds = new Rectangle(x - pr.X, Sc(338) - pr.Y, w, Sc(34));
            x -= Sc(10);
        }
    }

    void Head(LogoBox logo, Label h1, Label sub)
    {
        P(logo, 36, 42, 64, 64);
        P(h1, 116, 46, 408, 34);
        P(sub, 116, 82, 408, 20);
    }

    void ApplyLayout()
    {
        ClientSize = new Size(Sc(W), Sc(H));
        var tb = Sc(TitleH);
        foreach (var v in _views) v.Bounds = new Rectangle(1, tb, ClientSize.Width - 2, ClientSize.Height - tb - 1);
        foreach (var (l, px, bold, color) in _labels) { l.Font = Theme.Font(px * S, bold); l.ForeColor = color(); l.BackColor = Theme.Win; }

        _close.Bounds = new Rectangle(ClientSize.Width - 1 - Sc(46), 1, Sc(46), tb - 1);
        _min.Bounds = new Rectangle(_close.Left - Sc(46), 1, Sc(46), tb - 1);

        Head(_iLogo, _iH1, _iSub);
        P(_iLbl, 36, 176, 488, 17);
        P(_iPath, 36, 199, 488, 34);
        _iPath.LayoutChange();
        P(_iLink, 36, 247, 300, 20);
        _iLink.Width = _iLink.PreferredWidth();
        Foot(_iGo);

        Head(_uLogo, _uH1, _uSub);
        P(_uVer, 36, 195, 488, 34);
        P(_uPath, 36, 235, 488, 18);
        Foot(_uGo);

        Head(_pLogo, _pH1, _pSub);
        P(_pBar, 36, 203, 488, 6);
        P(_pStep, 36, 220, 400, 20);
        P(_pPct, 424, 220, 100, 20);

        Head(_nLogo, _nH1, _nSub);
        P(_nDel, 36, 197, 488, 20);
        _nDel.Width = _nDel.PreferredWidth();
        P(_nHint, 36, 231, 488, 18);
        Foot(_nCancel, _nGo);

        LayoutCenter(_dBadge, _dH, _dP);
        LayoutCenter(_eBadge, _eH, _eP);
        if (_dOpen.Visible) Foot(_dFin, _dOpen); else Foot(_dFin);
        if (_eRetry.Visible) Foot(_eCancel, _eRetry); else Foot(_eCancel);

        _mask.Bounds = ClientRectangle;
        Invalidate(true);
    }

    void LayoutCenter(Badge b, Label h, Label p)
    {
        var pw = Sc(380);
        var ph = 0;
        if (!string.IsNullOrEmpty(p.Text))
            ph = TextRenderer.MeasureText(p.Text, p.Font, new Size(pw, 1000), TextFormatFlags.WordBreak | TextFormatFlags.NoPadding).Height + Sc(4);
        var content = Sc(56) + Sc(12) + Sc(28) + (ph > 0 ? Sc(12) + ph : 0);
        var top = Sc(TitleH) + (Sc(338 - TitleH) - content) / 2;
        var parent = b.Parent!.Bounds;
        b.Bounds = new Rectangle(Sc(280) - Sc(28) - parent.X, top - parent.Y, Sc(56), Sc(56));
        h.Bounds = new Rectangle(Sc(36) - parent.X, top + Sc(68) - parent.Y, Sc(488), Sc(28));
        p.Bounds = new Rectangle(Sc(280) - pw / 2 - parent.X, top + Sc(108) - parent.Y, pw, ph);
        p.AutoEllipsis = false;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        TryRoundCorners();
        ApplyLayout(); // 构造时句柄还没有，DeviceDpi 不可靠；这里按真实 DPI 重算
    }

    protected override void OnLoad(EventArgs e) { base.OnLoad(e); ApplyLayout(); }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        // 先采用系统建议的位置/尺寸，再按新 DPI 重排，避免两边来回覆盖
        Bounds = e.SuggestedRectangle;
        ApplyLayout();
        foreach (var c in AllControls(this)) c.Invalidate();
    }

    // ---------- 预览（--render-preview） ----------

    internal void ShowPreviewState(string state)
    {
        var c = _ctx!;
        switch (state)
        {
            case "install": c.Mode = InstallMode.Install; Start(); break;
            case "upgrade": c.Mode = InstallMode.Upgrade; Start(); break;
            case "uninstall": c.Mode = InstallMode.Uninstall; Start(); break;
            case "progress":
                c.Mode = InstallMode.Install;
                _title = "Weft 安装程序"; Text = _title;
                _pH1.Text = "正在安装"; _pSub.Text = "";
                _step = "正在写入文件"; _pBar.Value = 42; _pStep.Text = _step; _pPct.Text = "42%";
                Show(_vProg);
                break;
            case "done": c.Mode = InstallMode.Install; ShowDone(); break;
            case "done-upgrade": c.Mode = InstallMode.Upgrade; ShowDone(); break;
            case "error-running": ShowError("无法停止 Weft", "Weft 正在运行。请先退出，再重试。", true); break;
            case "error-disk": ShowError("磁盘空间不足", $"安装位置 {c.Dir} 需要约 {DiskSpace.FormatMb(900L << 20)} 可用空间。", true); break;
            case "quit-confirm": c.Mode = InstallMode.Install; _busy = true; Start(); ShowMask(); _busy = false; break;
        }
        ApplyLayout();
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    void TryRoundCorners()
    {
        try { var v = 2; DwmSetWindowAttribute(Handle, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, ref v, sizeof(int)); } catch { }
    }

    // ---------- 窗口外观 ----------

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ClassStyle |= 0x00020000;          // CS_DROPSHADOW
            cp.Style |= 0x00020000 | 0x00080000;  // WS_MINIMIZEBOX | WS_SYSMENU：任务栏点击可最小化/还原
            return cp;
        }
    }

    protected override void WndProc(ref Message m)
    {
        const int WM_NCHITTEST = 0x84, HTCLIENT = 1, HTCAPTION = 2;
        base.WndProc(ref m);
        if (m.Msg == WM_NCHITTEST && (int)m.Result == HTCLIENT)
        {
            var pt = PointToClient(new Point((short)(m.LParam.ToInt64() & 0xffff), (short)((m.LParam.ToInt64() >> 16) & 0xffff)));
            if (pt.Y < Sc(TitleH) && pt.X < _min.Left) m.Result = (IntPtr)HTCAPTION;
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var bd = new Pen(Theme.WinBd, 1f))
            g.DrawRectangle(bd, 0, 0, Width - 1, Height - 1);
        var gr = new RectangleF(1, 1, Width - 2, Math.Max(1, Sc(3)));
        using (var br = Theme.Gradient(gr))
            g.FillRectangle(br, gr);
        var ic = Sc(14);
        Theme.DrawLogo(g, new RectangleF(Sc(14), (Sc(TitleH) - ic) / 2f, ic, ic));
        TextRenderer.DrawText(g, _title, Theme.Font(12 * S), new Rectangle(Sc(35), 0, Sc(300), Sc(TitleH)), Theme.Mute,
            TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
    }

    void SetTitle(string t)
    {
        _title = t; Text = t;
        Invalidate(new Rectangle(0, 0, Width, Sc(TitleH)));
    }

    void OnUserPref(object? sender, UserPreferenceChangedEventArgs e)
    {
        if (e.Category != UserPreferenceCategory.General || IsDisposed) return;
        var dark = Registration.SystemIsDark();
        if (dark == Theme.Dark) return;
        try { BeginInvoke(new Action(() => { Theme.Apply(dark); BackColor = Theme.Win; foreach (var v in _views) v.BackColor = Theme.Win; ApplyLayout(); foreach (Control c in AllControls(this)) c.Invalidate(); })); } catch { }
    }

    static IEnumerable<Control> AllControls(Control root)
    {
        foreach (Control c in root.Controls) { yield return c; foreach (var d in AllControls(c)) yield return d; }
    }

    // ---------- 流程 ----------

    void Show(Panel v)
    {
        _current = v;
        foreach (var p in _views) p.Visible = p == v;
        v.BringToFront();
        _min.BringToFront(); _close.BringToFront();
        ActiveControl = DefaultButton();
    }

    /// <summary>每页回车触发的按钮。卸载页默认「取消」，避免手滑。</summary>
    FlatButton? DefaultButton() =>
        _current == _vInstall ? _iGo
        : _current == _vUpgrade ? _uGo
        : _current == _vDone ? (_dOpen.Visible ? _dOpen : _dFin)
        : _current == _vErr ? (_eRetry.Visible ? _eRetry : _eCancel)
        : _current == _vUn ? _nCancel
        : null;

    void Start()
    {
        if (_ctx == null)
        {
            ShowError("无法继续", _fatal ?? "未知错误", retry: false);
            return;
        }
        _title = _ctx.Mode == InstallMode.Uninstall ? "Weft 卸载程序" : "Weft 安装程序";
        Text = _title;
        switch (_ctx.Mode)
        {
            case InstallMode.Install:
                _iSub.Text = "版本 " + _ctx.NewVersion;
                _chosen = _ctx.Dir;
                _iPath.PathText = _chosen;
                _iLink.Checked = _ctx.DesktopShortcut;
                RefreshPathLink();
                Show(_vInstall);
                break;
            case InstallMode.Upgrade:
                _uVer.Old = _ctx.OldVersion ?? ""; _uVer.New = _ctx.NewVersion;
                _uPath.Text = "安装在 " + _ctx.Dir;
                Show(_vUpgrade);
                break;
            default:
                _nSub.Text = "版本 " + _ctx.OldVersion;
                Show(_vUn);
                break;
        }
    }

    void RefreshPathLink()
    {
        _iPath.Change.Text = string.Equals(PathUtil.Norm(_chosen), PathUtil.Norm(Engine.DefaultDir), StringComparison.OrdinalIgnoreCase) ? "更改" : "恢复默认";
        _iPath.LayoutChange();
    }

    void ChangePath()
    {
        if (_iPath.Change.Text == "恢复默认")
        {
            _chosen = Engine.DefaultDir;
        }
        else
        {
            using var dlg = new FolderBrowserDialog
            {
                Description = "选择 Weft 的安装位置", UseDescriptionForTitle = true, ShowNewFolderButton = true,
                InitialDirectory = Directory.Exists(Path.GetDirectoryName(_chosen)) ? Path.GetDirectoryName(_chosen)! : "",
            };
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            var d = dlg.SelectedPath;
            var empty = !Directory.Exists(d) || !Directory.EnumerateFileSystemEntries(d).Any();
            var isRoot = !PathUtil.IsAcceptableInstallDir(d);
            // 选了一个有别的东西的目录（或盘符根目录），装进其下的 Weft 子目录
            if (isRoot || (!empty && !File.Exists(Path.Combine(d, "Weft.exe")) && !string.Equals(Path.GetFileName(d.TrimEnd('\\')), "Weft", StringComparison.OrdinalIgnoreCase)))
                d = Path.Combine(d, "Weft");
            _chosen = d;
        }
        _iPath.PathText = _chosen;
        RefreshPathLink();
    }

    void StartRun()
    {
        if (_ctx == null || _busy) return;
        var c = _ctx;
        if (c.Mode == InstallMode.Install) { c.Dir = _chosen; c.DesktopShortcut = _iLink.Checked; }
        if (c.Mode == InstallMode.Uninstall) c.DeleteData = _nDel.Checked;
        var un = c.Mode == InstallMode.Uninstall;
        _pH1.Text = un ? "正在卸载" : c.Mode == InstallMode.Upgrade ? "正在更新" : "正在安装";
        _pSub.Text = c.Mode == InstallMode.Upgrade ? $"{c.OldVersion} → {c.NewVersion}" : "";
        _step = un ? "正在停止 Weft" : "正在校验安装包";
        Interlocked.Exchange(ref _pctBits, BitConverter.DoubleToInt64Bits(0));
        PaintProgress();
        Show(_vProg);
        _busy = true;
        _lastError = null;
        _cts = new CancellationTokenSource();
        var ct = _cts.Token;
        _tick.Start();
        ProgressFn report = (s, p) => { _step = s; Interlocked.Exchange(ref _pctBits, BitConverter.DoubleToInt64Bits(p)); };
        Task.Run(() =>
        {
            SetupException? err = null;
            try
            {
                if (un) Engine.Uninstall(c, report, ct); else Engine.Install(c, report, ct);
            }
            catch (SetupException e) { err = e; }
            catch (Exception e) { err = new SetupException(FailKind.Other, e.Message, 0, e); }
            try { BeginInvoke(new Action(() => Finished(err))); } catch { }
        });
    }

    void PaintProgress()
    {
        var p = BitConverter.Int64BitsToDouble(Interlocked.Read(ref _pctBits));
        _pBar.Value = p;
        _pStep.Text = _step;
        _pPct.Text = (int)Math.Floor(p) + "%";
    }

    void Finished(SetupException? err)
    {
        _tick.Stop();
        _busy = false;
        if (_quitting) { _forceClose = true; Close(); return; }
        if (_mask.Visible) HideMask();
        if (err == null)
        {
            ResultCode = 0;
            PaintProgress();
            ShowDone();
            return;
        }
        _lastError = err;
        var up = _ctx!.Mode != InstallMode.Install;
        switch (err.Kind)
        {
            case FailKind.Running:
                ShowError("无法停止 Weft", "Weft 正在运行。请先退出，再重试。", true);
                break;
            case FailKind.Disk:
                ShowError("磁盘空间不足", $"安装位置 {(up ? "所在磁盘" : _ctx.Dir)} 需要约 {DiskSpace.FormatMb(err.NeededBytes)} 可用空间。", true);
                break;
            case FailKind.Payload:
                ShowError("安装包已损坏", err.Message + "。请重新下载安装程序。", false);
                break;
            default:
                ShowError(_ctx.Mode == InstallMode.Uninstall ? "卸载失败" : _ctx.Mode == InstallMode.Upgrade ? "更新失败" : "安装失败", err.Message, true);
                break;
        }
    }

    void ShowDone()
    {
        var c = _ctx!;
        var un = c.Mode == InstallMode.Uninstall;
        _dH.Text = un ? "已卸载" : c.Mode == InstallMode.Upgrade ? "已更新" : "已安装";
        _dP.Text = un ? (c.DeleteData ? "程序和数据已删除。" : "数据已保留。") : c.Mode == InstallMode.Upgrade ? "当前版本 " + c.NewVersion : "";
        _dOpen.Visible = !un;
        _dFin.Kind = un ? BtnKind.Primary : BtnKind.Normal;
        _dFin.Invalidate();
        ApplyLayout();
        Show(_vDone);
    }

    void ShowError(string title, string msg, bool retry)
    {
        _eH.Text = title; _eP.Text = msg;
        _eRetry.Visible = retry;
        _eCancel.Text = retry ? "取消" : "关闭";
        ApplyLayout();
        Show(_vErr);
    }

    void OpenWeft()
    {
        try
        {
            var exe = Path.Combine(_ctx!.Dir, "Weft.exe");
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = _ctx.Dir })?.Dispose();
        }
        catch (Exception e) { Log.Write("打开 Weft 失败: " + e.Message); }
        ResultCode = 0; _forceClose = true; Close();
    }

    // ---------- 关闭与确认 ----------

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (_busy && !_forceClose && e.CloseReason != CloseReason.WindowsShutDown)
        {
            e.Cancel = true;
            if (!_mask.Visible) ShowMask();
            return;
        }
        if (_busy) _cts?.Cancel();
        base.OnFormClosing(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        SystemEvents.UserPreferenceChanged -= OnUserPref;
        _tick.Stop();
        base.OnFormClosed(e);
    }

    void ShowMask()
    {
        var un = _ctx?.Mode == InstallMode.Uninstall;
        using var bmp = new Bitmap(ClientSize.Width, ClientSize.Height);
        _mask.Visible = false;
        DrawToBitmap(bmp, new Rectangle(Point.Empty, ClientSize));
        _mask.Set(new Bitmap(bmp),
            un ? "退出卸载？" : "退出安装？",
            un ? "卸载尚未完成，现在退出会留下残余文件。" : "安装尚未完成，现在退出可能留下不完整的文件。");
        _mask.Bounds = ClientRectangle;
        _mask.BringToFront();
        _mask.Visible = true;
        _mask.Keep.Focus();
    }

    void HideMask() { _mask.Visible = false; _mask.Release(); }

    void ConfirmQuit()
    {
        _quitting = true;
        _cts?.Cancel();
        HideMask();
        if (!_busy) { _forceClose = true; Close(); }
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if ((keyData & Keys.KeyCode) == Keys.Tab) FlatControl.KeyboardMode = true;
        if (keyData == Keys.Enter && ActiveControl is not FlatControl && !_mask.Visible)
        {
            var def = DefaultButton();
            if (def != null) { def.Activate(); return true; }
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }
}

/// <summary>自绘的路径框：圆角浅底，左边显示路径，右边一个「更改」链接。</summary>
public sealed class PathBox : Control
{
    public readonly LinkButton Change = new("更改");
    string _text = "";
    float S => Dpi.Of(this);

    public string PathText { get => _text; set { _text = value; Invalidate(); } }

    public PathBox()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        TabStop = false;
        Controls.Add(Change);
    }

    public void LayoutChange()
    {
        var w = Change.PreferredWidth();
        var h = (int)(26 * S);
        Change.Bounds = new Rectangle(Width - (int)(4 * S) - w, (Height - h) / 2, w, h);
        Invalidate();
    }

    protected override void OnResize(EventArgs e) { base.OnResize(e); if (Change != null) LayoutChange(); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Theme.Win);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new RectangleF(0.5f, 0.5f, Width - 1, Height - 1);
        using (var p = Theme.Round(r, 6 * S))
        {
            using var b = new SolidBrush(Theme.Sub);
            g.FillPath(b, p);
            using var pen = new Pen(Theme.Line, 1f);
            g.DrawPath(pen, p);
        }
        var tx = (int)(11 * S);
        TextRenderer.DrawText(g, _text, Theme.Font(12.5f * S), new Rectangle(tx, 0, Change.Left - tx - (int)(4 * S), Height), Theme.Ink,
            TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.PathEllipsis);
    }
}

/// <summary>退出确认：盖在窗口上的暗幕 + 居中的卡片。暗幕用打开时抓的窗口截图做底。</summary>
public sealed class ConfirmMask : Control
{
    public readonly FlatButton Quit = new("退出");
    public readonly FlatButton Keep = new("继续", BtnKind.Primary, 96);
    Bitmap? _snap;
    string _title = "", _msg = "";
    float S => Dpi.Of(this);

    public ConfirmMask()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        TabStop = false;
        Controls.Add(Quit); Controls.Add(Keep);
    }

    public void Set(Bitmap snap, string title, string msg)
    {
        _snap?.Dispose(); _snap = snap; _title = title; _msg = msg;
        PlaceCard();
    }

    public void Release() { _snap?.Dispose(); _snap = null; }

    Rectangle _card;

    void PlaceCard()
    {
        var w = (int)(300 * S);
        var pad = (int)(22 * S);
        var msgH = TextRenderer.MeasureText(_msg, Theme.Font(12.5f * S), new Size(w - 2 * pad, 1000), TextFormatFlags.WordBreak | TextFormatFlags.NoPadding).Height;
        var h = (int)(20 * S) + (int)(22 * S) + (int)(6 * S) + msgH + (int)(18 * S) + (int)(34 * S) + (int)(20 * S);
        _card = new Rectangle((Width - w) / 2, (Height - h) / 2, w, h);
        var by = _card.Bottom - (int)(20 * S) - (int)(34 * S);
        var kw = Keep.PreferredWidth(); var qw = Quit.PreferredWidth();
        Keep.Bounds = new Rectangle(_card.Right - pad - kw, by, kw, (int)(34 * S));
        Quit.Bounds = new Rectangle(Keep.Left - (int)(10 * S) - qw, by, qw, (int)(34 * S));
        Invalidate();
    }

    protected override void OnResize(EventArgs e) { base.OnResize(e); if (_snap != null) PlaceCard(); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        if (_snap != null) g.DrawImage(_snap, 0, 0, Width, Height); else g.Clear(Theme.Win);
        using (var dim = new SolidBrush(Color.FromArgb((int)(255 * 0.42), 0, 0, 0)))
            g.FillRectangle(dim, 0, 0, Width, Height);
        var r = new RectangleF(_card.X + .5f, _card.Y + .5f, _card.Width - 1, _card.Height - 1);
        using (var p = Theme.Round(r, 8 * S))
        {
            using var b = new SolidBrush(Theme.Win);
            g.FillPath(b, p);
            using var pen = new Pen(Theme.Line, 1f);
            g.DrawPath(pen, p);
        }
        var pad = (int)(22 * S);
        var y = _card.Y + (int)(20 * S);
        TextRenderer.DrawText(g, _title, Theme.Font(14 * S, true), new Rectangle(_card.X + pad, y, _card.Width - 2 * pad, (int)(22 * S)), Theme.Ink,
            TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
        TextRenderer.DrawText(g, _msg, Theme.Font(12.5f * S), new Rectangle(_card.X + pad, y + (int)(28 * S), _card.Width - 2 * pad, _card.Height),
            Theme.Mute, TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
    }
}
