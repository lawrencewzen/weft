# 配置参考（当前 main）

本页列出当前主分支会读的环境变量。部署方式见 [本地/内网 Windows 部署](DEPLOYMENT.md)。请先按 [快速开始](GETTING_STARTED.md) 确认项目可启动，再填写真实凭据。

## 对话运行（Pi Durable）

对话层把下面的变量交给 Harness，不再自写看门狗或自动续跑。应用库的 `last_submission_id` 只保存最近一次 `submit` 的 id；状态用 `harness.submission(id).status()` 读，不扫描 Harness 的库文件。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WEFT_RETRY_MAX` | `5` | 一次模型调用的尝试次数，含第一次。Harness 的 `maxRetries` 是这个数减 1 |
| `WEFT_RETRY_BASE_MS` | `200` | 重试退避的起始毫秒。上限沿用 Pi Durable 的 `maxAgentDelayMs`（60000） |
| `WEFT_STREAM_TIMEOUT_MS` | `120000` | 传给模型流的 `stream.timeoutMs`。超时后按上面的 retry 重试 |
| `WEFT_BASH_TIMEOUT_SECONDS` | `600` | bash 工具没拿到 `timeout` 参数时的上限（秒）。模型自己传了就照用；非法值回退默认；超过官方上限（`2147483.647` 秒）按上限算 |
| `WEFT_BASH_ENV_ALLOW` | 空 | Agent 执行命令时，在内置白名单之外额外放行的服务进程环境变量。逗号分隔，名字可带结尾 `*`（例如 `MY_APP_*,CI`）。Windows 上名字不区分大小写。变量本身不传给命令。`WEFT_*` / `LLM_*` / 各云厂商密钥前缀，以及名字里含 `KEY` / `TOKEN` / `SECRET` / `PASSWORD` 的项即使写在这里也会被挡住并打日志，不能靠它显式放行密钥。详见 [SECURITY.md](../SECURITY.md)「bash sandbox」 |

演示模型只在显式设置 `WEFT_LLM=faux`、`LLM_API=faux` 或 `WEFT_FAUX_SCRIPT` 时启用。剧本里一段文字紧跟工具调用时合成一条助手消息；一段文字后面没有工具调用时这一轮结束。`WEFT_FAUX_HOLD=1` 让这次调用等到流超时或被中止。

## 环境变量

| 变量 | 默认 / 示例 | 说明 |
| --- | --- | --- |
| `LLM_API` | `openai-completions` | 可选 `openai-completions` / `openai-responses` / `anthropic-messages` / `faux` |
| `LLM_BASE_URL` | 空 | 实际服务商提供的 API 基础地址；faux 不需要 |
| `LLM_API_KEY` | 空 | 实际 API Key，不提交到 Git |
| `LLM_MODEL` | 空 | 模型 ID，须与 API 类型及服务商匹配 |
| `LLM_CONTEXT_WINDOW` | `128000` | 提供给模型目录的上下文窗口配置，并非真实配额保证 |
| `LLM_MAX_TOKENS` | `8192` | 模型目录的最大输出 token 配置 |
| `DEMO_PASSWORD` | 空 | HTTP Basic Auth 密码；生产模式必须配置，用户名固定 `demo` |
| `NOTIFY_WEBHOOK_URL` | 空 | 通用 Webhook 或飞书机器人的完整 URL，含签名时视为敏感凭据 |
| `NOTIFY_WEBHOOK_KIND` | `generic` | `generic` JSON / `feishu` 文本机器人 |
| `NOTIFY_MODE` | `errors` | `errors`：仅明确失败的后台任务；`all`：也发成功/提醒/计划触发；`off`：不发送 |
| `ENABLE_CRASH_DEMO` | `0` | 生产模式是否开放 `POST /api/crash`；正式服务应保持 `0` |
| `OBSIDIAN_ROOT` | 空 | 只读 Obsidian 仓库根目录。留空时知识库工具会说明未启用，不影响聊天 |
| `OBSIDIAN_ALLOW` | 空 | 额外允许的相对路径，用英文逗号分隔。默认已包含 AI学习、X灵感、VPS小白教程 |

另外，`PORT`（默认 `3000`）和 `WEFT_DATA_DIR`（默认仓库下的 `data/`）在代码中读取；它们不是当前示例 `.env.example` 的主要部署配置。

## v2 服务进程

| 变量 | 默认 / 示例 | 说明 |
| --- | --- | --- |
| `WEFT_LAUNCHED_BY` | 空 / `weft-open` | 启动器拉起服务时设为 `weft-open`，这时才启用空闲退出。手动 `npm start` 不要设。 |
| `WEFT_IDLE_EXIT_MINUTES` | `30` | 空闲多久后自行退出。可以是小数方便测试；`0` 表示不退出。只在 `WEFT_LAUNCHED_BY=weft-open` 时生效。 |
| `WEFT_STDIN_EXIT` | `0` | **只给测试用。** 设为 `1` 时 stdin 关闭会走和 SIGTERM 相同的 `shutdown()`（Windows 收不到 SIGTERM）。 |
| `WEFT_V2_WEB_CODE_TTL_MS` | `60000` | **只给测试用。** `weft open` 申请的网页端一次性登录码有效期（毫秒）。不影响启动时打印的那枚码。 |
| `WEFT_V2_STARTUP_CODE_TTL_MS` | `600000` | **只给测试用。** `npm start` 在 `WEFT_READY` 之后打印的那枚登录码有效期（毫秒）。默认 10 分钟，只能用一次。 |
| `WEFT_V2_VALIDATE` | `0` | 设为 `1` 时按 OpenAPI 契约校验 `/api/v2` 响应；不一致则记日志并返回 500。测试默认打开。 |
| `WEFT_SUBAGENT_STUCK_MS` | `60000` | **只给测试用。** 子 Agent 处于 running 且超过该毫秒数没有活动时，服务端把 status 改成 stuck 并推送。默认与旧前端 60000 一致。 |
| `WEFT_MAIN_STALL_MS` | `180000` | 主对话处于 running 且超过该毫秒数没有任何动静时，服务端把 `RunState.stalledSince` 设为 `lastActivityAt` 并推送。默认 3 分钟。 |
| `WEFT_EXPECT_PROTOCOL` | 空 / `3.0.0` | **只给测试用。** 覆盖 `weft` 命令行认为的协议版本（默认与 `PROTOCOL_VERSION` 相同），用来测版本不兼容时的 restart。只影响命令行，不影响服务端。 |
| `WEFT_PROBE_TIMEOUT_MS` | `3000` | **只给测试用。** `weft` 探测 GET `/api/v2/service` 的超时（毫秒）。只影响命令行，不影响服务端。 |
| `WEFT_TERMINAL_APP` | `Terminal` | macOS 上「在终端中打开」传给 `open -a` 的应用名。例如 `iTerm`、`iTerm2`。只影响 macOS。 |
| `WEFT_TERMINAL_MOCK` | 空 | **只给测试用。** 设为 `1` 时不真正 spawn 终端；设为文件路径时把将要执行的 command/args 写成 JSONL 后同样跳过 spawn。 |

### 最小可运行配置

**无模型的本地演示：**

```bash
LLM_API=faux npm run dev
```

**接实际模型：**

```dotenv
LLM_API=openai-completions
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=YOUR_OWN_KEY
LLM_MODEL=your-model-id
```

请用真实供应商参数替换占位符。该项目通过显式提供 `baseUrl` 和 API 协议类型接入模型，**不能保证所有 OpenAI 兼容中转都支持图像、工具或相同的模型字段**。供应商不支持的能力不要默认当作项目已支持。

### 生产部署最低配置

```dotenv
DEMO_PASSWORD=REPLACE_WITH_A_STRONG_RANDOM_PASSWORD
LLM_API=openai-completions
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=YOUR_OWN_KEY
LLM_MODEL=your-model-id
ENABLE_CRASH_DEMO=0
```

本地/内网按 [DEPLOYMENT.md](DEPLOYMENT.md) 用 `npm ci` 和 `npm start` 部署。服务只绑定 `127.0.0.1`。

## 运行模式与可选通道

**通知：**不配置 `NOTIFY_WEBHOOK_URL` 时后台任务照常进行，只是不会主动向手机或飞书群发送事件。主分支的 Webhook / 飞书仍是尽力发送：**没有持久通用 Outbox**；出错可能丢失消息。Webhook 对端应按 `X-Pi-Event-ID` 去重。

**笔记检索：**设置 `OBSIDIAN_ROOT` 后，助手只能只读检索白名单笔记，回答带来源路径和行号，不会写回 Obsidian。默认只开放 AI学习、X灵感、VPS小白教程；财务、个人档案和服务器资产不在范围内。

## 安全建议

- 不提交 `.env`、服务商 Key 和包含鉴权信息的日志。
- 项目是单用户原型，不提供多租户隔离、SSO 或多用户权限矩阵；尽量只通过自己控制的 HTTPS 入口访问。
- 模型费用可能产生在供应商/中转平台；**项目内 `cost: 0` 占位不等于免费**，建议在上游平台设置预算和额度限制。
- 只下载/接入信任的模型或服务地址；不要把私有文件附件发送给不信任的模型提供商。
- 对持久化 SQLite 进行一致性备份；参考 [部署手册](DEPLOYMENT.md)。

[返回 README](../README.md) · [故障排查](TROUBLESHOOTING.md)
