# 发送即时反馈（设计稿）

`pending-send.html` 一页三态，双击直接看（单文件，不依赖服务端）。三块都是真实网页端渲染，只有「我的消息」和「思考中」两处是这次要加的东西。

| 状态 | 界面 | 说明 |
| --- | --- | --- |
| ① 回车瞬间 | 我的气泡 + `思考中` | 服务端还没回，顶栏仍是「完成」。这两样都是本地状态，不依赖任何请求 |
| ② 服务端已确认 | 同上 + 顶栏「运行中 · 思考中 · 0:01」、停止按钮、侧栏「运行中」 | run 真在跑但还没产出，仍然只有一行「思考中」 |
| ③ Agent 出内容 | 工具记录（`✓ 改了 xxx.md`）+ 回复气泡 | 「思考中」消失，交回现有的消息 / 工具记录渲染 |

## 规则

- **我的消息先上屏**：按下回车立刻插入气泡，和确认后的气泡长得一模一样（同底色同圆角），不灰化、不加虚线，避免「是不是没发出去」。
- **输入框立刻清空**；请求失败时把文字塞回输入框，并复用现有 `composer-error` + 重试（同一个 requestId，幂等）。
- **`思考中` 不是气泡**：左对齐一行，12px 细灰环 spinner + 13px `--mute` 文字，和 assistant 消息同列、无背景无边框。
- **出现条件**：本地有未确认消息，或 `run.status === 'running'` 且 thread 最后一项是用户消息。
- **消失条件**：Agent 出了文字、或出了工具记录、或 run 结束。
- **重复文本**：同一条消息发两次时，用「已确认的同文本条数」配对，旧消息不会把新消息的 pending 顶掉。

## 代码落点（已按此实现，待验收）

- `web/src/data/pendingSend.ts`：`countUserText` / `settlePending` / `pendingItem` / `waitingForAgent`（纯函数，已带单测 `pendingSend.test.ts`）
- `web/src/data/usePendingSend.ts`：乐观发送 + 收敛 hook
- `web/src/components/Thread.tsx`：`pending` 属性渲染 `思考中` 行
- `web/src/components/Composer.tsx`：先清空后请求，失败回填
- `web/src/styles/app.css`：`.thread-pending`

## 还没做

- 失败态的气泡标记（现在失败是移除气泡 + 输入框回填 + 顶栏错误条）
- 顶栏和 thread 里同时出现「思考中」的重复问题：工具跑起来后 thread 行会消失，只有「还没有产出」这一小段时间两处都在，暂时保留
- 新窗口打开 `/` 会跳到上次对话那个 bug 还没修（等你选方案）
