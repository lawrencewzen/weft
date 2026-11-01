# Weft

Web 编码工作台，内核是 Pi Durable（`@earendil-works/pi-durable` 的 Harness，`src/kernel/`），模型调用走 `@earendil-works/pi-ai`。项目规则、核心模型和文档索引见 `AGENTS.md`。审 PR 时检查有没有新的自写运行时、调度或检查点。

## 仓库与分支

- 仓库 `lawrencewzen/weft`。两条产品线（详见 `AGENTS.md`「产品线与分支」）：
  - `main`：通用功能，对外版（以后还有 macOS / iOS 原生客户端）。PR squash 合并。
  - `intranet`：内网 Windows 版（Windows 10、GBK、pwsh 7）。Windows 专门优化只进这里，不回 `main`。
- 同步只从 `main` 往 `intranet`：开 `main → intranet` 的 PR，用 merge commit 合并，不 squash。两条分支都有保护，必须走 PR、CI 全绿。
- 内网发布：在 `intranet` 打 `intranet-v*` tag，`release.yml` 出 Windows 解压即用包。

## 代码位置

- 入口 `server.mjs`、`bin/weft.mjs`；服务端在 `src/`（`core` / `kernel` / `store` / `v2`，第三方打包代码在 `vendor`）；前端源码在 `web/`，构建到 `public-next/`；插件在 `plugins/`、`examples/plugins/`。
- 接口契约 `contract/openapi.yaml`，改完 `npm run gen:contract`。
- 新增 `.mjs` 文件时加进 `package.json` 的 `check` 脚本。

## 验证

- 服务端：`npm run check`（语法）、`npm run check:contract`、`npm test`（`tests/unit`）。
- 前端：`npm run lint`、`npm run typecheck:web`、`npm run test:web`。
- e2e：Playwright（`tests/playwright.config.mjs`）。`proto-*.spec` 跑原型，先 `npm run build:proto`，不需要服务端。
- 本地只跑和改动相关的测试，全量交给 CI。

## 界面改动

先做可交互原型（`design/prototype/README.md`）：`npm run build:proto` 生成单文件 `design/prototype/index.html`，模拟后端在 `web/proto/mock/`，构建产物不入库。用户点着看过再合并。界面里不要过度的说明文字。

## 开发方式：调度，不自己写代码

开发需求（新功能、修 bug、重构）不要自己直接改代码，用 `/grokbot` skill：我负责理解需求、读代码、拆任务、写任务单、审 PR、合并。

- 前端（`web/`、原型、界面）→ 本地 agy；后端 / 代码（`src/`、server、CI）→ Bot「代码工程师」。任务单写明基准分支（`main` 或 `intranet`）和验证要求。
- 动手前先读台账 `~/.claude/grokbot-tasks.md`，接上之前的进度。
- 读代码、复跑测试只在 `~/.cache/claude-review/lawrencewzen/weft` 和 scratchpad 里做，不碰本工作副本。
- 出完方案等用户说「开始」再派活。上线部署、不可逆的数据操作、对外发布、明显花钱的事，先问用户。
