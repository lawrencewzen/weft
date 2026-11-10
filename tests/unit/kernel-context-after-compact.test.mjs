// After compaction or reset, the context chip follows the active transcript
// immediately. A call kept from before the head still reports the old prefix.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import {
  createMapContext,
  createViewProjector,
  projectViewUpdate,
} from '../../src/kernel/events.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { activeContextUsage } from '../../src/kernel/usage.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { compactionView } from '../../src/v2/views/compaction.ts';
import { conversationSnapshot } from '../../src/v2/views/conversation.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import { attachConversationTopic } from '../../src/v2/stream/conversation-topic.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { ROOT } from './_root.mjs';
import { withHarnessLock } from './_harness-lock.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage(total) {
  return { total_tokens: total, prompt_tokens: total - 1000, completion_tokens: 1000 };
}

function repeated(turn, count) {
  return Array.from({ length: count }, () => ({ ...turn }));
}

function assistant(id, total) {
  return {
    id,
    kind: 'pi.assistant',
    model: [{
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stopReason: 'stop',
      usage: {
        input: total - 1000,
        output: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: total,
      },
    }],
  };
}

function estimatedTokens(view) {
  let tokens = 0;
  for (const message of view?.messages || []) tokens += estimateMessageTokens(message);
  return tokens;
}

test('activeContextUsage estimates the head and then uses the next reported call', () => {
  const summary = { role: 'user', content: 'summary of the prefix', timestamp: 50 };
  const keptUser = { role: 'user', content: 'kept', timestamp: 10 };
  const keptAssistant = {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    stopReason: 'stop',
    timestamp: 11,
    usage: { input: 69000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 70000 },
  };
  const open = {
    entries: [assistant(2, 70000)],
    messages: [keptUser, keptAssistant],
  };
  assert.equal(activeContextUsage(open).totalTokens, 70000);

  const compacted = {
    head: { id: 9, kind: 'pi.compaction' },
    entries: [{ id: 9, kind: 'pi.compaction' }, assistant(4, 70000)],
    messages: [summary, keptUser, keptAssistant],
  };
  const estimated = activeContextUsage(compacted);
  const sum = estimateMessageTokens(summary) + estimateMessageTokens(keptUser) + estimateMessageTokens(keptAssistant);
  assert.equal(estimated.totalTokens, sum);
  assert.notEqual(estimated.totalTokens, 70000);

  const answered = {
    ...compacted,
    entries: [...compacted.entries, assistant(12, 8000)],
  };
  assert.equal(activeContextUsage(answered).totalTokens, 8000);

  const handoff = { role: 'user', content: 'handoff note', timestamp: 3 };
  const reset = {
    head: { id: 5, kind: 'pi.reset' },
    entries: [{ id: 5, kind: 'pi.reset' }, assistant(2, 70000)],
    messages: [handoff],
  };
  assert.equal(activeContextUsage(reset).totalTokens, estimateMessageTokens(handoff));
  assert.equal(activeContextUsage(open).totalTokens, 70000);
});

test('projectViewUpdate emits reset when a pi.reset entry is appended', () => {
  const projector = createViewProjector();
  const ctx = createMapContext();
  const user = { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'hi' }] };
  const opened = projectViewUpdate(projector, { entries: [user], docs: {} }, ctx);
  assert.equal(opened.events.some((event) => event.event === 'reset'), false);
  const reset = {
    id: 2,
    kind: 'pi.reset',
    head: 'self',
    model: [{ role: 'user', content: 'handoff', timestamp: 3 }],
  };
  const next = projectViewUpdate(projector, { entries: [user, reset], docs: {} }, ctx);
  assert.deepEqual(next.events.filter((event) => event.event === 'reset'), [
    { event: 'reset', data: { entryId: '2' } },
  ]);
  assert.equal(next.events.some((event) => event.event === 'message.done'), false);
});

async function writeScript(dir, turns) {
  const file = path.join(dir, 'turns.json');
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

async function openKernel(dataDir, script) {
  const store = createSqliteStore(dataDir);
  const kernel = await openConversationKernel({
    dataDir,
    store,
    demo: true,
    extensions: createExtensionHost({
      skillDirs: [path.join(ROOT, 'skills')],
      getSettings: () => store.getSettings(),
    }),
    getSettings: () => store.getSettings(),
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: script,
      WEFT_RETRY_MAX: '1',
      WEFT_RETRY_BASE_MS: '1',
    },
  });
  return { dataDir, store, kernel };
}

async function closeOpened(opened) {
  if (opened?.kernel) await opened.kernel.close();
  if (opened?.store) opened.store.close();
  if (opened?.dataDir) await rm(opened.dataDir, { recursive: true, force: true });
}

