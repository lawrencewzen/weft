// Scheduled tasks. The configuration (name, message, target, rule, enabled, creator) lives in the
// app database. What runs when is the Durable task `app.weft.schedule`: one instance per enabled
// schedule, owned by the root conversation as a background task.
//
//   arm:  sleepUntil(next run)
//   fire: send the message, commit a run record, sleepUntil(the run after that) or finish
//
// No timers, no polling table. A restart continues the stored sleep; `reconcile()` only checks
// the configuration against the live tasks once, after `harness.resume()`.
import { createHash, randomUUID } from 'node:crypto';
import { defineExtension, defineTask } from '@earendil-works/pi-durable';
import { cleanRule, nextRunTime, ruleProblems } from '../core/schedule-time.mjs';
import { EXT_SCHEDULES, SCHEDULE_TASK_KIND } from './ids.mjs';
import { createScheduleTool } from './schedule-tool.mjs';
import { readTaskGraph } from './subagents.mjs';

/** A run later than this after its planned time is a catch-up (the server was off or asleep). */
export const MISSED_GRACE_MS = 60_000;
export const RUNS_SHOWN = 20;
export const TARGET_DELETED_ERROR = 'Target conversation was deleted';
const WORKSPACE_GONE_ERROR = 'Target workspace was removed';

const MESSAGES = {
  zh: {
    name_required: '任务名称不能为空',
    message_required: '消息内容不能为空',
    target_required: '目标不能为空',
    target_kind: '无效的目标类型',
    conversation_required: '请选择目标对话',
    conversation_missing: '目标对话不存在',
    workspace_required: '请选择工作区',
    workspace_missing: '工作区不存在',
    model_invalid: '模型格式无效',
    rule_required: '时间规则不能为空',
    rule_kind: '无效的时间规则类型',
    once_invalid: '执行时间无效',
    once_past: '执行时间必须在未来',
    time_invalid: '时间格式无效（HH:MM）',
    days_required: '每周请至少选择一天',
    days_invalid: '星期取值只能是 1 到 7',
    interval_min: '间隔不能少于 5 分钟',
    enabled_invalid: 'enabled 必须是布尔值',
    request_id: 'requestId 必须是字符串',
    invalid: '字段校验失败',
    not_found: '定时任务不存在',
    target_deleted: '目标对话已删除',
  },
  en: {
    name_required: 'Name is required',
    message_required: 'Message is required',
    target_required: 'Target is required',
    target_kind: 'Invalid target kind',
    conversation_required: 'Conversation is required',
    conversation_missing: 'Target conversation does not exist',
    workspace_required: 'Workspace is required',
    workspace_missing: 'Workspace does not exist',
    model_invalid: 'Invalid model',
    rule_required: 'Rule is required',
    rule_kind: 'Invalid rule kind',
    once_invalid: 'Invalid time',
    once_past: 'The time must be in the future',
    time_invalid: 'Time must be HH:MM',
    days_required: 'Pick at least one day',
    days_invalid: 'Days must be 1 to 7',
    interval_min: 'Interval must be at least 5 minutes',
    enabled_invalid: 'enabled must be a boolean',
    request_id: 'requestId must be a string',
    invalid: 'Invalid schedule fields',
    not_found: 'Schedule not found',
    target_deleted: 'Target conversation was deleted',
  },
};

