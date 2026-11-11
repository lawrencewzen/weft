# 安装程序界面原型（T134-2）

单文件 `index.html`，双击即可在浏览器打开。只做界面与流程演示，不含任何真实安装逻辑。窗口 560×400，无边框，右上角最小化/关闭，深浅色跟随系统。

## 状态链接

在本目录下打开（相对链接）：

| 状态 | 链接 |
|---|---|
| 首次安装 → 进度 → 完成 | [index.html](index.html) |
| 升级（0.1.2 → 0.1.3，先停止 Weft） | [?mode=upgrade](index.html?mode=upgrade) |
| 卸载（确认 → 进度 → 完成） | [?mode=uninstall](index.html?mode=uninstall) |
| 出错：Weft 正在运行，无法停止（升级时） | [?fail=running](index.html?fail=running) |
| 出错：卸载时 Weft 正在运行 | [?mode=uninstall&fail=running](index.html?mode=uninstall&fail=running) |
| 出错：磁盘空间不足（安装时） | [?fail=disk](index.html?fail=disk) |
| 出错：磁盘空间不足（升级时） | [?mode=upgrade&fail=disk](index.html?mode=upgrade&fail=disk) |
| 强制深色 / 浅色 | [?theme=dark](index.html?theme=dark) / [?theme=light](index.html?theme=light) |

参数可组合，如 `?mode=upgrade&theme=dark`。

## 参数

- `mode=install|upgrade|uninstall`，默认 `install`；只给 `fail=running` 时按 `upgrade` 处理。
- `fail=running|disk`：进度走到约 45% 时报错；点「重试」后模拟问题已解决，继续走完。
- `theme=dark|light`：覆盖系统主题。

## 交互说明

- 安装位置点「更改」模拟换成 `D:\Weft`，再点「恢复默认」切回。
- 进度中点关闭，弹出退出确认。
- 完成页点按钮后窗口关闭，页面显示「重新打开」。

## 落地到 WinForms 时的取舍

只用纯色、线性渐变、圆角、进度条动画；没有 backdrop-filter。窗口外阴影仅属于浏览器演示，WinForms 里无需实现。