async function makeConversation(store, kernel, dataDir) {
  const wsPath = path.join(dataDir, 'ws');
  await mkdir(wsPath, { recursive: true });
  const ws = await store.createWorkspace({ name: 'ctx', path: wsPath });
  const conv = await kernel.createConversation({
    workspaceId: ws.id,
    workspacePath: wsPath,
    title: 'ctx',
  });
  return conv;
}

async function waitStatus(kernel, store, id, ready, timeout = 20000) {
  const started = Date.now();
  let body = null;
  while (Date.now() - started < timeout) {
    const live = await store.getConversation(id);
    body = await kernel.present(live, { includeMessages: true });
    if (ready(body)) return body;
    await sleep(30);
  }
  return body;
}

async function say(kernel, store, conv, text) {
  const posted = await kernel.postMessage(conv, text);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const done = await waitStatus(kernel, store, conv.id, (body) => body.status === 'done' || body.status === 'failed');
  assert.equal(done.status, 'done', JSON.stringify(done.llmError || done.status));
  return done;
}

async function contextOf(kernel, store, conv) {
  const live = await store.getConversation(conv.id);
  const presented = await kernel.present(live, { includeMessages: true });
  const snap = await conversationSnapshot({
    presented,
    subagents: await kernel.listSubagents(live),
    window: 128000,
  });
  return snap.conversation.context;
}

async function activeView(kernel, conv) {
  const handle = await kernel.harness.conversation(conv.harnessId, kernel.context);
  return { handle, view: await handle.context(kernel.context) };
}

function watchTopic(kernel, store, conv) {
  const frames = [];
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  const topic = attachConversationTopic(hub, {
    loadConversation: async (cid) => {
      const row = await store.getConversation(cid);
      if (!row) return null;
      const presented = await kernel.present(row, { includeMessages: true });
      return {
        presented,
        subagents: await kernel.listSubagents(row),
        window: 128000,
      };
    },
    subscribe: (cid, fn) => kernel.subscribe(cid, fn),
    coalesceMs: 20,
    log() {},
  });
  const session = hub.connect({
    topics: [`conversation:${conv.id}`],
    lang: 'zh',
    send: (frame) => frames.push(frame),
  });
  return {
    frames,
    ready: session.ready,
    close() {
      session.close();
      topic.dispose();
      hub.dispose();
    },
  };
}

function conversationUpserts(frames) {
  return frames.filter((frame) => frame.event === 'upsert' && frame.data?.entity === 'conversation');
}

async function settleManual(kernel, conv) {
  const { handle } = await activeView(kernel, conv);
  const taskId = await handle.compact(undefined, kernel.context);
  const task = await kernel.harness.waitForTask(taskId, kernel.context);
  assert.equal(task?.state?.outcome?.status, 'completed', JSON.stringify(task?.state?.outcome));
  const submissionId = task.state.outcome.result?.submissionId;
  assert.ok(submissionId != null, JSON.stringify(task.state.outcome.result));
  const submission = await kernel.harness.submission(submissionId, kernel.context);
  const placed = await submission.wait(kernel.context);
  assert.equal(placed.status, 'done', JSON.stringify(placed));
  return handle;
}

