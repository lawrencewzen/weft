# Weft v2 架构

状态：已确认（2026-10-25），迁移中。当前实现见 `docs/ARCHITECTURE.md`。

## 1. 目标和边界

- **只做本地服务，一机一人。** 服务和工作区在同一台电脑上，不做账号体系。
- **多个客户端共用一个服务。** 规划中的客户端有 mac（SwiftUI）、Windows 原生、iOS、Web。目前只做 Web，其余都是规划。
- **客户端只负责显示。** 界面要的数据由服务端算好（视图模型），各端不重复实现推导规则。
- **内核继续用 Pi Durable。** 对话、任务、检查点、断点续跑、子 Agent、中止、压缩都走 Harness，模型调用走 pi-ai。AGENTS.md 里"禁止自写编排器、任务调度、检查点"的规定不变。
- **以后的口子先留好，现在不实现：** 远程连接（手机）、通过 Provider 接外部 agent（ACP、Claude Code 等）、设备管理。

## 2. 总体结构

```
┌──────────── 客户端（只负责显示）────────────┐
│ Web（React，/）  mac  Windows  iOS(以后)     │
└───────────────┬──────────────────────────────┘
                │ HTTP 发命令 + SSE 收推送（OpenAPI 3.1 契约）
┌───────────────┴─────── Weft 服务（Node 22，常驻）───────┐
│ http/      路由、鉴权、契约校验                          │
│ stream/    SSE：快照、实体更新、文字增量、续传            │
│ views/     视图模型：对话流、工具、子 Agent、运行状态…    │
│ phrases/   服务端文案（按客户端语言）                     │
│ providers/ Provider 抽象、钥匙串、Grok 登录               │
│ daemon/    发现文件、单实例、空闲退出、版本握手            │
│ kernel/    Pi Durable 门面（现有 src/kernel 演进而来）     │
│ core/      Git、工作区、技能、插件（现有 src/core 复用）    │
└──────┬──────────────┬───────────────┬────────────────────┘
       │              │               │
  session.sqlite   weft.sqlite     系统钥匙串
  （Harness，      （索引、设置、   （Weft 自己的密钥）
   对话唯一来源）   Provider 配置）
```

## 3. 服务进程

- **启动**：客户端打开时发现服务没跑，就把它拉起来，作为独立进程运行；客户端退出不影响服务。设置里可以打开开机自启（mac 用 launchd 用户代理，Windows 用登录启动项），不需要管理员权限。
- **单实例**：沿用现在数据目录下的锁文件。
- **发现文件**：服务启动后写 `<dataDir>/service.json`，内容是实际端口、pid、协议版本、服务版本和本机令牌。只有本用户能读（mac 设 0600；Windows 靠用户目录本身的 ACL）。服务退出时删除。
- **端口**：启动器拉起的服务用随机端口（`PORT=0`）。迁移期间手动 `npm start` 仍沿用 `PORT` 环境变量和默认的 3000，阶段 5 再统一。
- **空闲退出**：没有运行中的任务、也没有客户端连接超过 `idleExitMinutes`（默认 30，可配）就退出。只对启动器拉起的服务生效；手动启动和打开开机自启时不退出。
- **版本握手**：每个响应头和 SSE 快照里都带 `protocolVersion`（语义化版本）。同一个大版本内服务端保持向后兼容。客户端发现服务太旧时：如果没有运行中的任务，就请求服务重启（`POST /api/v2/service/restart`，由客户端重新拉起）；有任务就提示用户等任务跑完。
- 只监听 `127.0.0.1`。

## 4. 鉴权

按"以后可以从网络连进来"来设计，现在只实现本机部分。

