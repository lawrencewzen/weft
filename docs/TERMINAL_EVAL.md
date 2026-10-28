# T51-9 内置终端方案评估

状态：评估，不实现。基准：`main` `@earendil-works/pi-durable@1.3.0`，Node 22。目标环境：内网 Windows + Node 22（npm 走内网镜像，不能访问 GitHub Releases，不能要求用户装编译工具链）；macOS 作为开发环境也要能用。

设计依据：`design/claude/project/Main.dc.html` 右栏「终端」（整体交互以 `Weft.dc.html` 为准）。本单只加这一份文档。

---

## 0. 结论

右栏「终端」里其实是两类完全不同的东西，不要合成一个后端：

| 种类 | 设计 | 后端 | 是否要 PTY |
|---|---|---|---|
| **用户终端** | 可开多个；底部可输入；说明「你自己的终端，Agent 不会在这里执行命令」 | 本机伪终端 + 双向字节流 | 要，否则 vim / less / 颜色 / Ctrl+C 都不真 |
| **Agent 命令标签** | 每条正在跑的 `bash` 占一个标签；只读；右键「停止此命令」 | 接 Pi Durable 已有的工具输出事件 | **不要**。官方 `bash` 已经是 `child_process` 管道 |

**推荐：**

1. **先做 Agent 命令标签**（无原生依赖）。Pi Durable 1.3.0 的 `createBashTool()` 已经把 stdout/stderr 流进 `api.output()`，Harness 会打 `tool_execution_update`（`output.append` / `set`）。Weft 现在丢掉这些事件，只在 `tool.end` 后给全文。把更新接到 v2 SSE，右栏就能实时显示。
2. **「停止此命令」不要调用 `conversation.abort()`**。那会停掉整次运行（和输入框「停止」一样）。Pi Durable 没有「中止单个 toolCallId」的 API；有 `Harness.abortTask(taskId)`。实现单先实测：中止该次 `bash` 对应的 `ToolTask` 会不会把父运行一起停掉。若会，就在现有 `WorkspaceExecutionEnv.exec` 包装里记下 pid，杀掉这一棵进程，让这次 `execute()` 自己结束，模型接着跑。这不是自写调度。
3. **用户交互式终端后做。** 原生 PTY 用 `@lydell/node-pty@1.2.0-beta.18`（或同版本的 `node-pty@1.2.0-beta.18`）。预编译二进制在 **npm 包里**，安装时不访问 GitHub，也不走 `node-gyp`。不要用 `@homebridge/node-pty-prebuilt-multiarch`：它的 npm 包只有 Linux 预编译，Windows / macOS 会在 install 脚本里用 `prebuild-install` 去拉 GitHub Releases。
4. 前端：用户 PTY 用 `@xterm/xterm` + `@xterm/addon-fit`（MIT，纯 JS）。Agent 标签用普通滚动文本即可，不必上 xterm。
5. 鉴权、绑定、Host/Origin 一律复用现有 v2 会话（`weft_session` / Bearer）。终端 cwd 必须落在当前工作区里。

分三单，见第 5 节。

---

## 设计里实际有什么

`Main.dc.html` / `Weft.dc.html` 右栏标签是「变更 / 文件 / 终端 / 子 Agent N」。终端面板：

- 顶上一排会话标签，`+` 新建用户终端。
- 用户终端：等宽文本 + 底下一行 `cwd $` 输入框。说明：「你自己的终端，Agent 不会在这里执行命令。」
- Agent 标签：绿点、只读、说明「由 \<owner\> 运行，只读。右键可停止。」右键是「停止此命令」，不是「关闭此终端」。
- 「在终端中打开」出现在：**项目**右键、文件树**目录**右键、输入框**项目芯片**。对话行右键菜单里没有这一项（任务描述写了「对话或项目」；落地时以画板为准，对话行不造这一项，除非产品再改）。

