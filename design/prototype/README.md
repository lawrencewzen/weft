# 网页端原型（design/prototype）

一份本地的、双击就能看的网页端原型。里面的页面不是手画的：用演示模型（faux script）把真实服务和
新网页端（`web/`）跑起来，用 Playwright 把每个状态的 `#root` DOM 和应用 CSS 一起存进单文件 HTML。
所以原型和代码一致——代码变了重新截一次就同步。

- 打开：双击 `design/prototype/index.html`（或浏览器打开 `file:///…/design/prototype/index.html`）。
  不依赖服务端、不联网，字体用系统字体，图标内联成 data URI。
- 工具栏：左边选分组（基线 / 提案（未实现））和状态，也可以选「全部」从上往下排；右边「适应窗口 /
  100%」缩放和「浅色 / 深色」切换。地址栏 hash 记当前状态，例如 `index.html#chat-done`、
  `index.html#all`，可以直接发链接。
- 深色模式：网页端主题是 `<html data-theme="white-light|white-dark">` 切换的，截下来的 CSS 里两套
  变量都在，所以只截一份浅色，切 `data-theme` 就变深色。

## 重新截取

```bash
npm ci                 # 会顺带构建 public-next
npm run build:web      # 改了 web/ 之后必须重跑
npm run proto:capture  # 约 12 秒，输出 design/prototype/index.html
```

`proto:capture` 开头会检查 `public-next/index.html`，没有就提示先构建。任何一个状态截取失败都会
报错退出（不静默跳过），并指出是哪个状态、卡在哪一步。

截取结果要提交进仓库：用户看的就是仓库里的这个文件。

## 加一个基线状态

在 `scripts/proto/states/` 里（一个页面分组一个文件：`chat.mjs`、`agents.mjs`、`panes.mjs`、
`composer.mjs`）往 `states` 数组里加一项：

```js
{
  id: 'chat-done',            // 唯一，也是 hash
  title: '完成的对话',         // 选择列表里显示
  note: '一句话说明',          // 工具栏和状态标题旁显示
  send: '先跑一遍原型截取流程',  // 发出去的 user 消息，同时用作剧本的 when 标记
  script: [ /* faux turns，格式看 tests/fixtures/*.json */ ],
  async prepare(ctx) { /* 打开页面、点按钮，把界面摆到要截的样子 */ },
}
```

- 一段对话要发多次消息时用 `runs: [{ send, script }, …]`；runner 会自动补空 turn，让第二段
  剧本从正确的 assistant 序号开始。
- 需要另一个服务进程（例如「没有配置模型」）时加 `server: 'bare'`。
- 工具调用一次只写一个 `{ tool }` turn：并行调用在 transcript 里的顺序不固定，截图就不可复现。
- 剧本里的 `when` 标记默认取这一段的 `send`；子 Agent、汇报这类走另一条 user 消息的 turn 自己写
  `when`。

## 加一个提案（还没实现的设计）

在 `scripts/proto/proposals/` 里加一个 `.mjs`，导出 `proposal`：

```js
export const proposal = {
  id: 'paste-image',
  title: '粘贴图片（提案）',
  note: '一句话说明',
  base: 'chat-done',   // 基于哪个基线状态
  css: `…`,            // 新增样式，会和应用 CSS 一起写进原型
  async apply(ctx) {   // 在真实 DOM 上注入元素/改文字
    await injectCss(ctx.page, 'proto-proposal-paste', proposal.css);
    /* … */
  },
};
```

提案在原型的选择列表里单独一组，标「提案（未实现）」。删提案就是删这个文件，再跑一次
`proto:capture`。

## 流程规则

1. 要改界面：先在原型里加一个提案 → 用户在本地打开确认 → 再照原型改代码。
2. 实现的 PR 里删掉这个提案，并重新截取基线（`npm run proto:capture`），让原型和实际界面对上。
3. 没有涉及界面的改动不用动原型。
4. 截取结果（`design/prototype/index.html`）要提交进仓库。

## 截取为什么是稳定的

- 时钟类文字在截图前固定：顶栏计时、工具组计时统一成 `00:07`，子 Agent 行时间统一成 `00:12`，
  侧栏相对时间统一成「3 分钟前」。
- 临时目录、workspace 绝对路径换成 `/work/<名字>`；workspace / 对话 / 子 Agent / 工具 / Provider
  的随机 id 换成 `ws-…`、`conv-…`、`tool-01`、`provider-01` 这类固定名字。
- 每个 workspace 先 `git init` 并提交一次：临时目录就在仓库的 `data/test-tmp/` 下，不这样做状态栏
  会读到 weft 仓库自己的 diff，两次截图就不一样了。
- 截取用 `prefers-reduced-motion: reduce` 跑，面板动画不参与。

同样的代码连跑两次，`git diff --stat design/prototype` 应该是空的。

## 已知限制

- 子 Agent 树里没有「失败」这一态：`src/kernel/subagents.mjs` 的 `childStatus()` 只会返回
  running / stopped / done / waiting，失败只能用主对话里的失败汇报卡片表示（`subagents` 状态）。
- 「子 Agent 视图」里被选中的那一行，文字被 `.subagent-tree-row.is-active:before` 的背景盖住了
  （当前产品的渲染结果，原型如实保留）。
- 只截浅色一份：如果以后有只写在 `[data-theme=…-dark]` 里的规则影响布局，需要补深色截图。