- **本机原生客户端**：读发现文件里的本机令牌，放在 `Authorization: Bearer` 里发。令牌每次服务启动时轮换。
- **网页端**：浏览器读不到发现文件，所以要用一次性码换成 cookie。`npm start` 在 `WEFT_READY` 之后打印 `http://127.0.0.1:<port>/auth?code=…`（10 分钟、一次性）。命令行 `weft open` 或原生端的「在浏览器打开」用本机令牌再申请一枚 60 秒码，打开同一路径。成功后种 HttpOnly、SameSite=Strict 的 `weft_session`，并 302 到 `/`。旧书签 `/next/login?code=` 会 302 到 `/auth?code=`。不做本机免登录。
- **SSE**：先用 cookie 或 Bearer，沿用现在的 ticket 机制。
- **设备令牌、配对、吊销**：契约里先定义好（`/api/v2/devices`、`/api/v2/pairing`），实现放到做远程连接时。
- 保留现有的 Host、Origin、Content-Type 校验和安全响应头。

## 5. 协议

### 5.1 传输

- **命令**：HTTP + JSON，路径前缀 `/api/v2`。会产生副作用的命令都带 `requestId`，用来保证幂等，对应 Pi 的 `submit({ requestId })`。
- **推送**：SSE。一个客户端连一条流，用查询参数订阅主题：`GET /api/v2/events?topics=workspaces,conversation:<id>&lang=zh`。改订阅就重连。
- **续传**：每条事件带递增的 `id`（序号）。客户端断线后带 `Last-Event-ID` 重连，服务端从环形缓冲里补发。落后太多补不上时，直接发一份新快照。
- 每 15 秒发一次心跳。

### 5.2 契约

- `contract/openapi.yaml`（OpenAPI 3.1 + JSON Schema）是唯一依据，SSE 事件的数据结构也写在里面（`components/schemas`）。
- 由契约生成类型：服务端和 Web 用 openapi-typescript，Swift 用 swift-openapi-generator，C# 用 Kiota 或 NSwag。
- 服务端在测试和开发模式下用契约校验请求和响应，契约和实现不一致时测试失败。
- 生成物（TS 类型、契约的 JSON 版本）提交进仓库，运行时不依赖 YAML 解析；CI 重新生成一遍，和提交的不一致就失败。

### 5.3 推送事件

| 事件 | 数据 | 说明 |
|---|---|---|
| `snapshot` | 订阅主题下的全部实体 | 连接时、补不上时发。SSE id 是开始计算快照时的序号；计算期间到达的事件在快照后按序补发 |
| `upsert` | `{ entity, id, value }` | 实体整个替换，客户端按 id 覆盖 |
| `remove` | `{ entity, id }` | 实体删除 |
| `text.delta` | `{ itemId, offset, append }` | 只用于流式文字。`offset` 是追加前的长度；已应用过的 delta 忽略，对不上时等下一次 upsert |
| `heartbeat` | `{}` | 心跳 |

流式输出结束时，再对这个 item 发一次完整的 `upsert`。

### 5.4 文案和语言

- 客户端连接时用 `lang` 声明语言（先支持 zh、en）。
- 服务端生成的句子按这个语言直接出成句：工具组摘要、结果提示、等待提示、错误和失败原因、Provider 不可用的原因等。同时附上结构化字段（数量、枚举），方便客户端做样式。
- 按钮、菜单这类客户端自己的界面文字，由各端自己翻译。

## 6. 视图模型

所有实体都有 `id`。时间一律用毫秒时间戳，相对时间（"3 分钟前"）和秒表由客户端根据时间戳自己走。

### 6.1 列表

- **Workspace**：`id, name, path, source(local|git), gitUrl, branch, git(GitStatus|null), conversationCount, runningCount`
- **ConversationSummary**：`id, workspaceId, title, updatedAt, status(idle|running|waiting|failed), runningAgents, subagents{total, live}, archived`
  - 状态归一：recovering、resuming 算 running；paused 算 waiting；error 算 failed。

### 6.2 对话（主题 `conversation:<id>`）