定稿是演示用的「行编辑器」（输入一行、回显一行），不是完整 VT100。产品语义仍是交互式终端：用户标签要能跑真命令；Agent 标签是只读的命令输出。

颜色：画板终端底是 `--term`（浅色 `#1a1a1a`，深色 `#111111`）。`web/src/styles/themes.css` 四个主题都有这个变量，实现时不要写死。

现状：`web/src/components/RightPane.tsx` 只有变更和文件；`RightTab = 'changes' | 'files'`。

---

## 1. 交互式终端怎么做

### 1.1 `node-pty`（microsoft，MIT）

| 版本 | npm 包体积 | `prebuilds/` | install 脚本 |
|---|---|---|---|
| **1.1.0（latest）** | tarball 15 MB，解开约 64 MB | 只有 `darwin-{x64,arm64}`、`win32-{x64,arm64}`，**没有 linux** | `"node scripts/prebuild.js \|\| node-gyp rebuild"` |
| **1.2.0-beta.18** | tarball 7.2 MB，解开约 27 MB | 六个平台都有：darwin / linux / win32 × x64 / arm64 | 同一句 |

`scripts/prebuild.js` 只检查包内 `prebuilds/${platform}-${arch}` 在不在。在就 `exit 0`，不下载任何东西。不在才落到 `node-gyp rebuild`。

实测（本机 Node v22.23.4，linux x64，ABI 127）：

- 1.1.0：`prebuild.js` 打印 `Rebuilding because directory …/prebuilds/linux-x64 does not exist`，退出码 1。内网 Linux CI 或开发机没有 VS Build Tools / Python / 本机头文件就会装失败。
- 1.2.0-beta.18：`prebuild.js` 退出码 0（linux-x64 预编译在 tarball 里）。

Windows 侧 ConPTY 运行时也打进了包：`prebuilds/win32-x64/conpty.node`、`conpty/conpty.dll`、`conpty/OpenConsole.exe`（微软官方 ConPTY）。安装时不用再下。Windows 10 1809+ 即可；目标内网 Windows 按这个假设。

**内网 Windows：** 1.2.0-beta.18 可以从 npm 镜像装（预编译随 tarball）。1.1.0 在 Windows 上也能装（有 win32 预编译），但 Linux CI 会试图编译，不适合本仓库。

**风险：** 1.2.0 仍是 beta，必须钉死版本。install 脚本在预编译缺失时仍会调用 `node-gyp`；六个平台都打进包之后，正常安装走不到那条路。

### 1.2 `@lydell/node-pty`（MIT）——推荐的 PTY 包

`@lydell/node-pty@1.2.0-beta.18` 是 microsoft/node-pty 同版本的瘦包装。包装本身没有 install 脚本。平台包走 `optionalDependencies`：

```
@lydell/node-pty-darwin-arm64
@lydell/node-pty-darwin-x64
@lydell/node-pty-linux-arm64
@lydell/node-pty-linux-x64
@lydell/node-pty-win32-arm64
@lydell/node-pty-win32-x64
```

每个平台包带 `os` / `cpu` 限制，npm 只装当前平台。tarball 里就是 `prebuilds/<plat>/pty.node`（Windows 另有 `conpty.dll` + `OpenConsole.exe`）。**没有 install 脚本，从不调用 node-gyp，从不访问 GitHub。**

体积（tarball）：包装 5.6 KB；linux-x64 36 KB；darwin-arm64 31 KB；win32-x64 2.9 MB（体积在 ConPTY 那两份二进制上）。

实测（脚本不入库）：

```text
npm install @lydell/node-pty@1.2.0-beta.18
# 安装日志里没有 github.com / prebuild-install / node-gyp
# --ignore-scripts 之后 require 仍然能用

pty.spawn("bash", ["-lc", "printf hello-pty; echo"])
# exit 0  out "hello-pty\r\n"
```

**内网 Windows：** 镜像里要有包装包和 `@lydell/node-pty-win32-x64`（以及开发机的 darwin / CI 的 linux）。都是普通 npm 包，不需要额外外网。

