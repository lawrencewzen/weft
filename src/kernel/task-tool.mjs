// Unified foreground and background subagent dispatch (`task`), built on Pi Durable 1.4+.
// Foreground calls own a child conversation via the tool task (`ownership: { kind: 'task' }`)
// so crash-replay reattaches to the same child and `requestId`. Background calls own their
// child via an immediate background `TaskAnchor` on the parent conversation and deliver/report
// through a background `TaskReporter`, recording call results in `TasksDoc.calls[api.taskId]`
// so `replay: 'safe'` never double-spawns or double-sends.
import { bool, lit, obj, opt, str, union } from '@earendil-works/pi-schema';
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
} from '@earendil-works/pi-durable';
import { textOf } from './events.mjs';
import {
  EXT_TASKS,
  TASK_ANCHOR_KIND,
  TASK_REPORTER_KIND,
  TASKS_DOC_KIND,
} from './ids.mjs';
import { formatSubagentReport } from './subagent-report.mjs';

export const TASK_TOOL_NAME = 'task';

export const TASK_DESCRIPTION = [
  'Launch a self-contained subagent to handle an independent task, or manage a running background task.',
  'Do simple, quick work yourself; use `task` for independent work or when multiple subtasks can run in parallel (issue multiple `task` calls in one turn to execute them concurrently).',
  'To dispatch a task, omit `action` and pass `description` (a short 3-5 word heading in the user\'s language, no file path) and `prompt` (complete instructions: what to do, where, when done, and what to report back).',
  'The subagent cannot see this conversation or ask the user questions, so put all needed context in `prompt`.',
  'Set `run_in_background: true` to start a background task and get its short `id` immediately; its final reply is delivered later as a follow-up message.',
  'To manage background tasks, pass `action` (`"send"`, `"wait"`, `"stop"`, or `"list"`), `id` (required for send/wait/stop, optional filter for list), and `message` (required for send).',
].join(' ');

const DESCRIPTION_PARAM_HELP = 'Short 3-5 word summary in the user\'s language saying what this task will do (no file path). Required when dispatching a task.';
const PROMPT_PARAM_HELP = 'Complete, self-contained instructions for the subagent: goal, relevant paths/context, completion criteria, and expected report. Required when dispatching a task.';
const BACKGROUND_PARAM_HELP = 'When true, run the task in the background, return its short id immediately, and deliver its reply later.';
const ACTION_PARAM_HELP = 'Management action for background tasks only: "send", "wait", "stop", or "list". Omit when dispatching a new task.';
const ID_PARAM_HELP = 'Background task id returned when starting a background task. Required for send/wait/stop; optional filter for list.';
const MESSAGE_PARAM_HELP = 'Follow-up instruction to send to a background task when action is "send".';

const TASK_ID_MAX = 24;

export const TasksDoc = defineDoc({
  kind: TASKS_DOC_KIND,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ tasks: {}, calls: {} }),
});

function messageText(message) {
  if (!message) return '';
  if (typeof message === 'string' || Array.isArray(message)) return textOf(message);
  return textOf(message.content);
}

