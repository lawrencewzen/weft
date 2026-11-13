import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSqliteStore, SCHEDULE_RUNS_KEPT } from '../../src/store/sqlite.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { createScheduleTool } from '../../src/kernel/schedule-tool.mjs';
import { CHILD_HIDDEN_TOOLS } from '../../src/kernel/subagents.mjs';
import { SCHEDULE_TASK_KIND } from '../../src/kernel/ids.mjs';
import { toolCallView, summarizeToolGroup } from '../../src/v2/views/tools.ts';
import { createFakeClock } from './_fake-clock.mjs';
import { withHarnessLock } from './_harness-lock.mjs';

process.env.TZ = 'Asia/Shanghai';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const START = local(2026, 3, 10, 8, 0);

async function until(fn, { timeout = 15_000, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
}

async function openAt(dataDir, clock, { env = {}, onSchedulesChanged } = {}) {
  const store = createSqliteStore(dataDir);
  const kernel = await openConversationKernel({
    dataDir,
    store,
    demo: true,
    clock,
    onSchedulesChanged,
    env: { ...process.env, WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'scheduled-ok', ...env },
  });
  return {
    store,
    kernel,
    svc: kernel.schedules,
    async close() {
      await kernel.close();
      store.close();
    },
  };
}

/** One data dir and one fake clock. `fn` may close and reopen the kernel itself. */
async function withEnv(fn, { start = START } = {}) {
  return withHarnessLock(async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-sched-'));
    const clock = createFakeClock(start);
    const opened = new Set();
    const open = async (opts) => {
      const one = await openAt(dataDir, clock, opts);
      opened.add(one);
      return one;
    };
    try {
      return await fn({ dataDir, clock, open });
    } finally {
      for (const one of opened) await one.close().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

async function seed(one, title = 'target') {
  const ws = await one.store.createWorkspace({ name: 'proj', path: one.kernel === null ? '' : process.cwd(), source: 'local' });
  const conv = await one.kernel.createConversation({
    workspaceId: ws.id,
    workspacePath: ws.path,
    title,
  });
  return { ws, conv };
}

const task = (one, id) => one.kernel.harness.getTask(Number(id), one.kernel.context);
const rowOf = (one, id) => one.store.getSchedule(id);
/** The task is asleep: its arm phase has run. Advance the clock only after this. */
const asleep = (one, id) => until(async () => {
  const row = await one.store.getSchedule(id);
  const record = row?.taskId ? await one.kernel.harness.getTask(Number(row.taskId), one.kernel.context) : null;
  return record?.state?.status === 'sleeping' ? record : null;
}, { label: `schedule ${id} asleep` });
const isAborted = async (one, taskId) => {
  const record = await task(one, taskId);
  return record?.state?.status === 'terminal' && record.state.outcome?.status === 'aborted';
};
const runsOf = async (one, id) => (await one.svc.runs(id)).body.runs;

async function messagesOf(one, cid) {
  const row = await one.store.getConversation(cid);
  const view = await one.kernel.present(row, { includeMessages: true });
  return view.messages || [];
}

const daily = { kind: 'daily', time: '09:00' };

function convTarget(conv) {
  return { kind: 'conversation', conversationId: conv.id };
}

test('daily schedule to an existing conversation runs when its time comes', { timeout: 60_000 }, async () => {
  await withEnv(async ({ clock, open }) => {
    const one = await open();
    const { conv } = await seed(one);
    const made = await one.svc.create({ name: 'Morning', message: 'run the morning check', target: convTarget(conv), rule: daily });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.createdBy, 'user');
    assert.equal(made.body.nextRunAt, local(2026, 3, 10, 9, 0));
    assert.equal(made.body.lastRun, null);

    // One live Durable task, owned by the root conversation, asleep until 09:00.
    const record = await asleep(one, made.body.id);
    assert.equal(record.kind, SCHEDULE_TASK_KIND);
    assert.equal(record.state.until, local(2026, 3, 10, 9, 0));

    clock.advance(HOUR + 5_000);
    const [run] = await until(async () => {
      const list = await runsOf(one, made.body.id);
      return list.length ? list : null;
    }, { label: 'first run' });
    assert.equal(run.status, 'ok');
    assert.equal(run.conversationId, conv.id);
    assert.equal(run.error, null);
    await until(async () => (await messagesOf(one, conv.id)).some((m) => m.role === 'user' && m.text === 'run the morning check'), { label: 'message sent' });

    // Back to sleep for the next day.
    const after = await until(async () => {
      const view = await one.svc.get(made.body.id);
      return view.nextRunAt === local(2026, 3, 11, 9, 0) ? view : null;
    }, { label: 'next run' });
    assert.equal(after.lastRun.id, run.id);
    assert.equal(after.lastRun.status, 'ok');
    assert.equal((await task(one, (await rowOf(one, made.body.id)).taskId)).state.status, 'sleeping');
  });
});

test('the message goes to the target as a queued send, so a running conversation is not interrupted', { timeout: 60_000 }, async () => {
  await withEnv(async ({ clock, open }) => {
    const one = await open();
    const { conv } = await seed(one);
    const calls = [];
    const original = one.kernel.postMessage.bind(one.kernel);
    one.kernel.postMessage = (target, text, options) => {
      calls.push({ id: target.id, text, options });
      return original(target, text, options);
    };
    const made = await one.svc.create({ name: 'Q', message: 'queued hello', target: convTarget(conv), rule: { kind: 'interval', everyMinutes: 10 } });
    await asleep(one, made.body.id);
    clock.advance(10 * MINUTE + 1_000);
    await until(async () => (await runsOf(one, made.body.id)).length, { label: 'run' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, conv.id);
    assert.equal(calls[0].options.mode, 'queue');
    assert.match(calls[0].options.requestId, /^schedule:/);
  });
});

test('a new-conversation target opens a conversation in the workspace with the task name and model', { timeout: 60_000 }, async () => {
  await withEnv(async ({ clock, open }) => {
    const one = await open();
    const { ws } = await seed(one);
    const made = await one.svc.create({
      name: 'Nightly review',
      message: 'review the diff',
      target: { kind: 'new', workspaceId: ws.id, model: { providerId: 'deepseek', modelId: 'deepseek-flash' } },
      rule: { kind: 'interval', everyMinutes: 30 },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    await asleep(one, made.body.id);
    assert.deepEqual(made.body.target, {
      kind: 'new',
      workspaceId: ws.id,
      workspaceName: 'proj',
      model: { providerId: 'deepseek', modelId: 'deepseek-flash' },
    });
    clock.advance(30 * MINUTE + 1_000);
    const [run] = await until(async () => {
      const list = await runsOf(one, made.body.id);
      return list.length ? list : null;
    }, { label: 'run' });
    assert.equal(run.status, 'ok');
    const created = await one.store.getConversation(run.conversationId);
    assert.equal(created.workspaceId, ws.id);
    assert.equal(created.title, 'Nightly review');
    assert.equal(created.titleSource, 'user');
    assert.equal(created.modelSourceId, 'deepseek');
    assert.equal(created.modelId, 'deepseek-flash');
    await until(async () => (await messagesOf(one, created.id)).some((m) => m.role === 'user' && m.text === 'review the diff'), { label: 'message sent' });

    // Without a model the default model is used.
    const plain = await one.svc.create({ name: 'Plain', message: 'x', target: { kind: 'new', workspaceId: ws.id }, rule: { kind: 'interval', everyMinutes: 5 } });
    assert.equal(plain.body.target.model, null);
    await asleep(one, plain.body.id);
    clock.advance(5 * MINUTE + 1_000);
    const [plainRun] = await until(async () => {
      const list = await runsOf(one, plain.body.id);
      return list.length ? list : null;
    }, { label: 'plain run' });
    const plainConv = await one.store.getConversation(plainRun.conversationId);
    assert.equal(plainConv.modelId, null);
    assert.equal(plainConv.title, 'Plain');
  });
});

test('after a restart the stored sleep goes on and runs on time', { timeout: 90_000 }, async () => {
  await withEnv(async ({ clock, open }) => {
    const first = await open();
    const { conv } = await seed(first);
    const made = await first.svc.create({ name: 'Persist', message: 'after restart', target: convTarget(conv), rule: daily });
    await asleep(first, made.body.id);
    const before = await rowOf(first, made.body.id);
    await first.close();

    clock.advance(30 * MINUTE); // 08:30, still ahead of 09:00
    const second = await open();
    const same = await rowOf(second, made.body.id);
    assert.equal(same.taskId, before.taskId, 'the same Durable task continues; none is created');
    assert.equal((await task(second, same.taskId)).state.until, local(2026, 3, 10, 9, 0));
    assert.deepEqual(await runsOf(second, made.body.id), []);

    clock.advance(30 * MINUTE + 20_000); // 09:00:20
    const [run] = await until(async () => {
      const list = await runsOf(second, made.body.id);
      return list.length ? list : null;
    }, { label: 'run after restart' });
    assert.equal(run.status, 'ok');
    assert.equal(run.conversationId, conv.id);
  });
});

test('runs missed while the server was off are made up once, then the schedule goes on normally', { timeout: 90_000 }, async () => {
  await withEnv(async ({ clock, open }) => {
    const first = await open();
    const { conv } = await seed(first);
    const made = await first.svc.create({ name: 'Missed', message: 'catch up', target: convTarget(conv), rule: daily });
    await asleep(first, made.body.id);
    await first.close();

    clock.advance(3 * 24 * HOUR + 2 * HOUR); // 2026-03-13 10:00: three 09:00 runs were missed
    const second = await open();
    const [run] = await until(async () => {
      const list = await runsOf(second, made.body.id);
      return list.length ? list : null;
    }, { label: 'catch-up run' });
    assert.equal(run.status, 'missed_caught_up');
    assert.equal(run.conversationId, conv.id);
    const view = await until(async () => {
      const current = await second.svc.get(made.body.id);
      return current.nextRunAt === local(2026, 3, 14, 9, 0) ? current : null;
    }, { label: 'next run after catch-up' });
    assert.equal(view.lastRun.status, 'missed_caught_up');
    await sleep(300);
    assert.equal((await runsOf(second, made.body.id)).length, 1, 'only one catch-up run');
    const sent = (await messagesOf(second, conv.id)).filter((m) => m.role === 'user' && m.text === 'catch up');
    assert.equal(sent.length, 1);

    // Normal again: the next day's 09:00 is an ordinary run.
    clock.advance(23 * HOUR + 5_000);
    await until(async () => (await runsOf(second, made.body.id)).length === 2, { label: 'normal run' });
    assert.equal((await runsOf(second, made.body.id))[0].status, 'ok');
  });
});

test('a once schedule runs once, then turns itself off and its task ends', { timeout: 60_000 }, async () => {
  await withEnv(async ({ clock, open }) => {
    const one = await open();
    const { conv } = await seed(one);
    const at = START + 10 * MINUTE;
    const made = await one.svc.create({ name: 'Once', message: 'just once', target: convTarget(conv), rule: { kind: 'once', at } });
    assert.equal(made.body.nextRunAt, at);
    const taskId = (await rowOf(one, made.body.id)).taskId;
    await asleep(one, made.body.id);
    clock.advance(10 * MINUTE + 3_000);
    await until(async () => (await runsOf(one, made.body.id)).length, { label: 'once run' });
    const view = await until(async () => {
      const current = await one.svc.get(made.body.id);
      return current.enabled === false ? current : null;
    }, { label: 'disabled' });
    assert.equal(view.nextRunAt, null);
    assert.equal(view.lastRun.status, 'ok');
    const record = await until(async () => {
      const found = await task(one, taskId);
      return found?.state?.status === 'terminal' ? found : null;
    }, { label: 'task finished' });
    assert.equal(record.state.outcome.status, 'completed');
    assert.equal((await rowOf(one, made.body.id)).taskId, null);
    // A paused once schedule whose time has passed cannot simply be switched back on.
    const again = await one.svc.update(made.body.id, { enabled: true });
    assert.equal(again.status, 400);
    assert.deepEqual(again.body.fields, ['rule.at']);
  });
});

test('pause, resume, edit and delete stop the old task instance', { timeout: 60_000 }, async () => {
  await withEnv(async ({ clock, open }) => {
    const one = await open();
    const { conv } = await seed(one);
    const made = await one.svc.create({ name: 'Life', message: 'm', target: convTarget(conv), rule: daily });
    const id = made.body.id;
    const t1 = (await rowOf(one, id)).taskId;
    await asleep(one, id);

    // Renaming does not touch the task.
    const renamed = await one.svc.update(id, { name: 'Life 2' });
    assert.equal(renamed.body.name, 'Life 2');
    assert.equal((await rowOf(one, id)).taskId, t1);

    const paused = await one.svc.update(id, { enabled: false });
    assert.equal(paused.body.enabled, false);
    assert.equal(paused.body.nextRunAt, null);
    await until(() => isAborted(one, t1), { label: 'paused task aborted' });
    assert.equal((await rowOf(one, id)).taskId, null);
    clock.advance(2 * HOUR);
    await sleep(200);
    assert.deepEqual(await runsOf(one, id), [], 'a paused schedule never runs');

    const resumed = await one.svc.update(id, { enabled: true });
    assert.equal(resumed.body.enabled, true);
    const t2 = (await rowOf(one, id)).taskId;
    assert.notEqual(t2, t1);
    await asleep(one, id);
    assert.equal(resumed.body.nextRunAt, local(2026, 3, 11, 9, 0));

    const edited = await one.svc.update(id, { rule: { kind: 'interval', everyMinutes: 15 } });
    await until(() => isAborted(one, t2), { label: 'edited task aborted' });
    const t3 = (await rowOf(one, id)).taskId;
    assert.notEqual(t3, t2);
    assert.ok(Math.abs(edited.body.nextRunAt - (await asleep(one, id)).state.until) < 1000, 'the preview is the task\'s sleep, to within clock drift');

    const removed = await one.svc.remove(id);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { ok: true, id });
    await until(() => isAborted(one, t3), { label: 'deleted task aborted' });
    assert.equal(await rowOf(one, id), undefined);
    assert.equal((await one.svc.runs(id)).status, 404);
    assert.equal((await one.svc.update(id, { name: 'x' })).status, 404);
    assert.equal((await one.svc.remove(id)).status, 404);
    assert.deepEqual(await one.svc.list(), []);
  });
});

test('startup puts tasks and configuration in line: missing task rebuilt, paused or deleted ones stopped', { timeout: 90_000 }, async () => {
  await withEnv(async ({ dataDir, open }) => {
    const first = await open();
    const { conv } = await seed(first);
    const keep = (await first.svc.create({ name: 'Keep', message: 'k', target: convTarget(conv), rule: daily })).body.id;
    const lost = (await first.svc.create({ name: 'Lost', message: 'l', target: convTarget(conv), rule: daily })).body.id;
    const orphan = (await first.svc.create({ name: 'Orphan', message: 'o', target: convTarget(conv), rule: daily })).body.id;
    const keepTask = (await rowOf(first, keep)).taskId;
    const lostTask = (await rowOf(first, lost)).taskId;
    const orphanTask = (await rowOf(first, orphan)).taskId;
    for (const id of [keep, lost, orphan]) await asleep(first, id);
    await first.close();

    // Edit the configuration behind the kernel's back: one schedule loses its task id, one row is removed.
    const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'));
    db.prepare('UPDATE schedules SET task_id = NULL WHERE id = ?').run(lost);
    db.prepare('DELETE FROM schedules WHERE id = ?').run(orphan);
    db.close();

    const second = await open();
    assert.equal((await rowOf(second, keep)).taskId, keepTask);
    const rebuilt = (await rowOf(second, lost)).taskId;
    assert.ok(rebuilt && rebuilt !== lostTask);
    await asleep(second, lost);
    await until(() => isAborted(second, lostTask), { label: 'old task of the lost schedule aborted' });
    await until(() => isAborted(second, orphanTask), { label: 'task without a schedule aborted' });
  });
});

test('a deleted target conversation fails the run, records why and pauses the schedule', { timeout: 90_000 }, async () => {
  await withEnv(async ({ dataDir, clock, open }) => {
    const one = await open();
    const { conv } = await seed(one);
    const made = await one.svc.create({ name: 'Gone', message: 'hello?', target: convTarget(conv), rule: daily });
    const manual = await one.svc.create({ name: 'Gone manual', message: 'hello?', target: convTarget(conv), rule: { kind: 'daily', time: '20:00' } });
    const taskId = (await rowOf(one, made.body.id)).taskId;
    const manualTask = (await rowOf(one, manual.body.id)).taskId;
    await asleep(one, made.body.id);
    await asleep(one, manual.body.id);

    const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'));
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    db.close();

    // The scheduled run.
    clock.advance(HOUR + 2_000);
    const [run] = await until(async () => {
      const list = await runsOf(one, made.body.id);
      return list.length ? list : null;
    }, { label: 'failed run' });
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'Target conversation was deleted');
    assert.equal(run.conversationId, null);
    const view = await until(async () => {
      const current = await one.svc.get(made.body.id);
      return current.enabled === false ? current : null;
    }, { label: 'auto paused' });
    assert.equal(view.nextRunAt, null);
    assert.equal(view.lastRun.status, 'failed');
    assert.equal(view.target.title, 'target', 'the last known title stays');
    await until(async () => (await task(one, taskId))?.state?.status === 'terminal', { label: 'task ended' });

    // "Run now" on a schedule whose target is gone: same result.
    const result = await one.svc.runNow(manual.body.id, {});
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.error, 'Target conversation was deleted');
    assert.equal((await one.svc.get(manual.body.id)).enabled, false);
    await until(() => isAborted(one, manualTask), { label: 'manual-run task aborted' });
  });
});

test('run now runs immediately, ignores the future-only rule of once, and leaves the schedule alone', { timeout: 60_000 }, async () => {
  await withEnv(async ({ open }) => {
    const one = await open();
    const { conv } = await seed(one);
    const at = START + HOUR;
    const made = await one.svc.create({ name: 'Manual', message: 'now please', target: convTarget(conv), rule: { kind: 'once', at } });
    const result = await one.svc.runNow(made.body.id, {});
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
    assert.equal(result.body.conversationId, conv.id);
    await until(async () => (await messagesOf(one, conv.id)).some((m) => m.text === 'now please'), { label: 'message' });
    const view = await one.svc.get(made.body.id);
    assert.equal(view.enabled, true);
    assert.equal(view.nextRunAt, at);
    assert.equal(view.lastRun.id, result.body.id);
    assert.equal((await one.svc.runNow('nope', {})).status, 404);
  });
});

test('validation answers 400 with field names; ids and creators are kept', { timeout: 60_000 }, async () => {
  await withEnv(async ({ open }) => {
    const one = await open();
    const { conv, ws } = await seed(one);
    const bad = async (body, fields) => {
      const result = await one.svc.create(body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.code, 'E_INVALID_SCHEDULE');
      assert.deepEqual([...result.body.fields].sort(), [...fields].sort(), JSON.stringify(result.body));
      assert.equal(result.body.errors.length > 0, true);
      assert.equal(typeof result.body.error, 'string');
    };
    const ok = { name: 'v', message: 'm', target: convTarget(conv), rule: daily };
    await bad({}, ['name', 'message', 'target', 'rule']);
    await bad({ ...ok, name: '  ' }, ['name']);
    await bad({ ...ok, message: '' }, ['message']);
    await bad({ ...ok, target: { kind: 'conversation', conversationId: 'missing' } }, ['target.conversationId']);
    await bad({ ...ok, target: { kind: 'conversation' } }, ['target.conversationId']);
    await bad({ ...ok, target: { kind: 'new', workspaceId: 'missing' } }, ['target.workspaceId']);
    await bad({ ...ok, target: { kind: 'new', workspaceId: ws.id, model: { providerId: 'p' } } }, ['target.model']);
    await bad({ ...ok, target: { kind: 'elsewhere' } }, ['target.kind']);
    await bad({ ...ok, rule: { kind: 'interval', everyMinutes: 4 } }, ['rule.everyMinutes']);
    await bad({ ...ok, rule: { kind: 'weekly', days: [], time: '09:00' } }, ['rule.days']);
    await bad({ ...ok, rule: { kind: 'weekly', days: [1], time: '9am' } }, ['rule.time']);
    await bad({ ...ok, rule: { kind: 'daily', time: '25:00' } }, ['rule.time']);
    await bad({ ...ok, rule: { kind: 'once', at: START - 1 } }, ['rule.at']);
    await bad({ ...ok, rule: { kind: 'once', at: START } }, ['rule.at']);
    await bad({ ...ok, rule: { kind: 'yearly' } }, ['rule.kind']);
    await bad({ ...ok, enabled: 'yes' }, ['enabled']);
    await bad({ ...ok, requestId: 7 }, ['requestId']);
    assert.deepEqual(await one.svc.list(), [], 'nothing was created');

    const made = (await one.svc.create({ ...ok, target: { kind: 'conversation', conversationId: conv.id, title: 'ignored' }, enabled: false })).body;
    assert.equal(made.enabled, false);
    assert.equal(made.nextRunAt, null);
    assert.equal(made.target.title, 'target', 'the title is the conversation\'s own');
    assert.equal(made.createdBy, 'user');
    assert.equal((await rowOf(one, made.id)).taskId, null, 'a paused schedule has no task');

    const patchBad = async (body, fields) => {
      const result = await one.svc.update(made.id, body);
      assert.equal(result.status, 400);
      assert.deepEqual(result.body.fields, fields);
    };
    await patchBad({ rule: { kind: 'interval', everyMinutes: 1 } }, ['rule.everyMinutes']);
    await patchBad({ name: '' }, ['name']);
    await patchBad({ enabled: 1 }, ['enabled']);
    assert.equal((await one.svc.get(made.id)).name, 'v', 'a rejected patch changes nothing');

    // Anyone can edit, the creator stays.
    const agentMade = (await one.svc.create(ok, { createdBy: 'agent' })).body;
    assert.equal(agentMade.createdBy, 'agent');
    const edited = (await one.svc.update(agentMade.id, { name: 'edited by user', rule: { kind: 'weekly', days: [5, 1], time: '10:30' } })).body;
    assert.equal(edited.createdBy, 'agent');
    assert.deepEqual(edited.rule, { kind: 'weekly', days: [1, 5], time: '10:30' });
    assert.equal(edited.nextRunAt, local(2026, 3, 13, 10, 30));
  });
});

test('writes with a requestId happen once', { timeout: 60_000 }, async () => {
  await withEnv(async ({ open }) => {
    const one = await open();
    const { conv } = await seed(one);
    const body = { name: 'Idem', message: 'm', target: convTarget(conv), rule: daily, requestId: 'req-create' };
    const [a, b] = await Promise.all([one.svc.create(body), one.svc.create(body)]);
    assert.equal(a.status, 201);
    assert.deepEqual(b, a);
    const c = await one.svc.create(body);
    assert.deepEqual(c, a);
    assert.equal((await one.svc.list()).length, 1);
    // Another request id is another schedule.
    assert.equal((await one.svc.create({ ...body, requestId: 'req-create-2' })).status, 201);
    assert.equal((await one.svc.list()).length, 2);

    const id = a.body.id;
    const patched = await one.svc.update(id, { name: 'Idem 2', requestId: 'req-patch' });
    assert.equal(patched.body.name, 'Idem 2');
    await one.svc.update(id, { name: 'Idem 3' });
    const replay = await one.svc.update(id, { name: 'Idem 2', requestId: 'req-patch' });
    assert.equal(replay.body.name, 'Idem 2', 'the stored answer comes back, nothing is applied again');
    assert.equal((await one.svc.get(id)).name, 'Idem 3');

    const run = await one.svc.runNow(id, { requestId: 'req-run' });
    const runAgain = await one.svc.runNow(id, { requestId: 'req-run' });
    assert.deepEqual(runAgain, run);
    assert.equal((await runsOf(one, id)).length, 1);

    const removed = await one.svc.remove(id, { requestId: 'req-del' });
    assert.equal(removed.status, 200);
    assert.deepEqual(await one.svc.remove(id, { requestId: 'req-del' }), removed);
    assert.equal((await one.svc.remove(id, { requestId: 'req-del-2' })).status, 404);
  });
});

test('every change is announced, and only the last 50 runs are kept', { timeout: 90_000 }, async () => {
  await withEnv(async ({ clock, open }) => {
    let announced = 0;
    const one = await open({ onSchedulesChanged: () => { announced += 1; } });
    const { conv } = await seed(one);
    const settled = announced;
    const made = await one.svc.create({ name: 'N', message: 'm', target: convTarget(conv), rule: { kind: 'interval', everyMinutes: 5 } });
    assert.ok(announced > settled);
    let seen = announced;
    await one.svc.update(made.body.id, { name: 'N2' });
    assert.ok(announced > seen);
    seen = announced;
    clock.advance(5 * MINUTE + 1_000);
    await until(async () => (await runsOf(one, made.body.id)).length === 1, { label: 'run' });
    await until(() => announced > seen, { label: 'announce after run' });
    seen = announced;
    await one.svc.remove(made.body.id);
    assert.ok(announced > seen);

    // Retention in the store.
    for (let i = 0; i < SCHEDULE_RUNS_KEPT + 7; i += 1) {
      await one.store.addScheduleRun('keep', { id: `keep:${i}`, at: i, status: 'ok', conversationId: null, error: null });
    }
    const kept = await one.store.listScheduleRuns('keep', 1000);
    assert.equal(kept.length, SCHEDULE_RUNS_KEPT);
    assert.equal(kept[0].id, `keep:${SCHEDULE_RUNS_KEPT + 6}`);
    // The HTTP list shows the newest 20.
    await one.store.createSchedule({ id: 'keep', name: 'k', message: 'm', target: convTarget(conv), rule: daily, enabled: false });
    assert.equal((await one.svc.runs('keep')).body.runs.length, 20);
  });
});

test('schedule tool: list, create, update, pause, resume and delete', { timeout: 90_000 }, async () => {
  await withEnv(async ({ open }) => {
    const one = await open();
    const { conv, ws } = await seed(one, 'Release chat');
    const harnessId = (await one.store.getConversation(conv.id)).harnessId;
    const tool = createScheduleTool({ service: one.svc });
    const run = async (args) => {
      const result = await tool.execute(args, { conversationId: harnessId }, one.kernel.context);
      return { text: result.output.map((part) => part.text).join(''), isError: Boolean(result.isError) };
    };

    assert.deepEqual(await run({ action: 'list' }), { text: 'No scheduled tasks.', isError: false });

    // The target defaults to the current conversation, and the creator is the agent.
    const created = await run({
      action: 'create',
      name: 'Check CI',
      message: 'look at the CI status',
      rule: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' },
    });
    assert.equal(created.isError, false, created.text);
    assert.match(created.text, /^Created schedule "Check CI" \(id: sched-[0-9a-f]+\)/);
    assert.match(created.text, /weekly on Mon,Tue,Wed,Thu,Fri at 09:00/);
    assert.match(created.text, /next run 2026-03-10 09:00/);
    assert.match(created.text, /conversation "Release chat"/);
    const [made] = await one.svc.list();
    assert.equal(made.createdBy, 'agent');
    assert.deepEqual(made.target, { kind: 'conversation', conversationId: conv.id, title: 'Release chat' });
    const id = made.id;

    const listed = await run({ action: 'list' });
    assert.match(listed.text, new RegExp(`^- "Check CI" \\(id: ${id}\\): weekly on .*next run 2026-03-10 09:00.*created by agent`));

    const updated = await run({ action: 'update', id, name: 'Check CI daily', rule: { kind: 'interval', everyMinutes: 90 } });
    assert.match(updated.text, new RegExp(`^Updated schedule "Check CI daily" \\(id: ${id}\\): every 90 minutes`));
    assert.equal((await one.svc.get(id)).createdBy, 'agent');
    const toNew = await run({ action: 'update', id, target: { kind: 'new', workspaceId: ws.id } });
    assert.equal(toNew.isError, false, toNew.text);
    assert.match(toNew.text, /Updated schedule/);

    const paused = await run({ action: 'pause', id });
    assert.match(paused.text, new RegExp(`^Paused schedule "Check CI daily" \\(id: ${id}\\).*paused`));
    assert.equal((await one.svc.get(id)).enabled, false);
    const resumed = await run({ action: 'resume', id });
    assert.match(resumed.text, /^Resumed schedule/);
    assert.equal((await one.svc.get(id)).enabled, true);

    // A once time given as local text.
    const once = await run({ action: 'create', name: 'Once', message: 'm', rule: { kind: 'once', at: '2026-03-12 15:45' } });
    assert.match(once.text, /once at 2026-03-12 15:45/);

    const deleted = await run({ action: 'delete', id });
    assert.match(deleted.text, new RegExp(`^Deleted schedule "Check CI daily" \\(id: ${id}\\)`));
    assert.equal(await one.svc.get(id), null);

    // Errors come back as tool errors, with the field names.
    const tooFast = await run({ action: 'create', name: 'Fast', message: 'm', rule: { kind: 'interval', everyMinutes: 1 } });
    assert.equal(tooFast.isError, true);
    assert.match(tooFast.text, /at least 5 minutes.*rule\.everyMinutes/);
    assert.equal((await run({ action: 'update' })).isError, true);
    assert.equal((await run({ action: 'pause', id: 'nope' })).isError, true);
    assert.equal((await run({ action: 'update', id: made.id })).isError, true);
  });
});

test('schedule tool in a real run: offered to the main agent only, and shown as a schedule row', { timeout: 90_000 }, async () => {
  await withEnv(async ({ dataDir, open }) => {
    const script = path.join(dataDir, 'script.json');
    const record = path.join(dataDir, 'record.jsonl');
    await writeFile(script, JSON.stringify({
      turns: [
        { when: 'SET-SCHEDULE', tool: 'schedule', args: { action: 'create', name: 'Check CI', message: 'look at CI', rule: { kind: 'daily', time: '09:00' } } },
        { when: 'SET-SCHEDULE', text: 'scheduled it' },
        { when: 'SPAWN-CHILD', tool: 'task', args: { description: 'Child check', prompt: 'CHILD-TASK say hi' } },
        { when: 'SPAWN-CHILD', text: 'parent done' },
        { when: 'CHILD-TASK', text: 'child done' },
      ],
    }));
    const one = await open({ env: { WEFT_FAUX_SCRIPT: script, WEFT_FAUX_RECORD: record } });
    const { conv } = await seed(one, 'Plan');
    const sent = await one.kernel.postMessage(conv, 'please SET-SCHEDULE');
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const made = await until(async () => (await one.svc.list())[0], { label: 'schedule created by the agent' });
    assert.equal(made.createdBy, 'agent');
    assert.equal(made.target.conversationId, conv.id);
    assert.equal(made.name, 'Check CI');
    const done = await until(async () => {
      const row = await one.store.getConversation(conv.id);
      const view = await one.kernel.present(row, { includeMessages: true });
      return view.status === 'done' ? view : null;
    }, { label: 'run done' });

    // The thread view: kind schedule, a heading in the mock's wording, and the id for the jump.
    const call = (done.messages || []).map((m) => m.tool).find((tool) => tool?.name === 'schedule');
    assert.ok(call, JSON.stringify(done.messages));
    const view = toolCallView(call, [call], { lang: 'zh' });
    assert.equal(view.kind, 'schedule');
    assert.equal(view.scheduleId, made.id);
    assert.equal(view.heading.title, '新建「Check CI」');
    assert.equal(view.hint.text, '已创建');
    assert.equal(toolCallView(call, [call], { lang: 'en' }).heading.title, 'Create "Check CI"');
    assert.equal(summarizeToolGroup([call], 'zh').text, '定时任务');

    // Sub-agents do not get the tool.
    const other = await one.kernel.createConversation({ workspaceId: conv.workspaceId, workspacePath: conv.workspacePath, title: 'Dispatch' });
    const spawned = await one.kernel.postMessage(other, 'please SPAWN-CHILD');
    assert.equal(spawned.status, 202);
    const records = await until(async () => {
      const lines = (await readFile(record, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      return lines.some((row) => !(row.tools || []).includes('task') && JSON.stringify(row).includes('CHILD-TASK')) ? lines : null;
    }, { label: 'child request' });
    const parentCall = records.find((row) => (row.tools || []).includes('task'));
    const childCall = records.find((row) => !(row.tools || []).includes('task'));
    assert.equal(parentCall.tools.includes('schedule'), true);
    assert.equal(childCall.tools.includes('schedule'), false);
    assert.equal(CHILD_HIDDEN_TOOLS.has('schedule'), true);
  });
});

test('a sleeping schedule task is not active work, so it does not block a service restart', { timeout: 60_000 }, async () => {
  await withEnv(async ({ open }) => {
    const one = await open();
    const { conv } = await seed(one);
    await one.svc.create({ name: 'Idle', message: 'm', target: convTarget(conv), rule: daily });
    assert.equal(await one.kernel.hasActiveWork(), false);
  });
});

test('deleting a conversation pauses the schedules that send to it right away', { timeout: 60_000 }, async () => {
  await withEnv(async ({ open }) => {
    let announced = 0;
    const one = await open({ onSchedulesChanged: () => { announced += 1; } });
    const { conv, ws } = await seed(one);
    const other = await one.kernel.createConversation({ workspaceId: ws.id, workspacePath: ws.path, title: 'other' });
    const hit = (await one.svc.create({ name: 'Hit', message: 'm', target: convTarget(conv), rule: daily })).body.id;
    const hit2 = (await one.svc.create({ name: 'Hit2', message: 'm', target: convTarget(conv), rule: { kind: 'interval', everyMinutes: 30 } })).body.id;
    const miss = (await one.svc.create({ name: 'Miss', message: 'm', target: convTarget(other), rule: daily })).body.id;
    const fresh = (await one.svc.create({ name: 'Fresh', message: 'm', target: { kind: 'new', workspaceId: ws.id }, rule: daily })).body.id;
    for (const id of [hit, hit2, miss, fresh]) await asleep(one, id);
    const tasks = Object.fromEntries(await Promise.all([hit, hit2, miss].map(async (id) => [id, (await rowOf(one, id)).taskId])));
    const seen = announced;

    const deleted = await one.kernel.deleteConversation(conv.id);
    assert.equal(deleted.status, 204);

    for (const id of [hit, hit2]) {
      const view = await one.svc.get(id);
      assert.equal(view.enabled, false);
      assert.equal(view.nextRunAt, null);
      assert.equal(view.lastRun.status, 'failed');
      assert.equal(view.lastRun.error, 'Target conversation was deleted');
      await until(() => isAborted(one, tasks[id]), { label: 'task aborted' });
    }
    assert.equal((await one.svc.get(miss)).enabled, true);
    assert.equal((await one.svc.get(fresh)).enabled, true);
    assert.equal(await isAborted(one, tasks[miss]), false);
    assert.ok(announced > seen, 'the schedules topic is told');

    // Switching one back on is refused while its target is gone.
    const back = await one.svc.update(hit, { enabled: true });
    assert.equal(back.status, 400);
    assert.deepEqual(back.body.fields, ['target.conversationId']);
  });
});