**风险：** 也是 beta；optionalDependencies 漏了某个平台时，包装会装上但运行 `spawn` 会炸，不会悄悄去编译。本仓库需要的 linux-x64、darwin-arm64/x64、win32-x64 都在。

### 1.3 `@homebridge/node-pty-prebuilt-multiarch@0.14.1`——不要用

README 写「安装时从 GitHub Release 下载匹配的预编译」。npm 上的事实更窄：

- tarball 2.5 MB。`package/prebuilds/` **只有 Linux**（按 Node ABI 切片：`node.abi111` … `node.abi147`，含 musl）。**没有 darwin，没有 win32。**
- `scripts.install`：`node scripts/check-prebuild.js || prebuild-install --verbose || node scripts/install.js`
- `check-prebuild.js` 看 `prebuilds/${platform}-${arch}/node.abi${modules}.node`。本机 linux x64 ABI 127 对得上，所以 **Linux 不用访问 GitHub**。
- Windows / macOS 对不上 → `prebuild-install`（依赖写在 package.json 里）默认去 `github.com/<repo>/releases` 拉二进制 → 内网失败 → 最后 `scripts/install.js` 调 `node-gyp rebuild` → 没有工具链再失败。

这正好踩中「不能访问 GitHub Releases、不能要求编译工具链」。即便以后他们把 win32 打进 npm 包，install 脚本仍然保留 GitHub 回退，内网策略上也不该用。

### 1.4 Windows ConPTY 的其他做法

Node 22 没有内置 PTY / ConPTY API。`child_process.spawn` 就是匿名管道。

自己调 `CreatePseudoConsole`（koffi / ffi-napi 或手写 N-API）：还是原生代码，预编译和 node-pty 同类问题，API 面更差，WinPTY 回退、resize、退出码都要自己做。winpty 本身也是原生的。

**结论：** 要真终端，就用第 1.2 节那个已经带上 `conpty.dll` 的包，不要再包一层 ConPTY。

### 1.5 不用 PTY、只用 `child_process` 管道

这就是今天 Agent `bash` 的做法（Pi Durable `NodeExecutionEnv.exec`：`stdio: ['ignore'|'pipe', 'pipe', 'pipe']`，Unix 上 `detached: true`，Windows 上 `windowsHide: true`）。

本机实测：

```text
spawn("bash", ["-lc", "test -t 0; test -t 1; printf '\\033[32mgreen\\033[0m\\n'"],
      { stdio: ["ignore", "pipe", "pipe"] })
# stdin_notty
# stdout_notty
# 显式 ANSI 仍会打出来；stty → "Inappropriate ioctl for device"
```

| 能力 | 管道 | PTY |
|---|---|---|
| `ls` / `git status` / `npm test` 这类批处理 | 可以 | 可以 |
| 程序自己写的 ANSI（`printf`、`FORCE_COLOR=1`） | 能到前端 | 能到前端 |
| `ls --color=auto`、进度条、TUI | 通常没有（`isatty` 为假） | 有 |
| vim / less / 交互 REPL / ssh 密码 | 不行（stdin 不是 TTY，也常被设成 ignore） | 行 |
| Ctrl+C 当 SIGINT | 管道读不到；最多自己监听 `\x03` 再 `kill` | PTY 发给前台进程组 |
| Windows 控制台程序（部分只给 ConPTY 写） | 经常卡住或没有颜色 | ConPTY 正常 |
| 原生依赖 | 无 | 要（见上） |

用户终端若做成「输入一行、跑完再吐出」，管道够用，也更接近画板的输入框。代价是：不是真终端，后面很难补上交互程序，和 VS Code / Cursor 的终端预期也不一样。

**建议：** Agent 命令标签继续用管道（已经如此）。用户终端用 PTY。不要用管道假装成交互式终端。

### 1.6 原生依赖怎么写进 PR