test('manual compact drops the context percent before the next reply and reset does too', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-ctx-manual-'));
    const script = await writeScript(dataDir, [
      { text: 'EARLY_REPLY', usage: usage(70000) },
      { text: 'SECOND_REPLY', usage: usage(70000) },
      { text: 'PAD_REPLY', usage: usage(70000) },
      { text: 'KEPT_REPLY', usage: usage(70000) },
      ...repeated({ text: 'AFTER_REPLY', when: 'AFTER_UNIQUE', usage: usage(8000) }, 8),
    ]);
    let opened = null;
    let topic = null;
    try {
      opened = await openKernel(dataDir, script);
      const { store, kernel } = opened;
      const stored = await store.putSettings({ compaction: { triggerPercent: 90 } });
      await kernel.noteSettings(stored);
      const conv = await makeConversation(store, kernel, dataDir);
      await say(kernel, store, conv, 'EARLY_A remember');
      await say(kernel, store, conv, 'EARLY_B second');
      await say(kernel, store, conv, `PAD_UNIQUE\n${'p'.repeat(80_000)}`);
      await say(kernel, store, conv, 'KEPT_UNIQUE');
      const before = await contextOf(kernel, store, conv);
      assert.equal(before.used, 70000, JSON.stringify(before));
      assert.equal(before.percent, 55);

      topic = watchTopic(kernel, store, conv);
      await topic.ready;
      const mark = topic.frames.length;
      await settleManual(kernel, conv);
      const { view } = await activeView(kernel, conv);
      assert.equal((view.entries || []).some((entry) => entry?.kind === 'pi.compaction'), true);
      const tokens = estimatedTokens(view);
      const after = await contextOf(kernel, store, conv);
      assert.equal(after.used, tokens, JSON.stringify(after));
      assert.ok(after.used < before.used, JSON.stringify({ before, after }));
      assert.ok(after.percent < before.percent, JSON.stringify({ before, after }));
      assert.ok(after.percent < 40, JSON.stringify(after));

      await sleep(200);
      const pushed = conversationUpserts(topic.frames.slice(mark));
      assert.ok(pushed.length > 0, JSON.stringify(topic.frames.slice(mark).map((frame) => frame.event)));
      const last = pushed[pushed.length - 1];
      assert.equal(last.data.value.context.used, tokens, JSON.stringify(last.data.value.context));
      assert.equal(last.data.value.context.percent, after.percent);

      await say(kernel, store, conv, 'AFTER_UNIQUE next');
      const replied = await contextOf(kernel, store, conv);
      assert.equal(replied.used, 8000, JSON.stringify(replied));
      assert.equal(replied.percent, 6);

      const kernelEvents = [];
      const unsub = kernel.subscribe(conv.id, (event) => kernelEvents.push(event));
      const resetMark = topic.frames.length;
      const handle = (await activeView(kernel, conv)).handle;
      try {
        await handle.reset('交接说明 '.repeat(400), kernel.context);
        let resetView = null;
        for (let i = 0; i < 100; i += 1) {
          resetView = await handle.context(kernel.context);
          if ((resetView.entries || []).some((entry) => entry?.kind === 'pi.reset')) break;
          await sleep(30);
        }
        assert.equal((resetView.entries || []).some((entry) => entry?.kind === 'pi.reset'), true);
        const resetTokens = estimatedTokens(resetView);
        const resetCtx = await contextOf(kernel, store, conv);
        assert.equal(resetCtx.used, resetTokens, JSON.stringify(resetCtx));
        assert.ok(resetCtx.used > 0, JSON.stringify(resetCtx));
        assert.ok(resetCtx.used < replied.used, JSON.stringify({ resetCtx, replied }));
        assert.equal(kernelEvents.some((event) => event.event === 'reset'), true, JSON.stringify(kernelEvents));
        await sleep(200);
        const resetPush = conversationUpserts(topic.frames.slice(resetMark));
        assert.ok(resetPush.length > 0, JSON.stringify(topic.frames.slice(resetMark).map((frame) => frame.event)));
        assert.equal(resetPush[resetPush.length - 1].data.value.context.used, resetTokens);
        assert.equal(resetPush[resetPush.length - 1].data.value.context.percent, resetCtx.percent);
      } finally {
        unsub();
      }
    } finally {
      topic?.close();
      await closeOpened(opened);
    }
  });
});

test('automatic compaction drops the context percent before the next reply', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-ctx-auto-'));
    const script = await writeScript(dataDir, [
      { text: 'EARLY_REPLY', usage: usage(84000) },
      { text: 'PAD_REPLY', usage: usage(84000) },
      ...repeated({ text: 'NEXT_REPLY', when: 'AFTER_AUTO', usage: usage(8000) }, 8),
    ]);
    let opened = null;
    try {
      opened = await openKernel(dataDir, script);
      const { store, kernel } = opened;
      const stored = await store.putSettings({ compaction: { triggerPercent: 80 } });
      await kernel.noteSettings(stored);
      const conv = await makeConversation(store, kernel, dataDir);
      await say(kernel, store, conv, 'EARLY_AUTO remember');
      const primed = await contextOf(kernel, store, conv);
      assert.equal(primed.used, 84000, JSON.stringify(primed));
      // The pad is recent and large enough to leave the early turn outside
      // keepRecent, while 84000 plus that pad stays under the blocking line.
      await say(kernel, store, conv, `PAD_AUTO\n${'p'.repeat(80_000)}`);

      const handle = await kernel.harness.conversation(conv.harnessId, kernel.context);
      let view = null;
      const started = Date.now();
      while (Date.now() - started < 15000) {
        view = await handle.context(kernel.context);
        if ((view.entries || []).some((entry) => entry?.kind === 'pi.compaction')) break;
        await sleep(40);
      }
      assert.equal(
        (view.entries || []).some((entry) => entry?.kind === 'pi.compaction'),
        true,
        `no automatic summary: ${(view.entries || []).map((entry) => entry?.kind).join(',')}`,
      );
      const tokens = estimatedTokens(view);
      const after = await contextOf(kernel, store, conv);
      assert.equal(after.used, tokens, JSON.stringify(after));
      assert.ok(after.used < 84000, JSON.stringify(after));
      assert.ok(after.percent < primed.percent, JSON.stringify({ primed, after }));

      await say(kernel, store, conv, 'AFTER_AUTO next');
      const replied = await contextOf(kernel, store, conv);
      assert.equal(replied.used, 8000, JSON.stringify(replied));
      assert.equal(replied.percent, 6);
    } finally {
      await closeOpened(opened);
    }
  });
});

