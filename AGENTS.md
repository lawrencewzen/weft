# 协作规则（Weft）

Weft 是基于 Pi Durable（@earendil-works/pi-durable，作为库嵌入）的 Web 编码工作台。目标运行环境：内网 Windows，Node 22。

## 内核（硬性规定）
- 运行时内核必须是 Pi Durable（`@earendil-works/pi-durable` 的 Harness）：对话、任务、检查点、断点续跑、子 Agent、中止、压缩都用它提供的机制，模型调用走 `@earendil-works/pi-ai`。
- 禁止自写编排器、任务调度或检查点机制来替代 Pi Durable 已有的能力。Pi Durable 做不到、需要绕开或改换内核的，必须先停下来报告，经用户同意后才能动。
- 现状（2026-10-20，T12-2）：默认运行时已经是 Pi Durable Harness（`src/kernel/`）。对话状态只在 Harness 里，应用库只留最近一次提交的 id。卡住和重试只用它的 `stream.timeoutMs` 和 `retry`。流中途没数据由 `src/kernel/stream-idle.mjs` 的 fetch 包装判定（`WEFT_STREAM_IDLE_TIMEOUT_MS`，默认 120000，只从响应开始后算），超时只抛错，重试仍走 `retry`。google-generative-ai、google-vertex、bedrock-converse-stream 不接受自定义 fetch，不在覆盖范围内。没有 harness id 的旧对话不出现在列表里。
- 改动架构（内核、存储、模型调用层）属于需用户确认的决定；`docs/ARCHITECTURE.md` 必须如实反映现状，不能为了贴合代码就悄悄改掉原定架构。
- v2（2026-10-25 定，见 `docs/ARCHITECTURE_V2.md`）只重做服务端对外的一层（协议、视图模型、服务进程、鉴权）和客户端，内核规定一条不变：对话和任务怎么跑全部交给 Pi Durable。v2 里的卡住判定定时器、SSE 事件缓存只服务于显示和进程管理，不调度、不存检查点；服务不因空闲自动退出。以后通过 Provider 接外部 agent，也必须用 Pi Durable 的 Task 实现。

## 核心模型
- **工作区（Workspace）** > **对话（Conversation）** > **主 Agent（Main Agent）** > **子 Agent（Sub Agents）**。
- 每个对话默认只有一个主 Agent：理解需求、拆任务、管理子 Agent、汇总结果；简单对话不派子 Agent。主 Agent 没有角色，也不设 `instructions`（`null` 清除该字段，已存的空字符串在下次配置时清掉，不渲染空的 instructions 段）；系统提示词是 Pi Durable section，顺序为 preamble（不带标签）、rules、environment、project_context、skills。preamble 和 rules 是固定短文案。environment 写实际工作目录、平台和 shell；没选项目时不写工作目录。project_context 只收录工作区根目录的 AGENTS.md，没有、为空或读失败就整段省略。子 Agent 没有 preamble、rules 和 skills，有 environment、project_context，以及原来的固定 instructions。
- 子 Agent 是主 Agent 用 `delegate` / `subagent` 在某个对话里生成的独立实例，只属于该对话。没有固定角色模板。
- 需求支持断点续跑、自动继续、状态监控、多 Agent 并行。多 Agent 协作由主 Agent 用子 Agent 派活，宿主不轮换 Agent。

## 产品线与分支
- 两条产品线：对外版（完整生态，后续有 macOS / iOS 原生客户端）和内网 Windows 版（网页前端 + WebView2 桌面壳，适配内网 Windows 10、GBK、pwsh 7）。
- `main`：两条线都要的通用功能在这里开发，PR 合到 `main`。
- `intranet`：内网 Windows 版。只为内网 Windows 机器做的优化（PowerShell 执行、GBK 编码、自检等）只进这里，PR 合到 `intranet`，不回到 `main`。
- 同步方向只有一个：定期把 `main` merge 进 `intranet`，不反向合并，不挑单个提交。
- 内网版的桌面壳在 `desktop/win/`（WinForms + WebView2，net48，只负责拉起服务和承载窗口，不含业务逻辑），由 `release.yml` 编译后打进 zip 根目录的 `Weft.exe`。
- Windows 专门的代码尽量放在独立文件（如 `src/platform/win/`），原有文件只留少量接入点，减少同步时的冲突。
- 内网发布：在 `intranet` 上打 `intranet-v*` tag，`release.yml` 出 Windows 解压即用包。