用户终端那一单如果加 `@lydell/node-pty`：

- 理由：Windows ConPTY + Unix pty 的预编译都在 npm 包内，安装不访问 GitHub，也不编译。
- 内网镜像：要能装包装包和对应的 `@lydell/node-pty-<os>-<cpu>` optionalDependency。
- 钉 `1.2.0-beta.18`（或评估当时仍满足「预编译在 tarball 里、无 GitHub install」的更新版本）。
- 备选：`node-pty@1.2.0-beta.18` 单包打进全部平台，镜像只多一个包；体积更大，缺预编译时会尝试 `node-gyp`。

---

## 2. 前端终端组件

### 2.1 `@xterm/xterm`（推荐给用户 PTY）

- 许可：MIT（xterm.js authors / SourceLair / Christopher Jeffrey）。
- 版本：6.0.0（registry latest）。纯 JS，无原生、无依赖。
- 体积：npm 解开约 6 MB（含源码/类型/CSS）；浏览器打包约 **80 KB min+gzip**（bundlephobia 79.8 KB；另有 esbuild 测到 85.4 KB gzip）。
- 配套：`@xterm/addon-fit@0.11.0` MIT，解开 20 KB，resize 用。`@xterm/addon-webgl` 可后加，第一版 DOM 渲染够用。
- 内网：普通 npm 包，`postinstall` 不用下载二进制。
- CSP：现有 `script-src 'self'`、`style-src 'self' 'unsafe-inline'`。xterm 自带 CSS，走打包即可。不要运行时插 CDN。

旧包名 `xterm` / `xterm-addon-*` 已弃用，用 `@xterm/*`。

### 2.2 Agent 标签不必上 xterm

Agent `bash` 是合并后的 stdout/stderr 文本（可能带 ANSI）。右栏用等宽 `<pre>` + 主题变量就够。真要颜色，再加很轻的 ANSI→HTML，或同一页面复用一个只读 xterm。第一版建议纯文本，避免两个滚动模型搅在一起。

### 2.3 和画板的差异（有意的）

画板是「一行输入 + 回显」。真 PTY 是整块画布，输入在光标处。用户终端应对齐 VS Code 那种块终端，而不是死跟画板的 `<input>`。标签栏、说明文字、「+ / 停止此命令 / 关闭此终端 / 在终端中打开」跟画板走。

---

## 3. Agent 命令标签

### 3.1 现在服务端有没有实时输出

**内核（Pi Durable 1.3.0）有。Weft 没接到界面。**

官方 bash（`node_modules/@earendil-works/pi-durable` 的 `dist/tools/bash.d.ts`）：

> Runs a command through the environment's shell. Its output streams to `api.output()`.

`NodeExecutionEnv.exec` 对每一段解码后的 stdout/stderr 调 `options.onOutput`；bash 把它转成 `api.output(text, info.skipped)`。stdin 是 `'ignore'`，或 Windows 上把命令写进 stdin 后关掉。这是管道，不是 PTY。

Harness 事件（`dist/harness/events.d.ts`）：

```ts
type: "tool_execution_update"
output?: { trimStart?: number; append?: string } | { set: string }
details?: JsonValue
diagnostics?: readonly ToolDiagnostic[]
toolCallId: string
toolName: string
taskId?: TaskId
```

`watchEvents()` 会打出这些事件。Weft `src/kernel/events.mjs` 的 `mapHarnessBatch` 只处理 `tool_execution_start` / `tool_execution_end`，**没有 `tool_execution_update` 分支**。v2 `conversation-topic.ts` 因此也不会在运行中 upsert 工具输出。`text.delta` 只给助手文本。

工具结束后：

- 内核 `tool.end` 带上保留窗口里的文本。
- `GET /api/v2/conversations/{id}/tools/{toolId}/output` 返回全文（截断后的模型可见文本）。
- `ToolCall.output.preview` 是结束后的预览（成功约 20 行）。运行中的工具没有增量输出。

