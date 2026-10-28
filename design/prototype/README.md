# 网页端可交互原型

不用启动服务、不联网：双击 `index.html` 就能像用真产品一样操作——侧栏切换对话、新建对话、发消息、看 Agent 流式回复和工具记录、停止、切模型、右栏看 diff / 文件、子 Agent、设置各页、新建工作区、从 Git 导入。

原型用的是 `web/` 里**真实的前端代码**，只把后端换成运行在浏览器里的模拟后端；界面组件一行不改，所以交互和真产品一致。

## 构建和打开

```bash
npm ci                    # 首次：装依赖（postinstall 会构建 public-next）
npm run build:proto       # 生成 design/prototype/index.html（单文件，构建产物不入库）
open design/prototype/index.html    # macOS；Windows 直接双击
```

- 单文件：JS、CSS、品牌图标全部内联，用 `file://` 打开，不发任何网络请求。
- 路由用 hash（`index.html#/c/<id>`），因为 `file://` 下不能 pushState 到别的路径。
- 数据只在内存里：刷新页面或点右下角「重置原型数据」都会回到预置状态。
- 原型把 `window.open` 换成了空实现，避免设备码登录页把浏览器带出原型；Grok 登录页的地址和用户码仍然显示在卡片上。
- 原型暴露 `window.__protoRequests`（每次模拟 `/api` 调用的 `{ method, url }`），`tests/e2e/proto-*.spec.mjs` 用它断言「一次点击只发一次 diff 请求」这类行为。

## 每个功能怎么触发

### 对话主流程（T50-A）

| 功能 | 操作 |
| --- | --- |
| 切工作区 / 对话 | 点侧栏工作区名折叠展开，点对话行切换 |
| 新建对话 | 「新建对话」按钮，或工作区行的 `+` |
| 草稿里换工作区 | 输入框上方的工作区 chip |
| 发消息、流式回复、工具记录 | 直接发；工具组默认折叠，点标题展开 |
| 运行中插话 | 运行中继续发消息，会排队到当前步骤之后 |
| 停止 | 运行中把输入框清空，发送按钮变成停止 |
| 切模型 | 输入框上方的模型 chip |
| 上下文窗口 | 输入框右侧的百分比 chip；选一个上限或填自定义值（`/providers/{id}/models/{id}/context-window`） |

### 右栏

预置对话 `c-rich`（侧栏第一个对话「重构会话列表的加载逻辑」）：
- 「变更」里有 2 个文件。点文件名展开结构化 diff（增删行、新旧行号、hunk 分隔）。
- 工具组里点「编辑」那一行（编辑 `web/src/data/store.ts`）会跳到右栏「变更」并展开该文件的 diff。
- 消息里的路径标签（`web/src/data/store.ts` 这类代码块）点开会在「文件」里打开并定位到行。

「文件」页模拟了一个小仓库（`README.md`、`docs/`、`src/`、`web/`、`tests/`、`contract/`、`scripts/`、`demo/` 等 20 个文件）：
- `.md` 文件打开后在「编辑 / 预览」间切换，编辑后点「保存」（或 `Ctrl/Cmd+S`）。
- 保存后用前后内容算一份行级 diff，右栏「变更」里会多出这个文件（例如保存 `README.md` 之后可以展开看增删行）。
- **保存冲突演示**：打开 `demo/conflict.md`，等 1 秒左右（模拟「另一个编辑器」改了它），进编辑改一行再保存 → 出现 409 冲突条，可选「覆盖」或「重新加载」。文件本身也写着这段说明。
- 新建工作区（见下）会得到一个只含 `README.md` 的模拟仓库。

模拟运行也会产生变更：新对话里发「改一下 web/src/data/store.ts 里的 items 顺序」，运行结束后右栏「变更」出现该文件及其 diff，文件树里标 `M`。

### 子 Agent

预置对话 `c-rich` 有 5 个子 Agent，侧栏对话行上的 chip 显示 `3/5`（运行中 + 卡住 + 等待算 live）。对话本身是「运行中」；`c-tests` 是「等待确认」，`c-scripts` 是「失败」，收起的 `website` 工作区显示「1 运行中」。`c-docs` 有 3 个已完成的子 Agent，角标只显示 `3`，点开会展开树。

| 状态 | 标题 |
| --- | --- |
| 运行中 | 核对 store.ts 的加载顺序 |
| 卡住 | 核对 Git 工作树状态 |
| 完成 | 补 text.delta 偏移的用例 |
| 等待 | 等主 Agent 确认文档口径 |
| 失败 | 跑 Windows 上的启动脚本 |

