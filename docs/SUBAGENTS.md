# Sub-agents

Sub-agents follow Pi Durable's Abort and Subagents section and examples 22 (foreground) and 23 (background). The Harness owns the child conversation, its submission, abort, and restart reuse. Weft configures a self-contained child from the prompt text plus fixed no-ask instructions (no role template, no preamble, rules, or skills; it does get the `environment` and `project_context` sections) and reads what the tools already committed. The child cannot ask the user questions; if it cannot finish, it ends and reports to the main agent.

A conversation has one main agent (`agents[0]`, `name: 'Agent'`). It does not set `instructions`: `configure` passes `null`, which clears the stored field, including an empty string left from earlier, so no instructions section is rendered. The system prompt is Pi Durable sections in order: untagged preamble, `rules`, `environment`, `project_context`, and `skills`. Extra agents are sub-agent instances spawned with the `task` tool, each in its own Harness conversation. The host does not rotate agents in the same chat. The child cannot see the parent conversation or the parent's instructions; everything it needs goes in `prompt`. The child prompt has `environment`, `project_context`, and the fixed no-ask `instructions`, and does not have preamble, rules, or skills.

`GET /api/conversations/:cid` returns the main agent chip (`agents` without `mode`) first. Real sub-agent instances are appended after that chip.

## Tool: `task`

The main agent has the `task` tool (which replaces both former `delegate` and `subagent` tools with a unified interface) plus `skill`. Children are configured with the `weft-tasks` extension removed (`extensions.remove`), so they cannot call `task` or load skills (single layer only).

The entire `task` tool is declared `replay: 'safe'`.

### Dispatch (default)

- **Parameters**:
  - `description` (required, string): 3–5 words in the user's language describing what the task does. Shown as heading in the UI (`agent.title`) and used to derive a short task id (e.g. `fix-login-test`, with `-2` suffix on collision).
  - `prompt` (required, string): Self-contained task instructions.
  - `run_in_background` (optional, boolean, default `false`):
    - `false` (Foreground): Waits for the child conversation to finish and returns the child's final assistant reply verbatim. The child is owned by `{ kind: 'task', taskId: api.taskId }`, reattaches on rerun via `ownerTaskId: api.taskId`, and submits with `requestId: task:<taskId>`.
    - `true` (Background): Owned by `app.weft.task-anchor` (`TaskAnchor`), driven by `app.weft.task-reporter` (`TaskReporter`), registered in `app.weft.tasks` (`TasksDoc`). Immediately returns the short task `id`. When the child finishes, `TaskReporter` delivers the result back to the main conversation as a follow-up input: `[task <id> completed, no reply needed] <body>` (or `[task <id> failed: <reason>]`). Start and deduplication are recorded in `TasksDoc.calls[api.taskId]` in a single atomic commit; the reporter uses `task-input:<reporterId>` and `task-report:<reporterId>`.

### Background Management

When managing background tasks only, `action` specifies the operation:
- `action: 'send'`: Appends a message to a running background task (`id`, `message`). Deduplicated via `TasksDoc.calls[api.taskId]`.
- `action: 'wait'`: Waits for a background task (`id`) to finish and returns its final answer.
- `action: 'stop'`: Stops a running background task (`id`).
- `action: 'list'`: Lists all background tasks and their statuses.

### Outcome & Termination

The former `STATUS: done / incomplete` convention is completely removed. Success or failure is determined solely by how the child conversation ends:
- **Normal completion**: Returned verbatim as the tool result (foreground) or delivered via `[task <id> completed, no reply needed]` (background).
- **Execution error**: Returned with `isError: true` and child status marked `failed`.
- **Stopped by user**: Aborting a child returns `[task <id> stopped]` (non-error) to the main agent so the parent turn continues; sub-agent status becomes `stopped`. Aborting the main conversation stops all tasks (including background anchors via `conversation.abort(context, { background: true })`).

## HTTP

```bash
curl -sS http://127.0.0.1:3000/api/conversations/<cid>
# → agents: main Agent chip, then
#   {id, name, status, step, totalSteps, toolCalls, lastText, mode,
#    toolCallId,
#    brief?, startedAt?, lastActivityAt?, endedAt?, currentAction?}
#   id is <cid>:sub:<child conversation id>
#   mode is foreground | background
#   toolCallId is the parent task ToolCall.id, or null when unknown
#   brief is the first user message (the dispatched prompt)
#   startedAt / lastActivityAt / endedAt are pi-ai timestamps in ms
#   endedAt only when done / stopped / failed; currentAction only while running
#   missing timestamps or text omit that field

curl -sS http://127.0.0.1:3000/api/conversations/<cid>/agents/<aid>/messages
# → {id, name, status, mode, messages}

curl -sS -X POST http://127.0.0.1:3000/api/conversations/<cid>/agents/<aid>/messages \
  -H 'content-type: application/json' -d '{"text":"改用 pnpm"}'
# → 200 {ok:true}  子 Agent 须 running；空文本 400，未知 404，非运行 409

curl -sS -X POST http://127.0.0.1:3000/api/conversations/<cid>/agents/<aid>/stop
# → 200 {status:stopped}  只停这一个子对话，主 Agent 和其他子 Agent 继续

curl -sN -H 'Accept: text/event-stream' \
  http://127.0.0.1:3000/api/conversations/<cid>/events
# event: agent   data: same fields as the chip, including mode and the optional
#   brief / startedAt / lastActivityAt / endedAt / currentAction fields
```

`POST .../agents/:aid/messages` 把用户的话 `steer` 进该子对话，并给主对话写一条 `app.weft.user-to-subagent`（带 model 的 write，不新开一轮）。主对话 GET 的 `messages` 把它映射成 `role:'note'`，文案是「你对 <名字> 说：<text>」。子 Agent 自己的记录里仍是普通 user 消息。子 Agent 只有一层，上级一律是主对话。

The list is rebuilt from the Harness after a process restart: tool-result `details.conversationId`, the ownership index, the background tasks document, and each child's `viewState`. Child transcript events stay on the child conversation; the parent SSE does not mix in `message.delta` / `tool.*` from the child.

## Demo (faux)

From the repo root, Node 22:

```bash
export PATH=$HOME/.local/node22/bin:$PATH
PORT=3000 WEFT_LLM=faux WEFT_FAUX_SCRIPT=examples/faux/subagents.json node server.mjs
```

Create a workspace and a conversation, then send a message that causes the main agent to call `task`.

`start()` does not overwrite a title the client already set. The first user message becomes the title only when the current title is empty or `New conversation`.