默认保留的是 **尾部**（行数或字节上限先到为准），更早的写到 spill 文件，诊断里带路径。Agent 标签若要「完整终端」，需要：实时显示保留窗口；结束后再决定是否读 spill / `GET …/output`。不要为界面去改 bash 的保留策略，那是给模型看的。

### 3.2 怎么接到 v2

不另写运行时。在现有 `watchEvents` → `mapHarnessBatch` → conversation topic 上补一层：

1. `mapHarnessBatch` 把 `tool_execution_update` 映射成内部事件（例如 `tool.delta`），带上 `toolCallId` 和 `append` / `set` / `trimStart`。
2. v2 契约加一种 SSE 事件，或对 `tool` 实体做节流 upsert。`ARCHITECTURE_V2.md` 写明 `text.delta` 只用于流式文字，所以不要复用 `text.delta`。更干净的是 `tool.delta`：`{ toolId, offset|trimStart, append }`，和文字增量同一套「对不上就等下次 upsert」。
3. 右栏终端标签：`kind === 'bash' && status === 'running'` 各占一格；结束后可以留着只读，或按产品决定是否自动关。
4. 模拟后端 `web/proto/mock` 要能演：发一条会跑命令的消息 → 终端标签出现 → 文本往下淌。

`bash` 标了 `replay: 'unsafe'`：中断后不重放，模型看到 interrupted。实时 UI 状态只活在当前进程里，重连靠 snapshot + 当时已提交的保留窗口。

### 3.3 「停止此命令」

**Pi Durable 不能按 toolCallId 中止一次工具调用。** 现成的中止都更粗：

| API | 范围 | Weft 现在怎么用 |
|---|---|---|
| `conversation.abort(context, { background })` | 撤回队列，中止这次普通所有权范围里的活；`background: true` 连后台子 Agent | `POST /api/v2/conversations/{id}/stop`、输入框「停止」 |
| `Harness.abortSubmission(id)` | 一次提交 | 未接到「停这一条命令」 |
| `Harness.abortTask(id)` | 一个 task | **未用**。每次工具调用是 `ToolTask`；`tool_execution_start` 可能带 `taskId` |
| `context.abortSignal` | 这次 execute 的信号，来自父运行 | `NodeExecutionEnv.exec` 在 abort 时 `killProcessTree(pid)`（Unix 进程组 SIGKILL；Windows `taskkill /F /T`） |

`conversation.abort()` 对「停止此命令」过粗：会停掉同一轮里还没跑的工具和后面的模型回合，等于点了输入框的停止。

建议实现顺序：

1. 用 `tool_execution_start` 的 `taskId` 调 `harness.abortTask(taskId)`。看父 Agent 运行是继续还是一起停。继续 → 就用这个，不要自己杀进程。
2. 若父运行也被停：在 `WorkspaceExecutionEnv.exec` 里登记 pid（按这次 exec / callId），「停止此命令」只 `killProcessTree`。子进程退出后，官方 bash 的 `execute()` 自己返回（非零或 `aborted`），Harness 照常写 `tool_execution_end`。不是自写编排器。
3. 不要为了停一条命令去 `conversation.abort()`。
4. 停完后标签保持只读输出，文案按 interrupted；不要假装命令成功结束。

`SECURITY.md` 里写的 `INTERRUPTED — side effects unknown…` 是旧自写 bash 的文案。官方工具中断后由 Harness 写 interrupted 结果。Agent 标签应显示「已停止」，不要发明第二种中断语义。

并行 `bash`（同一助手回合里两个命令）时，按 `toolCallId` / `taskId` 分开杀。Pi Durable 工具模式有 parallel / sequential；实现时按实际 `taskId` 对准，不要「停一个等于停一轮」。

---

## 4. 安全（对照 `SECURITY.md`）

模型仍是：单用户本机 Agent，绑 `127.0.0.1`，不是多租户。