function say(lang, key) {
  return (MESSAGES[lang === 'en' ? 'en' : 'zh'] || MESSAGES.zh)[key] || key;
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** A UUID derived from a seed, so a rerun of the same run reaches the same conversation. */
function stableUuid(seed) {
  const bytes = createHash('sha1').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function runView(run) {
  if (!run) return null;
  return {
    id: run.id,
    at: run.at,
    status: run.status,
    conversationId: run.conversationId ?? null,
    error: run.error ?? null,
  };
}

function live(record) {
  const status = record?.state?.status;
  return Boolean(record) && status !== 'terminal' && status !== 'completing';
}

function terminal(runtime, context, status) {
  return runtime.commit(
    () => ({
      status: 'terminal',
      outcome: status === 'aborted' ? { status: 'aborted' } : { status: 'completed', result: null },
    }),
    context,
  );
}

/** The Durable task. `bridge.service` is filled in once the kernel is open. */
function createScheduleTask(bridge) {
  return defineTask({
    name: SCHEDULE_TASK_KIND,
    version: 1,
    initial: () => ({ phase: 'arm' }),
    phases: {
      arm: async (task, runtime, context) => {
        const at = await bridge.service.planFirstRun(task.input.scheduleId, runtime.now());
        if (at == null) return terminal(runtime, context, 'completed');
        return runtime.sleepUntil(at, { phase: 'fire', due: at }, context);
      },
      fire: async (task, runtime, context) => {
        const { next } = await bridge.service.fire(task.input.scheduleId, {
          taskId: task.id,
          due: task.state.checkpoint.due,
          now: runtime.now(),
        });
        if (next == null) return terminal(runtime, context, 'completed');
        return runtime.sleepUntil(next, { phase: 'fire', due: next }, context);
      },
    },
    abort: (_task, runtime, context) => terminal(runtime, context, 'aborted'),
  });
}

/** Extension with the task and the main agent's `schedule` tool. */
export function createScheduleExtension(bridge) {
  const task = createScheduleTask(bridge);
  const tool = createScheduleTool(bridge);
  const extension = defineExtension({
    name: EXT_SCHEDULES,
    tasks: [task],
    tools: [tool],
  });
  bridge.task = task;
  bridge.tool = tool;
  return extension;
}

export function createScheduleService({
  store,
  harness,
  context,
  bridge,
  now = Date.now,
  notify = () => {},
  postMessage,
  createConversation,
  conversationIdFor,
  onConversationCreated = () => {},
} = {}) {
  if (!store) throw new Error('store is required');
  if (!harness) throw new Error('harness is required');
  if (!bridge?.task) throw new Error('schedule extension is required');
  const locks = new Map();
  const arming = new Map();
  let closed = false;

  function emit() {
    if (closed) return;
    try { notify(); } catch { /* a view update must not fail a write */ }
  }

  function withLock(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return run;
  }

  /* ---------- Durable task handling ---------- */

  async function taskRecord(row) {
    if (!row?.taskId) return undefined;
    try {
      return await harness.getTask(Number(row.taskId), context);
    } catch {
      return undefined;
    }
  }

  async function abortTask(taskId) {
    if (taskId == null || taskId === '') return;
    try {
      await harness.abortTask(Number(taskId), context);
    } catch (err) {
      console.error(`WEFT_SCHEDULE_ABORT ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Create the task and remember its id. The task's own fire phase waits for this to finish. */
  function arm(id) {
    const run = (async () => {
      const root = await harness.root(context);
      const taskId = await harness.commit(
        (tx) => tx.createTask(bridge.task, { scheduleId: id }, {
          ownership: { kind: 'conversation' },
          conversationId: root.id,
          background: true,
        }),
        context,
      );
      await store.updateSchedule(id, { taskId: String(taskId) }, { now: now() });
      harness.resume();
      return String(taskId);
    })();
    arming.set(id, run);
    const clear = () => { if (arming.get(id) === run) arming.delete(id); };
    run.then(clear, clear);
    return run;
  }

  /* ---------- views ---------- */

  async function nextRunOf(row) {
    if (!row.enabled) return null;
    const record = await taskRecord(row);
    if (live(record)) {
      const state = record.state;
      if (state.status === 'sleeping') return state.until;
      const due = state.checkpoint?.due;
      if (typeof due === 'number') return due;
    }
    return nextRunTime(row.rule, now());
  }

  async function targetView(target) {
    if (target.kind === 'conversation') {
      const conv = await store.getConversation(target.conversationId);
      return {
        kind: 'conversation',
        conversationId: target.conversationId,
        title: conv?.title ?? target.title ?? '',
      };
    }
    const ws = await store.getWorkspace(target.workspaceId);
    return {
      kind: 'new',
      workspaceId: target.workspaceId,
      workspaceName: ws?.name ?? target.workspaceName ?? '',
      model: target.model ? { providerId: target.model.providerId, modelId: target.model.modelId } : null,
    };
  }

  async function view(row) {
    const last = (await store.listScheduleRuns(row.id, 1))[0];
    return {
      id: row.id,
      name: row.name,
      message: row.message,
      target: await targetView(row.target),
      rule: row.rule,
      enabled: row.enabled,
      createdBy: row.createdBy,
      nextRunAt: await nextRunOf(row),
      lastRun: runView(last),
    };
  }

  /* ---------- validation ---------- */

  function invalid(lang, problems) {
    const fields = [...new Set(problems.map((item) => item.field))];
    const errors = problems.map((item) => say(lang, item.key));
    return {
      status: 400,
      body: {
        error: errors.join('; ') || say(lang, 'invalid'),
        code: 'E_INVALID_SCHEDULE',
        fields,
        errors,
      },
    };
  }

  async function checkTarget(raw, problems, { defaultConversation } = {}) {
    if (!isObject(raw)) {
      problems.push({ field: 'target', key: 'target_required' });
      return null;
    }
    if (raw.kind === 'conversation') {
      const id = typeof raw.conversationId === 'string' && raw.conversationId.trim()
        ? raw.conversationId.trim()
        : defaultConversation || '';
      if (!id) {
        problems.push({ field: 'target.conversationId', key: 'conversation_required' });
        return null;
      }
      const conv = await store.getConversation(id);
      if (!conv) {
        problems.push({ field: 'target.conversationId', key: 'conversation_missing' });
        return null;
      }
      return { kind: 'conversation', conversationId: id, title: conv.title || '' };
    }
    if (raw.kind === 'new') {
      const id = typeof raw.workspaceId === 'string' ? raw.workspaceId.trim() : '';
      if (!id) {
        problems.push({ field: 'target.workspaceId', key: 'workspace_required' });
        return null;
      }
      const ws = await store.getWorkspace(id);
      if (!ws || ws.removedAt) {
        problems.push({ field: 'target.workspaceId', key: 'workspace_missing' });
        return null;
      }
      let model = null;
      if (raw.model != null) {
        if (!isObject(raw.model) || typeof raw.model.providerId !== 'string' || typeof raw.model.modelId !== 'string'
          || !raw.model.providerId || !raw.model.modelId) {
          problems.push({ field: 'target.model', key: 'model_invalid' });
          return null;
        }
        model = { providerId: raw.model.providerId, modelId: raw.model.modelId };
      }
      return { kind: 'new', workspaceId: id, workspaceName: ws.name || '', model };
    }
    problems.push({ field: 'target.kind', key: 'target_kind' });
    return null;
  }

  function textField(raw, field, key, problems) {
    if (typeof raw !== 'string' || !raw.trim()) {
      problems.push({ field, key });
      return null;
    }
    return raw.trim();
  }

  /* ---------- idempotency ---------- */

  const inflight = new Map();

  /** A write with a requestId runs once per scope. A repeat gets the stored answer. */
  async function once(scope, requestId, fn) {
    if (!requestId) return fn();
    const key = `${scope}\n${requestId}`;
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      const stored = await store.getScheduleRequest(scope, requestId);
      if (stored) return { status: stored.status, body: stored.body };
      const result = await fn();
      if (result.status < 400) {
        await store.putScheduleRequest(scope, requestId, result.status, result.body, { now: now() });
      }
      return result;
    })();
    inflight.set(key, run);
    const clear = () => { if (inflight.get(key) === run) inflight.delete(key); };
    run.then(clear, clear);
    return run;
  }

  function requestIdOf(body, lang) {
    if (!isObject(body) || body.requestId == null) return { ok: true, value: undefined };
    if (typeof body.requestId !== 'string') {
      return { ok: false, response: invalid(lang, [{ field: 'requestId', key: 'request_id' }]) };
    }
    const value = body.requestId.trim();
    return { ok: true, value: value || undefined };
  }

  const missing = (lang) => ({ status: 404, body: { error: say(lang, 'not_found'), code: 'E_NOT_FOUND' } });

  /* ---------- execution ---------- */

  /**
   * Send the message. Never throws for a failed target: returns { error } instead.
   * `convId` makes a new conversation reachable again if the run is repeated after a crash.
   */
  async function deliver(row, { requestId, convId }) {
    const target = row.target;
    let conv;
    if (target.kind === 'conversation') {
      conv = await store.getConversation(target.conversationId);
      if (!conv) return { error: TARGET_DELETED_ERROR, gone: true, conversationId: null };
    } else {
      const ws = await store.getWorkspace(target.workspaceId);
      if (!ws || ws.removedAt) return { error: WORKSPACE_GONE_ERROR, conversationId: null };
      const id = convId || randomUUID();
      conv = await store.getConversation(id);
      if (!conv) {
        conv = await createConversation({
          id,
          workspaceId: ws.id,
          workspacePath: ws.path,
          title: row.name,
          titleSource: 'user',
          status: 'idle',
          ...(target.model ? { modelSourceId: target.model.providerId, modelId: target.model.modelId } : {}),
        });
        onConversationCreated(conv.id);
      }
    }
    try {
      const sent = await postMessage(conv, row.message, { requestId, mode: 'queue' });
      if (sent.status >= 200 && sent.status < 300) return { conversationId: conv.id };
      const reason = sent.body?.error ? String(sent.body.error) : `send failed (${sent.status})`;
      return { error: reason, conversationId: conv.id };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), conversationId: conv.id };
    }
  }

  /** The task's fire phase. Safe to repeat: the run id and the message request id are fixed per planned time. */
  async function fire(id, { taskId, due, now: at }) {
    const pending = arming.get(id);
    if (pending) await pending.catch(() => {});
    const row = await store.getSchedule(id);
    if (!row || !row.enabled || row.taskId !== String(taskId)) return { next: null };
    const runId = `${id}:${due}`;
    let run = await store.getScheduleRun(runId);
    if (!run) {
      const sent = await deliver(row, { requestId: `schedule:${runId}`, convId: stableUuid(`schedule:${runId}`) });
      const status = sent.error ? 'failed' : (at - due > MISSED_GRACE_MS ? 'missed_caught_up' : 'ok');
      run = await store.addScheduleRun(id, {
        id: runId,
        at,
        status,
        conversationId: sent.conversationId,
        error: sent.error ?? null,
      });
    }
    const gone = run.status === 'failed' && run.error === TARGET_DELETED_ERROR;
    let next = null;
    if (gone || row.rule.kind === 'once') {
      const current = await store.getSchedule(id);
      if (current && current.taskId === String(taskId)) {
        await store.updateSchedule(id, { enabled: false, taskId: null }, { now: now() });
      }
    } else {
      next = nextRunTime(row.rule, at, { anchor: due });
    }
    emit();
    return { next };
  }

  /** First sleep of a new task. */
  async function planFirstRun(id, from) {
    const row = await store.getSchedule(id);
    if (!row || !row.enabled) return null;
    if (row.rule.kind === 'once') return row.rule.at;
    return nextRunTime(row.rule, from);
  }

  /* ---------- operations ---------- */

  async function list() {
    const rows = await store.listSchedules();
    return Promise.all(rows.map((row) => view(row)));
  }

  async function get(id) {
    const row = await store.getSchedule(id);
    return row ? view(row) : null;
  }

  async function create(body, { createdBy = 'user', lang = 'zh', defaultConversation } = {}) {
    const input = isObject(body) ? body : {};
    const rid = requestIdOf(input, lang);
    if (!rid.ok) return rid.response;
    return once('create', rid.value, async () => {
      const problems = [];
      const name = textField(input.name, 'name', 'name_required', problems);
      const message = textField(input.message, 'message', 'message_required', problems);
      let target = null;
      if (input.target === undefined && defaultConversation) {
        target = await checkTarget({ kind: 'conversation' }, problems, { defaultConversation });
      } else {
        target = await checkTarget(input.target, problems, { defaultConversation });
      }
      let rule = null;
      if (input.rule === undefined) problems.push({ field: 'rule', key: 'rule_required' });
      else {
        const bad = ruleProblems(input.rule, { now: now() });
        if (bad.length) problems.push(...bad);
        else rule = cleanRule(input.rule);
      }
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
        problems.push({ field: 'enabled', key: 'enabled_invalid' });
      }
      if (problems.length) return invalid(lang, problems);
      const enabled = input.enabled !== false;
      const row = await store.createSchedule({
        id: `sched-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        name,
        message,
        target,
        rule,
        enabled,
        createdBy: createdBy === 'agent' ? 'agent' : 'user',
        now: now(),
      });
      if (enabled) await withLock(row.id, () => arm(row.id));
      emit();
      return { status: 201, body: await view(await store.getSchedule(row.id)) };
    });
  }

  async function update(id, body, { lang = 'zh' } = {}) {
    const input = isObject(body) ? body : {};
    const rid = requestIdOf(input, lang);
    if (!rid.ok) return rid.response;
    return once(`update:${id}`, rid.value, () => withLock(id, async () => {
      const row = await store.getSchedule(id);
      if (!row) return missing(lang);
      const problems = [];
      const patch = {};
      if (input.name !== undefined) patch.name = textField(input.name, 'name', 'name_required', problems);
      if (input.message !== undefined) patch.message = textField(input.message, 'message', 'message_required', problems);
      if (input.target !== undefined) {
        const target = await checkTarget(input.target, problems);
        if (target) patch.target = target;
      }
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') problems.push({ field: 'enabled', key: 'enabled_invalid' });
        else patch.enabled = input.enabled;
      }
      if (input.rule !== undefined) {
        const bad = ruleProblems(input.rule, { now: now() });
        if (bad.length) problems.push(...bad);
        else patch.rule = cleanRule(input.rule);
      }
      const merged = { ...row, ...patch };
      if (!problems.length && patch.rule === undefined && patch.enabled === true && !row.enabled) {
        // Turning a schedule back on must not leave a once rule in the past.
        problems.push(...ruleProblems(merged.rule, { now: now() }));
      }
      if (problems.length) return invalid(lang, problems);

      const ruleChanged = patch.rule !== undefined && JSON.stringify(patch.rule) !== JSON.stringify(row.rule);
      const enabledChanged = merged.enabled !== row.enabled;
      const record = await taskRecord(row);
      const needsTask = merged.enabled && !live(record);
      const rearm = ruleChanged || enabledChanged || needsTask;
      const apply = { ...patch };
      if (rearm) apply.taskId = null;
      await store.updateSchedule(id, apply, { now: now() });
      if (rearm) {
        if (live(record)) await abortTask(row.taskId);
        if (merged.enabled) await arm(id);
      }
      emit();
      return { status: 200, body: await view(await store.getSchedule(id)) };
    }));
  }

  async function remove(id, { requestId, lang = 'zh' } = {}) {
    return once(`delete:${id}`, requestId, () => withLock(id, async () => {
      const row = await store.getSchedule(id);
      if (!row) return missing(lang);
      await abortTask(row.taskId);
      await store.deleteSchedule(id);
      emit();
      return { status: 200, body: { ok: true, id } };
    }));
  }

  async function runNow(id, body, { lang = 'zh' } = {}) {
    const rid = requestIdOf(body, lang);
    if (!rid.ok) return rid.response;
    return once(`run:${id}`, rid.value, () => withLock(id, async () => {
      const row = await store.getSchedule(id);
      if (!row) return missing(lang);
      const runId = `${id}:now:${randomUUID().slice(0, 8)}`;
      const sent = await deliver(row, { requestId: `schedule:${runId}` });
      const run = await store.addScheduleRun(id, {
        id: runId,
        at: now(),
        status: sent.error ? 'failed' : 'ok',
        conversationId: sent.conversationId,
        error: sent.error ?? null,
      });
      if (sent.gone && row.enabled) {
        await abortTask(row.taskId);
        await store.updateSchedule(id, { enabled: false, taskId: null }, { now: now() });
      }
      emit();
      return { status: 200, body: runView(run) };
    }));
  }

  async function runs(id, { lang = 'zh' } = {}) {
    const row = await store.getSchedule(id);
    if (!row) return missing(lang);
    const rows = await store.listScheduleRuns(id, RUNS_SHOWN);
    return { status: 200, body: { runs: rows.map(runView) } };
  }

  /**
   * After `harness.resume()`: every enabled schedule gets a live task (resume already continued the
   * ones that exist), a paused one has none, and no task is left without a schedule.
   */
  async function reconcile() {
    const rows = await store.listSchedules();
    const known = new Set();
    for (const row of rows) {
      await withLock(row.id, async () => {
        const record = await taskRecord(row);
        const alive = live(record);
        if (alive && row.enabled) {
          known.add(String(row.taskId));
          return;
        }
        if (alive) await abortTask(row.taskId);
        if (row.enabled) known.add(await arm(row.id));
        else if (row.taskId) await store.updateSchedule(row.id, { taskId: null }, { now: now() });
      });
    }
    try {
      const graph = await readTaskGraph(harness, context);
      for (const node of Object.values(graph?.tasks || {})) {
        if (node.kind === SCHEDULE_TASK_KIND && !known.has(String(node.id))) await abortTask(node.id);
      }
    } catch (err) {
      console.error(`WEFT_SCHEDULE_RECONCILE ${err instanceof Error ? err.message : err}`);
    }
    emit();
  }

  return {
    list,
    get,
    create,
    update,
    remove,
    runNow,
    runs,
    reconcile,
    planFirstRun,
    fire,
    conversationIdFor,
    close() { closed = true; },
  };
}