function normalizeDescription(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function isIdTaken(taken, candidate) {
  if (!taken) return false;
  if (taken instanceof Set) return taken.has(candidate);
  if (typeof taken === 'object') return Object.hasOwn(taken, candidate);
  return false;
}

/** Generate a short task id from `description`, deduplicating against `taken` (`-2`, `-3`, ...). */
export function taskIdFromDescription(description, taken = {}) {
  const slug = String(description ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TASK_ID_MAX)
    .replace(/-+$/g, '');
  const base = slug || 'task';
  if (!isIdTaken(taken, base)) return base;
  let suffix = 2;
  while (isIdTaken(taken, `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function reply(text, extra = {}) {
  return {
    output: [{ type: 'text', text }],
    ...(extra.details ? { details: extra.details } : {}),
    ...(extra.isError ? { isError: true } : {}),
  };
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

async function assistantEntryText(api, entryId, context) {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, entryId), context);
  return messageText(entry?.model?.[0]);
}

async function readChildState(api, conversationId, context) {
  const childLive = await api.snapshot(LiveDoc, conversationId, context);
  const { generation, lastText } = await api.commit(async (tx) => {
    const genPage = await tx.scanTasks(
      { conversationId, kind: 'pi.generation', order: 'descending' },
      1,
    );
    const entriesPage = await tx.scanEntries(
      { conversationId, order: 'descending' },
      40,
    );
    let text = '';
    for (const entry of entriesPage.items) {
      const msg = entry.model?.[0];
      if (msg?.role === 'assistant') {
        const candidate = messageText(msg);
        if (candidate) {
          text = candidate;
          break;
        }
      }
    }
    return { generation: genPage.items[0], lastText: text };
  }, context);
  return { childLive, generation, lastText };
}

function idleTaskStatus(childLive, generation) {
  const outcome = generation?.state?.outcome;
  if (outcome?.status === 'aborted' || childLive?.runFailure?.reason === 'aborted') {
    return { status: 'stopped', detail: '' };
  }
  if (
    outcome?.status === 'failed'
    || outcome?.status === 'faulted'
    || outcome?.status === 'orphaned'
    || childLive?.runFailure
  ) {
    const detail = outcome?.error?.message
      || outcome?.reason
      || childLive?.runFailure?.detail
      || childLive?.runFailure?.reason
      || 'failed';
    return { status: 'failed', detail: String(detail) };
  }
  return { status: 'idle', detail: '' };
}

const TaskAnchor = defineTask({
  name: TASK_ANCHOR_KIND,
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, taskContext) => runtime.commit(
      () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
      taskContext,
    ),
  },
  abort: (_task, runtime, taskContext) => runtime.commit(
    () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
    taskContext,
  ),
});

const TaskReporter = defineTask({
  name: TASK_REPORTER_KIND,
  version: 1,
  initial: () => ({ phase: 'deliver' }),
  phases: {
    deliver: async (reporter, runtime, taskContext) => {
      const { id, conversationId, message, followUp } = reporter.input;
      const child = await runtime.conversation(conversationId, taskContext);
      if (!child) throw new Error(`missing task conversation ${conversationId}`);
      const submission = await child.submit({
        type: 'input',
        content: message,
        whenBusy: followUp ? 'followUp' : 'steer',
        requestId: `task-input:${reporter.id}`,
      }, taskContext);
      const settled = await submission.wait(taskContext);
      await runtime.commit(async (tx) => {
        const next = (report) => ({
          status: 'running',
          checkpoint: { phase: 'report', ...(report === undefined ? {} : { report }) },
        });
        if (settled.status === 'unanswered') {
          if (settled.reason === 'aborted') return next(undefined);
          const detail = typeof settled.detail === 'string' && settled.detail
            ? settled.detail
            : settled.reason;
          return next(formatSubagentReport({ name: id, kind: 'failed', body: detail }));
        }
        if (settled.status === 'done' && settled.type === 'input') {
          const state = await tx.doc(TasksDoc, runtime.conversationId);
          const task = Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined;
          if (!task || task.reported.includes(settled.answer)) return next();
          task.reported.push(settled.answer);
          const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
          const text = messageText(answer);
          return next(formatSubagentReport({ name: id, kind: 'answered', body: text }));
        }
        return next();
      }, taskContext);
    },
    report: async (reporter, runtime, taskContext) => {
      const report = reporter.state.checkpoint.report;
      if (report !== undefined) {
        const main = await runtime.conversation(runtime.conversationId, taskContext);
        if (!main) throw new Error('missing parent conversation');
        await main.submit({
          type: 'input',
          content: report,
          whenBusy: 'followUp',
          requestId: `task-report:${reporter.id}`,
        }, taskContext);
      }
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        taskContext,
      );
    },
  },
  abort: (_reporter, runtime, taskContext) => runtime.commit(
    () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
    taskContext,
  ),
});

/**
 * Unified `task` extension for the main agent. Pushes itself onto `blocked` so
 * child conversations remove it during `configure` and never see `task`.
 */
export function createTaskExtension({
  prepareChild,
  onChild,
  blocked = [],
} = {}) {
  if (typeof prepareChild !== 'function') throw new Error('prepareChild is required');

  const taskTool = defineTool({
    name: TASK_TOOL_NAME,
    description: TASK_DESCRIPTION,
    parameters: obj({
      description: opt(str({ description: DESCRIPTION_PARAM_HELP })),
      prompt: opt(str({ description: PROMPT_PARAM_HELP })),
      run_in_background: opt(bool({ description: BACKGROUND_PARAM_HELP })),
      action: opt(union(
        [lit('send'), lit('wait'), lit('stop'), lit('list')],
        { description: ACTION_PARAM_HELP },
      )),
      id: opt(str({ description: ID_PARAM_HELP })),
      message: opt(str({ description: MESSAGE_PARAM_HELP })),
    }),
    replay: 'safe',
    execute: async (args, api, context) => {
      if (args.action === undefined) {
        const title = normalizeDescription(args.description);
        if (!title) {
          return reply('task dispatch requires a non-empty description.', { isError: true });
        }
        const prompt = typeof args.prompt === 'string' ? args.prompt : '';
        if (!prompt.trim()) {
          return reply('task dispatch requires a non-empty prompt.', { isError: true });
        }
        const prepared = await prepareChild(await api.agent(context));
        if (prepared?.error) return reply(prepared.error, { isError: true });

        if (!args.run_in_background) {
          const child = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (existing) return existing.id;
            const created = await tx.createConversation({
              ownership: { kind: 'task', taskId: api.taskId },
            });
            await configure(tx, created.id, {
              ...prepared.change,
              extensions: { remove: blocked },
            });
            return created.id;
          }, context);
          const id = taskIdFromDescription(title);
          const details = { conversationId: child, name: id, title, mode: 'foreground' };
          await api.details(details, context);
          onChild?.(api.conversationId, child);
          const handle = await api.conversation(child, context);
          if (!handle) {
            return reply(`task ${id} failed: conversation disappeared`, { details, isError: true });
          }
          const submission = await handle.submit({
            type: 'input',
            content: prompt,
            requestId: `task:${api.taskId}`,
          }, context);
          const settled = await submission.wait(context);
          if (context.abortSignal?.aborted) throw abortError();
          if (settled.reason === 'aborted') {
            return reply(`[task ${id} stopped]`, { details });
          }
          if (settled.status !== 'done' || settled.type !== 'input') {
            const detail = typeof settled.detail === 'string' && settled.detail
              ? settled.detail
              : (settled.reason || 'failed');
            return reply(`task ${id} failed: ${detail}`, { details, isError: true });
          }
          const text = await assistantEntryText(api, settled.answer, context);
          return reply(text, { details });
        }

        const res = await api.commit(async (tx) => {
          const state = await tx.doc(TasksDoc, api.conversationId);
          if (Object.hasOwn(state.calls, api.taskId)) {
            return { ...state.calls[api.taskId] };
          }
          const id = taskIdFromDescription(title, state.tasks);
          const background = {
            ownership: { kind: 'conversation' },
            conversationId: api.conversationId,
            background: true,
          };
          const anchor = await tx.createTask(TaskAnchor, null, background);
          const child = await tx.createConversation({
            ownership: { kind: 'task', taskId: anchor },
          });
          await configure(tx, child.id, {
            ...prepared.change,
            extensions: { remove: blocked },
          });
          state.tasks[id] = { conversationId: child.id, title, reported: [] };
          await tx.createTask(
            TaskReporter,
            { id, conversationId: child.id, message: prompt, followUp: false },
            background,
          );
          const saved = {
            id,
            conversationId: child.id,
            title,
            text: `Started background task ${id}.`,
          };
          state.calls[api.taskId] = saved;
          return saved;
        }, context);
        const details = {
          conversationId: res.conversationId,
          name: res.id,
          title: res.title,
          mode: 'background',
        };
        await api.details(details, context);
        onChild?.(api.conversationId, res.conversationId);
        return reply(res.text, { details });
      }

      const action = args.action;
      if (action === 'list') {
        const snapshot = await api.snapshot(TasksDoc, api.conversationId, context);
        const tasks = snapshot?.tasks ?? {};
        const filterId = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined;
        const ids = filterId === undefined ? Object.keys(tasks) : [filterId];
        const lines = [];
        for (const each of ids) {
          const entry = Object.hasOwn(tasks, each) ? tasks[each] : undefined;
          if (!entry) continue;
          const childLive = await api.snapshot(LiveDoc, entry.conversationId, context);
          let status = 'running';
          if (childLive?.run === undefined) {
            const generation = await api.commit(
              async (tx) => (await tx.scanTasks(
                { conversationId: entry.conversationId, kind: 'pi.generation', order: 'descending' },
                1,
              )).items[0],
              context,
            );
            status = idleTaskStatus(childLive, generation).status;
          }
          lines.push(`${each}: ${status}${entry.title ? ` (${entry.title})` : ''}`);
        }
        return reply(lines.length === 0 ? 'No background tasks.' : lines.join('\n'));
      }

      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return reply(`${action} requires a task id.`, { isError: true });

      if (action === 'send') {
        const message = typeof args.message === 'string' ? args.message : '';
        if (!message.trim()) {
          return reply('send requires a non-empty message.', { isError: true });
        }
        const res = await api.commit(async (tx) => {
          const state = await tx.doc(TasksDoc, api.conversationId);
          if (Object.hasOwn(state.calls, api.taskId)) {
            return { ...state.calls[api.taskId] };
          }
          const entry = Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined;
          if (!entry) return { error: `Unknown background task ${id}.` };
          const background = {
            ownership: { kind: 'conversation' },
            conversationId: api.conversationId,
            background: true,
          };
          await tx.createTask(
            TaskReporter,
            { id, conversationId: entry.conversationId, message, followUp: false },
            background,
          );
          const saved = { id, text: `Sent message to ${id}.` };
          state.calls[api.taskId] = saved;
          return saved;
        }, context);
        if (res.error) return reply(res.error, { isError: true });
        return reply(res.text);
      }

      const snapshot = await api.snapshot(TasksDoc, api.conversationId, context);
      const entry = snapshot?.tasks && Object.hasOwn(snapshot.tasks, id) ? snapshot.tasks[id] : undefined;
      if (!entry) return reply(`Unknown background task ${id}.`, { isError: true });
      const handle = await api.conversation(entry.conversationId, context);
      if (!handle) return reply(`Unknown background task ${id}.`, { isError: true });

      if (action === 'stop') {
        await handle.abort(context);
        return reply(`Stopped ${id}.`);
      }

      if (action === 'wait') {
        // Ensure any freshly spawned TaskReporter has submitted to the child before waiting for idle.
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await handle.waitForIdle(context);
          if (context.abortSignal?.aborted) throw abortError();
          const pendingDelivery = await api.commit(async (tx) => {
            const page = await tx.scanTasks(
              { conversationId: api.conversationId, kind: TASK_REPORTER_KIND, order: 'descending' },
              10,
            );
            return page.items.some((item) => (
              item.input?.id === id
              && item.state?.outcome === undefined
              && item.state?.checkpoint?.phase === 'deliver'
            ));
          }, context);
          if (!pendingDelivery) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await handle.waitForIdle(context);
        if (context.abortSignal?.aborted) throw abortError();
        const { childLive, generation, lastText } = await readChildState(
          api,
          entry.conversationId,
          context,
        );
        const idle = idleTaskStatus(childLive, generation);
        if (idle.status === 'stopped') return reply(`[task ${id} stopped]`);
        if (idle.status === 'failed') {
          return reply(`task ${id} failed: ${idle.detail}`, { isError: true });
        }
        return reply(lastText || '(no output)');
      }

      return reply(`Unknown task action ${String(action)}.`, { isError: true });
    },
  });

  const extension = defineExtension({
    name: EXT_TASKS,
    tasks: [TaskAnchor, TaskReporter],
    tools: [taskTool],
  });
  blocked.push(extension);
  return extension;
}