### 4.1 必须沿用的

- 只听 `127.0.0.1`。
- v2：`Authorization: Bearer <本机令牌>` 或 HttpOnly `weft_session`（`src/v2/auth.ts`）。`/api/v2/*` 在登录之后一律 `auth.isAuthorized`。终端接口走同一前缀，不要开新的未鉴权路径。
- Host allowlist、跨源 Origin 拒绝、变更方法的 JSON Content-Type、CSP 等响应头：现有中间件已经覆盖 `/api/v2`。
- SSE：浏览器带 cookie。若终端用 SSE 推输出，连现有 `GET /api/v2/events`（新 topic）即可，不必再发明 ticket。旧 `/api/sse-ticket` 是 v1 的。
- 若以后用 WebSocket：同样的 cookie / Bearer；Origin 必须同源；不要把长期令牌放进 query。CSP `connect-src 'self'` 覆盖同源 ws。

### 4.2 cwd 和工作区

- 用户终端 cwd = 当前工作区根；「在终端中打开」点在目录上则用该目录，且必须 `resolveInWorkspace` 成功。
- 工作区根本身仍受 `workspace-guard.mjs` 约束（不能是 `/`、`$HOME`、`~/.ssh` 等）。
- `cd /` 在真 PTY 里会成功（和今天 Agent bash 一样：没有 mount namespace）。缓解：提示符显示真实 cwd；可选阻止 chdir 到工作区之外（改 `PWD` 或包装 shell）。完整 OS 沙箱 `SECURITY.md` 已推迟，用户终端不要声称有沙箱。
- 用户终端 **不要** 用来跑 Agent 的 `bash`（画板写明 Agent 不进用户终端）。两套进程表，避免模型和用户抢同一个 PTY。

### 4.3 环境变量：文档和代码已经不一致

`SECURITY.md`「bash sandbox」写的是旧 `src/tools/workspace.mjs`：`PATH` 白名单、`HOME=<workspace>`、`TERM=dumb`，不继承 `WEFT_*` / `AWS_*` / `SSH_*`。

当前官方 bash 经 `createBashTool` → `prepareExecution` 默认 **`inheritEnv: true`**，`NodeExecutionEnv` 会 ` { ...process.env, ...extra }`。Weft 的 `WorkspaceExecutionEnv` 没有再洗一层环境。所以 **Agent bash 今天会继承服务进程环境（含可能的密钥）**。这是已有缺口，不是终端新引入的；用户终端那一单不要把它弄得更宽，Agent 流式那一单也不该假装白名单还在。

建议（可另开安全单，不堵终端）：

- Agent bash：`prepare` 里 `inheritEnv: false`，只给最小环境（对齐 SECURITY.md）。
- 用户终端：继承登录用户环境（和系统终端一样，git/ssh 才好用），但进程仍是 Weft 子进程。

### 4.4 用户终端比 Agent bash 更「敞」

用户终端是交互式、有 TTY、stdin 打开、通常继承完整环境。任意本机命令都能跑。可接受条件：

- 只有已经登录的本机浏览器能连上；
- 不能从工作区外的 cwd 起进程；
- 限制同时打开的数量（建议 ≤ 8），避免 fork 炸弹；
- 服务退出时杀掉所有 PTY（空闲退出、崩溃、主动停）。`createIdleWatcher` 的「有活」今天只看 Harness 任务 + HTTP/SSE 连接。浏览器开着时 SSE 会 `trackConnection`。浏览器关了但 PTY 还在：要把「有活 PTY」算进 `hasActiveWork`，否则 `weft open` 拉起的服务会在空闲计时后把用户的编译杀掉。
- PTY 不持久化、不进检查点、不进 SQLite。重启就没了。不要为终端自写一套检查点。

### 4.5 其它