- **ConversationView**：摘要字段，再加 `model`（ResolvedModel）、`run`（RunState）、`context`（ContextUsage）、`itemIds`（对话流的顺序）
- **ThreadItem**，按 `kind` 区分：
  - `user`：`text`（Markdown 原文）、`pathRefs`
  - `assistant`：`text`、`pathRefs`、`model`、`streaming`、`truncated`（为 true 时客户端显示"继续"按钮）
  - `tool_group`：`toolIds`、`summary{text, failed, running}`、`live`
  - `subagent_report`：`subagentId`、`reportKind(answered|failed)`、`body`
  - `system_note`：`noteKind(auto_continue|correction|note)`、`text`
  - 服务端负责：把连续的工具调用合成工具组；识别子 Agent 汇报和自动继续；丢掉空回复；标出被截断的最后一条回复。
  - `pathRefs`：`[{ text, path, line? }]`，列出行内代码里在工作区中真实存在的文件路径，各端渲染 Markdown 时把这些变成可点的标签。
- **ToolCall**：`id, groupId, kind(read|write|edit|ls|grep|bash|other), status(running|failed|interrupted|done), heading{title, detail, fromIntent}, path（相对工作区）, hint{text, failed}, failure(none|probe|real), diff{added, removed}, exitCode, output{preview, truncated, totalLines}`
  - 全文按需拉：`GET /api/v2/tools/<id>/output`。
- **Subagent**：`id, parentConversationId, conversationId, title, mode(foreground|background), status(waiting|running|stuck|done|stopped|failed), startedAt, lastActivityAt, endedAt, currentAction, progress{step, total}`
  - `title` 按 title → brief 第一行 → lastText → name 的顺序回退，由服务端算。
  - **卡住由服务端判定**：running 状态下超过 `stuckAfterMs` 没有活动，服务端把 status 改成 stuck 并推送 upsert；恢复活动后改回 running。
- **RunState**：`status, startedAt, pendingText, canSend, canStop, lockedReason, error{code, message, retry{attempt, delayMs}}`
- **ContextUsage**：`used, window, percent, level(ok|warn|full)`。窗口大小按"手动覆盖 → Provider 默认 → 模型目录 → 环境变量"的顺序由服务端解析。

### 6.3 资源

- **Provider / Model**：见第 7 节。
- **Change**：`path, status, added, removed`。**Diff**：`path, hunks[{ oldStart, newStart, lines[{ op(ctx|add|del), text }] }]`。
- **FileNode**：`path, type, children?`。**FileContent**：`path, text?, binary, size`。
- **Plugin / Skill / GitConnection**：在现有字段基础上，失败原因由服务端出成句。

### 6.4 留在客户端的

布局、主题、字号，哪些项展开或折叠，相对时间和秒表，Markdown 渲染。

## 7. Provider

```
Provider {
  id, vendor（品牌 id，用来匹配图标）, name,
  access: api_key | account | local | custom_endpoint | agent（只预留）,
  runtime: model（Pi Durable + pi-ai）| agent（以后：外部 agent 作为长任务）,
  status: ok | needs_auth | unreachable | error, statusText（服务端出成句）,
  models: [{ id, displayName, brand, contextWindow }]
}
```

- 对话绑定 `{ providerId, modelId }`；子 Agent 默认沿用主对话的。
- 品牌识别（模型 ID 和服务商对应到哪个品牌）在服务端做，数据来自 T34-1 的 `brand-data.json`。图标文件由各端自己打包。
- **密钥**：Weft 自己管理的 API Key 和令牌存在系统钥匙串里（mac Keychain、Windows 凭据管理器），候选库是 `@napi-rs/keyring`（有预编译二进制），要先确认内网 npm 镜像能装。`weft.sqlite` 里只存引用。`~/.grok/auth.json` 是和 grok 命令行共用的，照旧读写。
- **账号登录**：先只做 Grok Build。其他 7 家（Claude Code、Codex、Antigravity、Gemini CLI、GitHub Copilot、Qwen Code、Kiro）逐家核实技术可行性和服务条款后再加，界面暂不显示。
- `runtime: agent` 只在契约里预留。以后实现时，外部 agent 作为 Pi Durable 的长任务运行（外部会话 id 存进检查点，abort 对应取消），不另写调度。

