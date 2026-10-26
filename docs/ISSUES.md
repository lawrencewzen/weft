# 已知问题 / 待办

按「已确认要改 / 待定位 / 待定方案」分组。每条写现象、证据、涉及位置。

## 待定方案

### I-1 新窗口打开 `/` 会落到上次那条对话
- 现象：新开浏览器窗口打开服务地址，直接变成上一次的对话；在里面发消息等于续写旧对话，看起来像「跳到当前对话」。
- 证据：`web/src/components/AppShell.tsx:62-84`，根路径重定向到 `latest`；实测新窗口打开 `/` 后地址栏变成 `/c/<上次对话>`。
- 方案（未选）：① `/` 默认进新对话草稿（推荐，要改 `tests/e2e/default-entry.spec.mjs`）；② `weft open` 带 `?new=1` 才进草稿；③ 只加提示条。

### I-2 粘贴图片
- 现状：`web/src/components/Composer.tsx` 只有 textarea，没有 paste / drop / 附件；接口契约里没有图片字段。
- 设计：`design/paste/`（已确认）。
- 待定：单张大小 / 条数上限、只有图没字能否发、点开大图预览。

## 待定位

### I-3 真实模型下发送后要等一段才看到自己的消息
- 现象：回车后自己的消息和 Agent 回复都有可感知延迟。
- 证据：演示模型下实测「回车 → 我的消息上屏」83ms，`POST /messages` 返回 202 16ms，本地链路不慢；怀疑服务端 `postMessage` 里 `prepareSend` / `routes.modelFor` / `conversation.submit` 到首个内核事件的耗时。
- 下一步：加四段计时日志（POST 进入 → submit 返回 → 首个内核事件 → 首次快照推送），在真实环境取数。
- 已做：前端乐观发送 + 「思考中」行（本 PR）。

### I-4 连续发送没有进 Steer，也没有 steer 的显示
- 现象：run 正在跑时再发一条，没有按 steer 生效，界面上也看不出这条消息进的是队列还是 steer。
- 证据：服务端 `src/kernel/conversations.mjs:503` 提交时用的 `whenBusy: 'steer'`，但前端没有对应状态；`web/src/components/Composer.tsx` 的 `composer_placeholder_running`（「补充说明，Agent 会在下一步读到」）是唯一提示。
- 下一步：先复现（run 中连发两条，看内核事件里有没有 steer 记录），再定 UI：入队态 / 已读态 / 取消。

## 已知缺陷（AI 行为 / 卡住）

### I-5 工具调用没有超时，run 会无限期 running
- 现象：对话 `803950aa`（weft 工作区）卡在 `pendingText: 跑单元测试` 20 分钟以上。
- 证据：`ps` 里 `npm test`（pid 41496）7:33 起一直在跑，两个 `node --test` 子进程 CPU 占用 0；该对话跑在 worktree `/tmp/weft-p5`，`public/vendor` 不存在（没跑 postinstall），测试挂起后工具调用一直不返回。
- 影响：run 永远 `running`，`canStop` 有但没有任何自动兜底提示。
- 位置：`src/v2/stream/stuck-watch.ts` 只做显示判定，不处理工具超时；工具执行没有 `timeoutMs`。

### I-6 卡住检测不提示用户
- 现状：`stuck-watch` 只给视图用，界面「运行中」没有任何「可能卡住」的降级提示（例如「已 20 分钟没有进展」）。