- 输出体积：Agent 侧沿用 Harness 保留窗口 + spill。用户 PTY 自己做回滚上限（建议几十万字符），避免 SSE 把进程内存撑爆。
- 不要把 PTY 挂到局域网接口。`WEFT_ALLOWED_HOSTS` 已有「开着但没登录」的警告；终端接口不得在未授权时工作。
- 符号链接 TOCTOU（SECURITY.md finding 9）仍然在：用户在终端里 `ln -s` 之后，文件工具仍可能被绕。终端那一单不修这个。

---

## 5. 推荐方案和分单

```
浏览器右栏「终端」
  ├─ 用户标签  ──HTTP 开/关/输入/resize──► src/ 里的 PTY 宿主（@lydell/node-pty）
  │                 ◄── SSE topic terminal:<id) 或同一条 events 流
  └─ Agent 标签 ── 只读 ──► 现有 conversation topic
                              （补上 tool_execution_update）
```

传输：先不要上 WebSocket。本机 `127.0.0.1` 上，**SSE 出字节 + POST 进键和 resize** 够用，也合现在的 v2（HTTP 命令 + SSE 推送）。打字觉得钝再加同源 WS，鉴权规则相同。

### T51-10 Agent 命令标签（无原生依赖）

**范围**

- 右栏加「终端」标签（`RightTab` 加上 `'term'`），深浅色用 `--term`。
- 每个运行中的 `bash` 一个只读标签（标题用 command / intent；owner 用主 Agent 或子 Agent 名）。
- 接通 `tool_execution_update` → v2（新 `tool.delta` 或节流 upsert）。`npm run gen:contract`，`check:contract` 要过。
- 模拟后端能演实时输出；`npm run build:proto` 可点。
- 单测：`mapHarnessBatch` 增量；v2 主题把增量打到 tool 视图。相关 e2e / proto-smoke。

**不要做：** PTY、xterm、用户 `+` 终端、停止此命令、在终端中打开。

**风险：** 契约变更；`trimStart` 和客户端缓冲要对齐；高频 `npm test` 输出要节流。低风险：不引入原生模块。

### T51-11 停止此命令

**范围**

- 先写实测（单测或内核探针）：`abortTask(toolTaskId)` 会不会把父运行一起停掉。结论写进该单 PR。
- 按第 3.3 节接上右键 / 危险按钮。
- 停完：工具 `interrupted` 或失败；标签留着；整次对话若仍该跑就继续。
- 契约若需要 `POST /api/v2/conversations/{id}/tools/{toolId}/stop` 就加，鉴权同其它 v2 POST。
- proto 里跑一条长命令能停。

**不要做：** 用户 PTY；不要把这个按钮接到 `conversation.abort()` 除非实测证明 abortTask 不可用且杀 pid 也不可用（那就要停下来问）。

**风险：** 中等。杀 pid 和 Harness 对 abort 的处理可能打架（双杀、结果丢失）。必须走官方 `execute()` 结束路径。Windows 上 `taskkill /T` 和 Git Bash 进程树要对一下。

### T51-12 用户交互式终端 + 「在终端中打开」

**范围**

- 依赖：`@lydell/node-pty`（钉版本，PR 里说明镜像能装）、`@xterm/xterm`、`@xterm/addon-fit`。
- 服务：工作区内多块 PTY；`+` 新建；关闭即杀进程；cwd 默认工作区根。
- 壳：macOS/Linux `$SHELL` 或 zsh/bash；Windows 先 Git Bash（和 Agent 回退 PowerShell 的顺序一致，见 `workspace-env.mjs`），再 `pwsh` / `powershell`。
- 协议：v2 开/写/resize/关 + SSE 输出。复用会话鉴权。
- 「在终端中打开」：项目、文件树目录、项目芯片。
- `hasActiveWork` 把活着的 PTY 算进去。
- proto 用假 PTY（回显 + 几条内置命令）即可，浏览器里不要真 node-pty。
- 上限、工作区检查、服务退出时清理。

**不要做：** 重做 Agent 标签；不要让 Agent 往用户 PTY 里写。