- 点 chip 展开子 Agent 树；点某一行打开子 Agent 视图（自己的消息流 + 输入框 + 停止）。
- 对「运行中」那个可以发消息、点停止；停止后状态变「已停止」。
- 回到主对话，末尾有两张汇报卡片：一张「交回结果」，一张「失败」；点卡片展开正文，点「打开」进入对应子 Agent。
- **模拟运行派子 Agent**：任何对话里发包含「派个子 Agent ……」的消息（例如 `派个子 Agent 核对一下右栏的变更列表`）。主 Agent 会创建一个子 Agent，它跑几秒、在侧栏出现，完成后往主对话里放一张「交回结果」卡片。消息里同时带「失败 / 出错」两个字（例如 `派个子 Agent 试一下，允许失败`）时，子 Agent 以失败结束，卡片变成失败样式。

> **原型领先于后端的地方**：真服务端目前不会给子 Agent 返回 `failed`（`src/kernel/subagents.mjs` 的 `childStatus()` 只有 running / stopped / done / waiting），但前端已经支持失败显示。原型按前端支持的样子做了「失败」子 Agent 和失败汇报卡片；接真后端时要等内核能报 error。

### 设置

左下角「设置」进入，六个页面都能操作；数据只存在模拟后端内存里（通用页的偏好存在 `localStorage`，和真产品一致）。

| 页面 | 操作 / 失败触发 |
| --- | --- |
| 通用 | 语言、外观（浅色 / 深色 / 跟随系统）、主题、字号，点了立刻生效 |
| Provider | 添加（三步：选品牌 → 填 Key / Base URL → 测试连接并勾模型）、编辑、删除、设为默认；**Key 以 `bad` 开头时测试连接固定失败**，其它 Key 成功并返回模型列表 |
| Provider › Grok | 添加时选「Grok Build」→ 设备码登录：显示网址和用户码 `WEFT-DEMO`，约 2 秒后自动登录成功，进入选模型步骤；完成后多出 Grok Provider，可设为默认 |
| Git 连接 | 添加（**令牌以 `bad` 开头时测试失败**，其它成功）、行内重测、编辑、删除 |
| 插件 | 列表、启用 / 停用、从本机目录导入（**路径里含 `bad` 时导入失败**）；`broken-loader` 预置为加载失败 |
| 技能 | 列表、启用 / 停用、添加、编辑、删除；内置的 `code-review` 不可改删 |
| 关于 | 版本（`0.1.0-prototype`）、协议版本、仓库链接 |

真实产品没有「删除插件」按钮（只有导入和启停），原型照真实界面做，所以删除只在技能页。

**没有配置模型的状态**：Provider 列表里只剩「演示模型」一个可删项，删掉它 → Provider 列表为空，对话页输入框变成「先接入一个模型，才能开始对话」+「接入模型」按钮，点按钮回到 Provider 页。如果先做过 Grok 登录，删掉默认 Provider 或最后一个 API Key Provider 时，原型会把 Grok 会话一起清掉（Grok Provider 只有登录后才存在，不能单独留着），所以同样能走到这个状态。

### 新建工作区

侧栏「项目」右边的 `+`，或右键菜单 / 空状态里的入口：
- **本地目录**：模拟目录树根是 `D:\work`（`weft`、`website`、`sandbox/playground`、`sandbox/notes`、`archive/old-site`）。进目录、点「选择」，或在行上双击；创建后侧栏出现新工作区，可以直接在里面新建对话。
- **Git 导入**：默认用预置的「内网 GitLab」连接，项目列表两个（可搜索），选项目后能选分支（默认分支 + 两个候选），再创建。行内还有「仓库地址」方式，手填 URL 和分支。

## 代码在哪