## 文档
- 计划与设计：`docs/PLAN.md`、`docs/ARCHITECTURE.md`、`design/`。接口契约以测试仓库的 `docs/API_CONTRACT.md` 为准。
- Pi API 以 `node_modules/@earendil-works/*/dist/**/*.d.ts` 和 `node_modules/@earendil-works/pi-durable/README.md` 为准，不凭记忆编 API。
- v2 目标架构：`docs/ARCHITECTURE_V2.md`（迁移中）。迁移期间旧接口 `/api/*` 保持可用；网页端只有新端（`web/` 构建到 `public-next/`，挂在 `/`）。旧前端已在 T47-1 删除，`/legacy` 302 回 `/`。新功能做在 `/api/v2` 和新网页端。
- 可交互网页原型：`design/prototype/README.md`。`npm run build:proto` 生成单文件 `design/prototype/index.html`（不入库），模拟后端在 `web/proto/mock/`；改界面先出原型给用户确认。

## 分工
- **编排者（总指挥）**：拆分任务、合并分支、最终亲手验收（默认用测试结果证明，确实需要看画面时另行说明），只有编排者往 `main` 合并。
- **Coder**：在 `backend`（或编排者指定的功能分支）上开发，可以提交并推送自己的分支，**禁止提交或推送 `main`**。
- **测试**：单元测试、`tests/e2e/` 验收用例的编写和执行都交给 cloud agent。可以由写代码的同一个 agent 在同一个 PR 里完成，也可以另派 agent 单独验证，由编排者按任务决定。
- **Auditor**：独立 Agent，只做代码审计与报告，不直接改代码。
- **设计**：Antigravity（`--model gemini-3.8-flash-high`）出设计稿；设计稿和架构由用户确认。

## 模型调用

只有显式要求时才走本地剧本：`WEFT_LLM=faux`、`LLM_API=faux` 或设置了 `WEFT_FAUX_SCRIPT`，界面要标出「演示模型」。未显式要求时，有 API Key 或 Base URL 才调用真实模型；都没有则拒绝回复，不能回落到剧本。

## 验证
- `npm run check`：语法检查。
- `npm run lint`：前端 ESLint（web/src 与 web/proto）。
- `npm test`：`tests/unit` 单元测试。Linux CI 的 `test` job 和 Windows 的 `kernel-unit` 跑这一套。
- `npm run test:e2e`：Playwright 自动化子集（`tests/e2e/*.spec.mjs`），配置 `tests/playwright.config.mjs`。先装浏览器：`npx playwright install chromium`；CI 用 `npx playwright install --with-deps chromium`。用例自己起服务，走演示模型（`WEFT_LLM=faux`）。系统 Chrome 可设 `WEFT_CHROME`（例如 `/usr/bin/google-chrome`）。默认用测试结果证明，确实需要看画面时另行说明。Linux CI 的 `e2e` job 跑这一套；Windows job 不跑 e2e。手工验收清单仍是 `tests/e2e/*.md`。

## 约束
- 只改任务范围内的文件；新增依赖需说明理由。保持原生 ESM。
- 不读取、不打印 `.env` 和密钥；不访问未授权的远程服务器。
- 交付前运行 `npm run check`、`npm test` 及适用的本地验证；交付时列出改了哪些文件、怎么验证的、哪些没验证。
- UI 风格：简洁、低饱和；效果图一律 4K。
- 前端品牌图标来自 `@lobehub/icons-static-svg`（MIT），构建时由 `web/vite.config.ts` 拷到 `public-next/vendor/brand-icons/`。品牌映射数据由 `scripts/gen-brand-data.mjs` 从 `@lobehub/icons` 生成到 `src/v2/views/brand-data.json` 并提交；不要把 `@lobehub/icons`（React 组件包）加进 dependencies 或 devDependencies，也不要走 CDN。