**风险：** 最高。原生模块、Windows ConPTY、Git Bash 路径、xterm 主题、空闲退出误杀。第一版可以不支持真正的全屏 TUI 美化，但 PTY 必须是真的，这样 Ctrl+C 和颜色从一开始就对。

### 刻意不做（除非以后单独立项）

- 远程终端、把 PTY 接到手机客户端。
- 把用户终端写进 Harness 检查点。
- 给用户终端做 bubblewrap/nsjail。
- Agent 在用户终端里执行（和画板相反）。
- 为终端引入 WebSocket（第一版不需要）。

### 建议落地顺序

T51-10 → T51-11 → T51-12。10 没有原生风险，先让右栏「终端」有东西。11 依赖 10 的标签。12 独立，但 UI 应复用 10 的标签栏。

---

## 附录 A. 包检查摘要（脚本未提交）

环境：Cursor cloud agent 机，Node v22.23.4 linux x64，npm registry 为 registry.npmjs.org。内网镜像应能提供同样的 tarball 内容。

| 包 | 预编译在哪 | 安装时是否访问 GitHub | 无工具链时 Windows | 无工具链时本机 Linux |
|---|---|---|---|---|
| `node-pty@1.1.0` | 包内，仅 darwin+win32 | 否（预编译命中时） | 可以 | 否（会 node-gyp） |
| `node-pty@1.2.0-beta.18` | 包内，六平台 | 否（预编译命中时） | 可以 | 可以（已核对 prebuild.js=0） |
| `@lydell/node-pty@1.2.0-beta.18` | 各平台 optional 包内 | 否 | 可以 | 可以（已 spawn） |
| `@homebridge/node-pty-prebuilt-multiarch@0.14.1` | 包内仅 Linux ABI；其它走 prebuild-install | **Windows/macOS 会** | **否** | 可以（ABI 127 在包里） |

`@lydell/node-pty` 安装日志无 `github.com` / `prebuild-install` / `node-gyp`；`--ignore-scripts` 后 `pty.spawn("bash", …)` 仍打印 `ignore-scripts-ok`。

## 附录 B. 和当前代码的对照

| 点 | 位置 |
|---|---|
| 画板终端 | `design/claude/project/Main.dc.html`（约 555–575、1122–1131、1653–1655 行） |
| 右栏无终端 | `web/src/components/RightPane.tsx`，`web/src/data/layout.ts` `RightTab` |
| 事件丢掉 update | `src/kernel/events.mjs` `mapHarnessBatch` |
| 官方 bash | `src/kernel/tools.mjs` `createBashTool()`；cwd 检查在 `src/kernel/workspace-env.mjs` |
| 停整次对话 | `src/kernel/subagents.mjs` `stopConversation` → `conversation.abort(..., { background: true })` |
| v2 鉴权 | `src/v2/auth.ts`，`src/v2/index.ts` 对 `/api/v2` 的 `isAuthorized` |
| 主题 `--term` | `web/src/styles/themes.css` |
| SECURITY.md 环境白名单 | 与当前 `inheritEnv: true` 不一致，见 4.3 |

---

## 后记：用户决定

用户已决定**不做 Weft 内嵌的交互式终端**（不要 PTY、不要 xterm、不要右栏里自己敲命令的用户标签）。

只做「在系统终端中打开」：侧栏项目右键、右栏文件树的目录右键、输入框项目芯片菜单，一键在对应目录拉起本机 Terminal / Windows Terminal / 系统默认终端。Weft 服务只监听 `127.0.0.1`，浏览器和服务在同一台机器上，所以服务端 `spawn` 本机终端程序即可。路径必须落在当前工作区里。

接口：`POST /api/v2/workspaces/{id}/open-terminal`。macOS 可用 `WEFT_TERMINAL_APP` 换成 iTerm 等。评估里的用户 PTY 方案留作以后若需求回潮时的参考，不按这个后记实现。