## 8. 数据和存储

- `session.sqlite`（Harness）：对话、任务、检查点，是对话内容的唯一来源。
- `weft.sqlite`：工作区、对话索引、设置、Provider 配置（不含密钥）、插件和技能的开关。
- 系统钥匙串：密钥。
- `service.json`：发现文件，运行时生成。
- 视图模型不落盘，由 Harness 状态和事件算出来，在内存里缓存，供续传和快照用。

## 9. 代码组织

- v2 新代码用 TypeScript。Node 22.19 能直接运行 `.ts`（自动去掉类型注解），服务端不加构建步骤。旧的 `.mjs` 先不动，逐步迁移。
  - 注意：直接运行 TS 只支持能直接去掉的语法，不能用 `enum`、`namespace`、参数属性，要在 tsconfig 里开 `erasableSyntaxOnly`，并用 `tsc --noEmit` 做类型检查。
- 目录：
  - `contract/openapi.yaml`：契约
  - `src/v2/`：http、stream、views、phrases、providers、daemon
  - `web/`：新网页端（React + Vite）。`npm install` 时构建到 `public-next/`，由服务挂在 `/`。缺少开发依赖时安装不失败，访问 `/` 会提示运行 `npm run build:web`。
- `src/kernel/`、`src/core/` 被 v2 复用。需要改的部分，在原位置演进。

## 10. 迁移阶段

旧接口（`/api/*`）在迁移期间保持可用。**阶段 5 第一步已完成（T44-3a）**：默认入口是新网页端（`/`），旧前端挪到 `/legacy` 过渡期保留；`/next/...` 书签 302 到去掉前缀的同一路径。删除旧接口和旧前端是阶段 5 的后续步骤。

| 阶段 | 内容 | 做完能看到什么 |
|---|---|---|
| 0 地基 | TS 工程和类型检查、契约文件和类型生成、契约校验、`/api/v2` 骨架、发现文件、本机令牌和一次性码、`weft open`、SSE（快照、序号、续传、心跳）、空闲退出、版本握手、`web/` 脚手架 | `weft open` 打开 `/next`，能连上流并收到心跳 |
| 1 对话区 | ConversationView、ThreadItem、ToolCall、RunState、ContextUsage，服务端文案（zh、en），发送、停止、插话、继续；`/next` 只做中间栏 | 在 `/next` 里打开已有对话并聊天 |
| 2 侧栏 | Workspace、ConversationSummary、Subagent，卡住判定，新建和归档对话 | `/next` 可以切换对话、查看子 Agent |
| 3 右栏 | Change、Diff、FileNode、FileContent，编辑保存 | `/next` 看 diff、浏览和编辑文件 |
| 4 设置 | Provider（钥匙串，按原型做新界面）、插件、技能、Git 连接、外观 | `/next` 功能和旧端齐平 |
| 5 收尾 | 默认切到新端；删除旧接口、旧前端和前端推导模块；重写 ARCHITECTURE、DEPLOYMENT 等文档 | 只剩 v2。**第一步已完成**：`/` 是新端，旧端在 `/legacy`，`npm install` 构建新端，`npm start` 打印登录链接；DEPLOYMENT 已改成本地/内网 Windows |

每个阶段拆成若干个小 PR，每个 PR 带单测；e2e 用 Playwright 跑新网页端（`/`）。

## 11. 待定事项

- `web/` 的构建产物：内网部署走 `npm install` 当场构建（T44-3a），不提交 `public-next/`。发布包是否另打待定。
- `@napi-rs/keyring` 在内网镜像和 Windows 上能不能装；装不了时用什么回退。
- 服务端文案先支持哪几种语言（暂定 zh、en）。
- 开机自启的设置放在服务端还是客户端（倾向客户端，因为注册系统启动项是平台相关的）。
- `docs/DEPLOYMENT.md` 已在阶段 5 第一步改成本地/内网 Windows 部署。