test('a failed compaction keeps the previous context percent', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-ctx-fail-'));
    const script = await writeScript(dataDir, [
      { text: 'STABLE_REPLY', usage: usage(70000) },
      // The summarizer's user message is the only one that contains this tag.
      ...repeated({ when: '<conversation>', error: 'summarizer broke' }, 4),
    ]);
    let opened = null;
    let topic = null;
    try {
      opened = await openKernel(dataDir, script);
      const { store, kernel } = opened;
      const stored = await store.putSettings({ compaction: { triggerPercent: 90 } });
      await kernel.noteSettings(stored);
      const conv = await makeConversation(store, kernel, dataDir);
      await say(kernel, store, conv, 'STABLE_FIRST');
      const before = await contextOf(kernel, store, conv);
      assert.equal(before.used, 70000, JSON.stringify(before));
      assert.equal(before.percent, 55);

      topic = watchTopic(kernel, store, conv);
      await topic.ready;
      const mark = topic.frames.length;
      const posted = await kernel.postMessage(conv, `OVERFLOW\n${'q'.repeat(180_000)}`);
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      const failed = await waitStatus(
        kernel,
        store,
        conv.id,
        (body) => body.status === 'failed' || body.status === 'done',
      );
      assert.equal(failed.status, 'failed', JSON.stringify(failed.llmError || failed.status));
      const { view } = await activeView(kernel, conv);
      assert.equal((view.entries || []).some((entry) => entry?.kind === 'pi.compaction'), false);
      const after = await contextOf(kernel, store, conv);
      assert.equal(after.used, before.used, JSON.stringify(after));
      assert.equal(after.percent, before.percent, JSON.stringify(after));
      const live = compactionView(kernel.liveStateFor(conv.id), 'zh');
      assert.equal(live.state, 'failed', JSON.stringify(live));

      await sleep(200);
      const pushed = conversationUpserts(topic.frames.slice(mark));
      assert.ok(pushed.length > 0, JSON.stringify(topic.frames.slice(mark).map((frame) => frame.event)));
      for (const frame of pushed) {
        assert.equal(frame.data.value.context.used, before.used, JSON.stringify(frame.data.value.context));
        assert.equal(frame.data.value.context.percent, before.percent);
      }
      const failedFrame = pushed.find((frame) => frame.data.value?.run?.compaction?.state === 'failed');
      assert.ok(failedFrame, JSON.stringify(pushed.map((frame) => frame.data.value?.run?.compaction)));
    } finally {
      topic?.close();
      await closeOpened(opened);
    }
  });
});

test('handoff drops the context percent to the new context estimate before the next reply', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-ctx-handoff-'));
    const note = '交接要点：迁移 packages/core，下一步跑验证。';
    const script = await writeScript(dataDir, [
      { text: 'EARLY_REPLY', usage: usage(70000) },
      { tool: 'handoff', args: { text: note }, usage: usage(71000) },
      { when: '交接要点', text: 'PLACEHOLDER' },
      { when: '交接要点', text: 'AFTER_HANDOFF', delayMs: 1500, usage: usage(3000) },
    ]);
    let opened = null;
    try {
      opened = await openKernel(dataDir, script);
      const { store, kernel } = opened;
      const conv = await makeConversation(store, kernel, dataDir);
      await say(kernel, store, conv, 'EARLY_A remember');
      const before = await contextOf(kernel, store, conv);
      assert.equal(before.used, 70000, JSON.stringify(before));

      const accepted = await kernel.handoff(conv.id, { requestId: 'ctx-handoff-1' });
      assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
      let view = null;
      for (let i = 0; i < 300; i += 1) {
        view = (await activeView(kernel, conv)).view;
        if ((view.entries || []).some((entry) => entry?.kind === 'pi.reset')) break;
        await sleep(30);
      }
      assert.equal((view.entries || []).some((entry) => entry?.kind === 'pi.reset'), true);
      const tokens = estimatedTokens(view);
      const after = await contextOf(kernel, store, conv);
      assert.equal(after.used, tokens, JSON.stringify(after));
      assert.ok(after.used > 0 && after.used < before.used, JSON.stringify({ before, after }));
      assert.ok(after.percent < before.percent, JSON.stringify({ before, after }));
    } finally {
      await closeOpened(opened);
    }
  });
});