| 位置 | 作用 |
| --- | --- |
| `web/proto/main.tsx` | 原型入口：先装模拟后端和 hash 路由，再渲染 `<App />` |
| `web/vite.proto.config.ts` | 原型打包：入口换成 `web/proto/index.html`，把 JS/CSS 内联成一个 HTML |
| `web/proto/brand-icons.ts` | 把 `brandIconUrl()` 指向的少数品牌图标换成 data URI（属性和 `setAttribute` 两条路径都要拦） |
| `web/proto/mock/seed.ts` | 预置数据：2 个工作区、7 个对话、Provider、变更 / diff、子 Agent、插件 / 技能 / Git 连接 |
| `web/proto/mock/repo.ts` | 模拟仓库：文件树、文件内容、保存 / 版本、409 冲突、外部修改、行级 diff 统计 |
| `web/proto/mock/db.ts` | 内存状态和发布辅助（会话 / 侧栏 / Provider / 扩展 / 变更） |
| `web/proto/mock/http.ts` | `/api/v2/*` 路由，返回 `src/v2/contract.gen.ts` 里的形状；目录树、工作区、Provider、Git、插件、技能的写操作都在这里 |
| `web/proto/mock/hub.ts` | 事件推送：`snapshot` → `upsert` / `remove` / `text.delta` / `heartbeat` |
| `web/proto/mock/topics.ts` | 主题读取：`workspaces` / `providers` / `extensions` / `conversation:<id>` / `subagent:<cid>:<aid>` |
| `web/proto/mock/run.ts` | 一次运行的模拟：工具记录 → 变更实体 → 流式文字 → 完成 / 停止 / 插话排队 / 派子 Agent |
| `web/proto/mock/subagents.ts` | 子 Agent 预置线程、`subagent:<cid>:<aid>` 推送、派活 / 回报 / 发消息 / 停止 |
| `web/proto/mock/extensions.ts` | 插件、技能、Git 连接和 GitLab 项目 / 分支的预置数据 |
| `web/proto/mock/views.ts` | 把内存数据转成前端收到的视图，按语言出文案 |
| `tests/e2e/proto-smoke.spec.mjs` | 冒烟：`file://` 打开、切对话、新建并发消息、流式完成、停止、零网络 / 零控制台报错 |
| `tests/e2e/proto-right-pane.spec.mjs` | 变更 diff（含「一次点击只发一次请求」）、文件树 / 预览 / 保存 / 409、路径标签、运行产生的变更 |
| `tests/e2e/proto-subagents.spec.mjs` | 四种状态的子 Agent 树、汇报卡片、子 Agent 发消息 / 停止、派子 Agent |
| `tests/e2e/proto-settings.spec.mjs` | 通用偏好、Provider 向导成功 / 失败 / Grok 登录 / 默认 / 上下文、删光 Provider 的「没有模型」、Git、插件、技能、关于 |
| `tests/e2e/proto-workspace.spec.mjs` | 本地目录浏览 + 创建 + 在里面发消息、Git 导入选项目和分支 |
| `tests/e2e/helpers/proto.mjs` | 上面几个 spec 共用的 `file://` 打开 / 零报错 / 零网络断言 |

## 加数据、加交互

- **加预置数据**：改 `web/proto/mock/seed.ts`。对话流里的 `tool_group` 用 `group(...)`，工具行用 `tool(...)`；`MockTool` 的标题 / 提示是 `{ zh, en }`，别只写中文。
- **加一个接口**：在 `web/proto/mock/http.ts` 里加路由。请求 / 响应类型直接引用 `src/v2/contract.gen.ts`（`web/tsconfig.json` 已经把 `proto/` 加进 `typecheck:web`）。没实现就先返回合理空数据，或者 `fail(400, '原型没有这个接口 …')`。
- **加一种运行步骤**：改 `web/proto/mock/run.ts` 的 `planFor()` / `runTool()`。文字必须通过 `text.delta` 推（先 upsert 一条 `live:` 开头的空助手项，最后 remove 它再 upsert 正式项），不要给前端加原型专用分支。
- **推送时序**：照真服务端来——订阅时先 `snapshot`，之后实体变化发 `upsert`，流式文字发 `text.delta`，删除发 `remove`。主题名看 `web/src/data/store.ts`（`workspaces`、`providers`、`extensions`、`conversation:<id>`、`subagent:<cid>:<aid>`）。
- **改了界面就同步模拟数据**：界面新增的接口在 `http.ts` 补上，`proto-*.spec.mjs` 里补一条能点到的用例。
- 改完跑：`npm run typecheck:web && npm run build:proto && npm run test:web`，再跑原型 e2e（CI 会先 `npm run build:proto`）：

```bash
npx playwright test -c tests/playwright.config.mjs \
  proto-smoke proto-right-pane proto-subagents proto-settings proto-workspace
```

## 改界面的流程

1. 在分支上改 `web/src`；界面需要新数据时，先在 `web/proto/mock/` 里造出来。
2. `npm run build:proto`，把 `design/prototype/index.html`（单个文件）给用户点一遍。
3. 用户确认后再接真后端、跑 e2e、合并 `main`。
4. 合并后如果界面有变化，同步更新模拟数据和 `proto-*.spec.mjs`，保证原型还能反映当前界面。

## 已知边界

- 原型不模拟真实网络延迟以外的细节：文件保存不写盘、Git 不真的 clone、Grok 设备码不真的联网。
- `demo/conflict.md` 的外部修改是一次性的：同一页面里只触发一次，刷新后重置。
- 「保存」会用前后内容算一份行级 diff 并更新右栏「变更」，但原型不跑 `git diff`（真服务端的变更列表来自工作区）。
