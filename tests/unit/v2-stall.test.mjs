import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compileSchema } from '../../src/v2/validate.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import { attachConversationTopic } from '../../src/v2/stream/conversation-topic.ts';
import { createStallWatch } from '../../src/v2/stream/stall-watch.ts';
import { ROOT } from './_root.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));

function rewriteRefs(node) {
  if (Array.isArray(node)) {
    for (const item of node) rewriteRefs(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/schemas/')) {
    node.$ref = `#/$defs/${node.$ref.slice('#/components/schemas/'.length)}`;
  }
  for (const value of Object.values(node)) rewriteRefs(value);
}

function compileNamed(name) {
  const schemas = structuredClone(spec.components.schemas);
  const schema = schemas[name];
  assert.ok(schema, `missing schema ${name}`);
  rewriteRefs(schema);
  rewriteRefs(schemas);
  return compileSchema({ ...schema, $defs: schemas });
}

function assertSchema(name, data) {
  const validate = compileNamed(name);
  assert.equal(validate(data), true, `${name}: ${JSON.stringify(validate.errors)}`);
}

function createFakeClock(start = 1_000_000) {
  let now = start;
  const timers = [];
  return {
    now: () => now,
    set(value) { now = value; },
    advance(ms) { now += ms; },
    setTimer(fn, ms) {
      const handle = { fn, fireAt: now + ms, cancelled: false };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) { handle.cancelled = true; },
    fireDue() {
      const t = now;
      const due = timers.filter((item) => !item.cancelled && item.fireAt <= t);
      for (const item of due) {
        item.cancelled = true;
        item.fn();
      }
    },
  };
}

async function drain() {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitUntil(pred, label, inspect) {
  for (let i = 0; i < 80; i++) {
    if (pred()) return;
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    // Coalesce uses real setTimeout(0), not the fake clock. A setImmediate-only
    // pump can finish in < 1ms and miss it (CI: frames.length 2 !== 1).
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`${label}${inspect ? `: ${inspect()}` : ''}`);
}

function presentedFixture(over = {}) {
  return {
    id: 'c1',
    workspaceId: 'w1',
    workspacePath: '',
    title: 't',
    updatedAt: 1,
    status: 'idle',
    messages: [],
    usage: null,
    ...over,
  };
}

function conversationUpserts(frames) {
  return frames.filter((frame) => (
    frame.event === 'upsert'
    && frame.data?.entity === 'conversation'
  ));
}

function inspectRuns(frames) {
  const snap = frames.find((frame) => frame.event === 'snapshot');
  const snapRun = snap?.data?.entities?.find((item) => item.entity === 'conversation')?.value?.run;
  return JSON.stringify({
    snap: snapRun,
    upserts: conversationUpserts(frames).map((frame) => frame.data.value?.run),
  });
}

function setupTopic({ clock, stallAfterMs = 500, presented, stall } = {}) {
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  const listeners = new Set();
  const data = {
    presented: presented || presentedFixture({ status: 'running' }),
    subagents: [],
    modelTarget: null,
    window: 128000,
  };
  const watchOpts = {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
  if (stallAfterMs != null) watchOpts.stallAfterMs = stallAfterMs;
  const watch = stall || createStallWatch(watchOpts);
  const topicOpts = {
    loadConversation: async (id) => (id === 'c1' ? data : null),
    subscribe: (_cid, fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    coalesceMs: 0,
    textDeltaMs: 50,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    stall: watch,
    log() {},
  };
  if (stallAfterMs != null) topicOpts.stallAfterMs = stallAfterMs;
  const topic = attachConversationTopic(hub, topicOpts);
  return {
    hub,
    topic,
    watch,
    data,
    emit(ev) {
      for (const fn of listeners) fn(ev);
    },
  };
}

test('stall watch does not schedule without subscribers; schedules and clears with retain/release', () => {
  const clock = createFakeClock();
  const fired = [];
  const watch = createStallWatch({
    stallAfterMs: 500,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  watch.listen((cid) => fired.push(cid));
  watch.sync('c1', { running: true, lastActivityAt: clock.now() });
  assert.equal(watch.timerCount(), 0);

  watch.retain('c1');
  watch.sync('c1', { running: true, lastActivityAt: clock.now() });
  assert.equal(watch.timerCount('c1'), 1);
  assert.equal(watch.timerCount(), 1);

  watch.release('c1');
  assert.equal(watch.timerCount(), 0);
  assert.deepEqual(fired, []);
  watch.dispose();
});

test('in-process: run with no events past threshold upserts stalledSince once', async () => {
  const clock = createFakeClock();
  const { hub, topic, watch } = setupTopic({ clock });
  try {
    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    const snap = frames.find((frame) => frame.event === 'snapshot');
    const conv = snap.data.entities.find((item) => item.entity === 'conversation');
    assert.ok(conv);
    assertSchema('ConversationView', conv.value);
    assert.equal(conv.value.run.status, 'running');
    assert.equal(conv.value.run.stalledSince, null);
    assert.equal(conv.value.run.lastActivityAt, clock.now());
    assert.equal(watch.timerCount('c1'), 1);

    const started = conv.value.run.lastActivityAt;
    clock.advance(501);
    clock.fireDue();
    await waitUntil(
      () => conversationUpserts(frames).some((frame) => frame.data.value?.run?.stalledSince != null),
      'stall upsert',
      () => inspectRuns(frames),
    );

    const stallFrames = conversationUpserts(frames).filter((frame) => frame.data.value?.run?.stalledSince != null);
    assert.equal(stallFrames.length, 1, inspectRuns(frames));
    assert.equal(stallFrames[0].data.value.run.stalledSince, started);
    assert.equal(stallFrames[0].data.value.run.lastActivityAt, started);
    assertSchema('ConversationView', stallFrames[0].data.value);
    assertSchema('RunState', stallFrames[0].data.value.run);
    assert.equal(watch.timerCount('c1'), 0);

    clock.advance(500);
    clock.fireDue();
    await drain();
    const stallAgain = conversationUpserts(frames).filter((frame) => frame.data.value?.run?.stalledSince != null);
    assert.equal(stallAgain.length, 1, inspectRuns(frames));

    session.close();
    assert.equal(watch.timerCount(), 0);
  } finally {
    topic.dispose();
    watch.dispose();
    hub.dispose();
  }
});

test('in-process: tool output after stall clears stalledSince and upserts', async () => {
  const clock = createFakeClock();
  const { hub, topic, watch, emit } = setupTopic({ clock });
  try {
    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    clock.advance(501);
    clock.fireDue();
    await waitUntil(
      () => conversationUpserts(frames).some((frame) => frame.data.value?.run?.stalledSince != null),
      'stall upsert',
      () => inspectRuns(frames),
    );
    const before = conversationUpserts(frames).length;

    emit({ event: 'tool.delta', data: { toolId: 'bash-1', append: 'ok' } });
    await waitUntil(
      () => conversationUpserts(frames).some((frame, i) => (
        i >= 0
        && frame.data.value?.run?.stalledSince == null
        && frame.data.value?.run?.lastActivityAt === clock.now()
      )),
      'unstall upsert',
      () => inspectRuns(frames),
    );
    const afterStall = conversationUpserts(frames).slice(before);
    const cleared = afterStall.filter((frame) => frame.data.value?.run?.stalledSince == null);
    assert.equal(cleared.length >= 1, true, inspectRuns(frames));
    assert.equal(cleared[0].data.value.run.lastActivityAt, clock.now());
    assertSchema('ConversationView', cleared[0].data.value);
    assert.equal(watch.timerCount('c1'), 1);

    session.close();
  } finally {
    topic.dispose();
    watch.dispose();
    hub.dispose();
  }
});

test('in-process: coalesced text.delta counts as activity and clears stall', async () => {
  const clock = createFakeClock();
  const { hub, topic, watch, emit } = setupTopic({ clock });
  try {
    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    clock.advance(501);
    clock.fireDue();
    await waitUntil(
      () => conversationUpserts(frames).some((frame) => frame.data.value?.run?.stalledSince != null),
      'stall upsert',
      () => inspectRuns(frames),
    );

    emit({ event: 'message.delta', data: { messageId: 'live-1', text: 'ab' } });
    await drain();
    clock.fireDue();
    await waitUntil(
      () => conversationUpserts(frames).some((frame) => (
        frame.data.value?.run?.stalledSince == null
        && frame.data.value?.run?.lastActivityAt === clock.now()
      )),
      'text unstall',
      () => inspectRuns(frames),
    );
    const cleared = [...conversationUpserts(frames)].reverse().find((frame) => (
      frame.data.value?.run?.stalledSince == null
    ));
    assert.ok(cleared, inspectRuns(frames));
    assert.equal(cleared.data.value.run.lastActivityAt, clock.now());
    assert.equal(watch.timerCount('c1'), 1);
    const text = frames.filter((frame) => frame.event === 'text.delta');
    assert.equal(text.length >= 1, true, JSON.stringify(text));

    session.close();
  } finally {
    topic.dispose();
    watch.dispose();
    hub.dispose();
  }
});

test('in-process: run end clears the stall timer', async () => {
  const clock = createFakeClock();
  const { hub, topic, watch, emit, data } = setupTopic({ clock });
  try {
    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    assert.equal(watch.timerCount('c1'), 1);

    data.presented = presentedFixture({ status: 'done' });
    emit({ event: 'status', data: { status: 'done' } });
    // Timer clears in applyStatus (microtask); idle upsert is coalesce + recompute.
    await waitUntil(
      () => (
        watch.timerCount() === 0
        && conversationUpserts(frames).some((frame) => frame.data.value?.run?.status !== 'running')
      ),
      'run end clears stall and upserts idle',
      () => `timers=${watch.timerCount()} ${inspectRuns(frames)}`,
    );

    const before = frames.length;
    clock.advance(501);
    clock.fireDue();
    await drain();
    assert.equal(watch.timerCount(), 0);
    assert.equal(frames.length, before);
    const stalled = conversationUpserts(frames).filter((frame) => frame.data.value?.run?.stalledSince != null);
    assert.equal(stalled.length, 0, inspectRuns(frames));

    session.close();
  } finally {
    topic.dispose();
    watch.dispose();
    hub.dispose();
  }
});

test('in-process: last subscriber leaving clears the stall timer', async () => {
  const clock = createFakeClock();
  const { hub, topic, watch } = setupTopic({ clock });
  try {
    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    assert.equal(watch.timerCount('c1'), 1);
    session.close();
    assert.equal(watch.timerCount(), 0);
  } finally {
    topic.dispose();
    watch.dispose();
    hub.dispose();
  }
});

test('in-process: WEFT_MAIN_STALL_MS sets the threshold', async () => {
  const prev = process.env.WEFT_MAIN_STALL_MS;
  process.env.WEFT_MAIN_STALL_MS = '250';
  const clock = createFakeClock();
  const watch = createStallWatch({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const { hub, topic } = setupTopic({ clock, stall: watch, stallAfterMs: null });
  try {
    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    clock.advance(250);
    clock.fireDue();
    await drain();
    assert.equal(
      conversationUpserts(frames).some((frame) => frame.data.value?.run?.stalledSince != null),
      false,
      inspectRuns(frames),
    );

    clock.advance(1);
    clock.fireDue();
    await waitUntil(
      () => conversationUpserts(frames).some((frame) => frame.data.value?.run?.stalledSince != null),
      'env stall upsert',
      () => inspectRuns(frames),
    );
    session.close();
  } finally {
    if (prev == null) delete process.env.WEFT_MAIN_STALL_MS;
    else process.env.WEFT_MAIN_STALL_MS = prev;
    topic.dispose();
    watch.dispose();
    hub.dispose();
  }
});

test('in-process: activeTool is set between tool.start and tool.end', async () => {
  const clock = createFakeClock();
  const { hub, topic, watch, emit, data } = setupTopic({ clock });
  try {
    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    const startedAt = clock.now();
    data.presented = presentedFixture({
      status: 'running',
      messages: [
        { id: 'u1', role: 'user', text: 'run' },
        {
          id: 't1',
          role: 'tool',
          tool: {
            id: 'bash-1',
            name: 'bash',
            status: 'running',
            input: { command: 'npm test' },
          },
        },
      ],
    });
    emit({
      event: 'tool.start',
      data: { tool: { id: 'bash-1', name: 'bash', status: 'running', input: { command: 'npm test' } } },
    });
    await drain();
    clock.fireDue();
    await waitUntil(
      () => conversationUpserts(frames).some((frame) => frame.data.value?.run?.activeTool?.name === 'bash'),
      'activeTool upsert',
      () => inspectRuns(frames),
    );
    const live = [...conversationUpserts(frames)].reverse().find((frame) => frame.data.value?.run?.activeTool);
    assert.ok(live, inspectRuns(frames));
    assert.deepEqual(live.data.value.run.activeTool, {
      name: 'bash',
      startedAt,
      summary: 'npm test',
    });
    assertSchema('RunState', live.data.value.run);

    data.presented = presentedFixture({
      status: 'running',
      messages: [
        { id: 'u1', role: 'user', text: 'run' },
        {
          id: 't1',
          role: 'tool',
          tool: {
            id: 'bash-1',
            name: 'bash',
            status: 'completed',
            input: { command: 'npm test' },
            output: { text: 'ok' },
          },
        },
      ],
    });
    emit({
      event: 'tool.end',
      data: { tool: { id: 'bash-1', name: 'bash', status: 'completed' } },
    });
    await drain();
    clock.fireDue();
    await waitUntil(
      () => conversationUpserts(frames).some((frame) => (
        frame.data.value?.run?.activeTool == null
        && frame.data.value?.run?.status === 'running'
      )),
      'activeTool cleared',
      () => inspectRuns(frames),
    );
    const cleared = [...conversationUpserts(frames)].reverse().find((frame) => (
      frame.data.value?.run?.status === 'running'
      && frame.data.value?.run?.activeTool == null
    ));
    assert.ok(cleared, inspectRuns(frames));
    assert.equal(cleared.data.value.run.activeTool, null);
    assert.equal(watch.timerCount('c1'), 1);

    session.close();
  } finally {
    topic.dispose();
    watch.dispose();
    hub.dispose();
  }
});
