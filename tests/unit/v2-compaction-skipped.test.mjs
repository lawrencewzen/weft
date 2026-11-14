// T147-12: a manual compaction that has nothing to compact still leaves a note.
// Pi completes such a task with an empty result and no summary entry; the kernel
// then writes a weft.compaction-skipped entry, and the thread shows a skipped note.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactionTask } from '@earendil-works/pi-durable';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import { COMPACTION_SKIPPED_KIND } from '../../src/kernel/compaction-settings.mjs';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { conversationSnapshot } from '../../src/v2/views/conversation.ts';
import { runStateView } from '../../src/v2/views/run.ts';
import { buildThread } from '../../src/v2/views/thread.ts';
import { compileSchema } from '../../src/v2/validate.ts';
import { ROOT } from './_root.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validateItem = compileSchema(structuredClone(spec.components.schemas.ThreadItem));

async function openKernel(dataDir, env) {
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
    env: { WEFT_LLM: 'faux', WEFT_RETRY_MAX: '1', WEFT_RETRY_BASE_MS: '20', WEFT_FAUX_TEXT: 'ok', ...env },
  });
  return { store, kernel };
}

// Close the kernel first, then the store; Windows cannot unlink weft.sqlite while
// a handle is open, so the directory removal also retries.
async function closeOpened(opened) {
  if (!opened) return;
  try { await opened.kernel.close(); } catch { /* already closed */ }
  try { opened.store.close(); } catch { /* already closed */ }
}

async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function waitFor(fn, what) {
  for (let i = 0; i < 200; i += 1) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout: ${what}`);
}

async function say(kernel, store, conv, text) {
  const posted = await kernel.postMessage(conv, text);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  await waitFor(async () => {
    const body = await kernel.present(await store.getConversation(conv.id));
    return body.status === 'done' || body.status === 'failed';
  }, `turn ${text}`);
}

async function presentedOf(kernel, store, id) {
  return kernel.present(await store.getConversation(id), { includeMessages: true });
}

async function snapshot(kernel, store, id) {
  return conversationSnapshot({ presented: await presentedOf(kernel, store, id), subagents: [], window: 128000 });
}

function notes(snap) {
  return snap.items.filter((item) => item.kind === 'system_note' && item.noteKind === 'compaction');
}

async function newConv(dataDir, store, kernel) {
  const wsPath = path.join(dataDir, 'ws');
  await mkdir(wsPath, { recursive: true });
  const ws = await store.createWorkspace({ name: 'skip', path: wsPath });
  return kernel.createConversation({ workspaceId: ws.id, workspacePath: wsPath, title: 'skip' });
}

test('messagesFromEntries turns the skipped entry into a skipped compaction note', async () => {
  const entries = [
    { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'a' }] },
    { id: 2, kind: COMPACTION_SKIPPED_KIND, data: { instructions: '  保留要点 ' } },
    { id: 3, kind: COMPACTION_SKIPPED_KIND },
    { id: 4, kind: 'pi.user', model: [{ role: 'user', content: 'b' }] },
  ];
  const { messages } = messagesFromEntries(entries);
  const thread = await buildThread(messages, { lang: 'zh' });
  const found = thread.items.filter((item) => item.kind === 'system_note');
  assert.deepEqual(thread.items.map((item) => item.kind), ['user', 'system_note', 'system_note', 'user']);
  for (const item of found) assert.equal(validateItem(item), true, JSON.stringify(validateItem.errors));
  assert.deepEqual(found[0], {
    kind: 'system_note',
    id: '2',
    noteKind: 'compaction',
    text: '上下文还很短，暂不需要压缩',
    skipped: true,
    request: { by: 'user', instructions: '保留要点' },
  });
  assert.deepEqual(found[1].request, { by: 'user' });
  const en = await buildThread(messages, { lang: 'en' });
  assert.equal(en.items[1].text, 'Context is still short; nothing to compact');
});

test('short conversation: manual compaction leaves a skipped note, survives reopening', { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-compact-skip-'));
  let opened = null;
  try {
    opened = await openKernel(dataDir);
    let { store, kernel } = opened;
    const conv = await newConv(dataDir, store, kernel);
    await say(kernel, store, conv, 'first');
    await say(kernel, store, conv, 'second');

    const withFocus = await kernel.compact(conv.id, '保留要点');
    assert.equal(withFocus.status, 202, JSON.stringify(withFocus.body));
    await waitFor(async () => notes(await snapshot(kernel, store, conv.id)).length === 1, 'first skipped note');
    await say(kernel, store, conv, 'third');
    const plain = await kernel.compact(conv.id, undefined);
    assert.equal(plain.status, 202, JSON.stringify(plain.body));
    await waitFor(async () => notes(await snapshot(kernel, store, conv.id)).length === 2, 'second skipped note');
    await say(kernel, store, conv, 'fourth');

    const check = async () => {
      const snap = await snapshot(kernel, store, conv.id);
      const found = notes(snap);
      assert.equal(found.length, 2, JSON.stringify(found));
      for (const item of found) assert.equal(validateItem(item), true, JSON.stringify(validateItem.errors));
      assert.deepEqual(found.map((item) => item.skipped), [true, true]);
      assert.deepEqual(found.map((item) => item.request), [
        { by: 'user', instructions: '保留要点' },
        { by: 'user' },
      ]);
      assert.equal(found[0].text, '上下文还很短，暂不需要压缩');
      assert.equal('detail' in found[0], false);
      // Position: at the request time, later messages come after it.
      const kinds = snap.items.map((item) => (item.kind === 'system_note' ? 'note' : item.kind));
      assert.deepEqual(kinds, [
        'user', 'assistant', 'user', 'assistant', 'note', 'user', 'assistant', 'note', 'user', 'assistant',
      ]);
      assert.equal(snap.conversation.run.compaction.state, 'idle', JSON.stringify(snap.conversation.run));
    };
    await check();

    await closeOpened(opened);
    opened = null;
    opened = await openKernel(dataDir);
    ({ store, kernel } = opened);
    await check();
  } finally {
    await closeOpened(opened);
    await removeDir(dataDir);
  }
});

test('conversation that needs compacting gets a normal note, not a skipped one', { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-compact-real-'));
  const pad = `PAD\n${'p'.repeat(80_000)}`;
  let opened = null;
  try {
    opened = await openKernel(dataDir);
    const { store, kernel } = opened;
    const conv = await newConv(dataDir, store, kernel);
    for (const text of ['first', pad, 'kept', pad, 'kept2']) await say(kernel, store, conv, text);
    const accepted = await kernel.compact(conv.id, '保留人名');
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    const snap = await waitFor(async () => {
      const current = await snapshot(kernel, store, conv.id);
      return notes(current).length ? current : null;
    }, 'compaction note');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const found = notes(await snapshot(kernel, store, conv.id));
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].text, '已压缩较早的上下文');
    assert.equal(found[0].skipped === true, false);
    assert.deepEqual(found[0].request, { by: 'user', instructions: '保留人名' });
    assert.equal(snap.conversation.run.compaction.state, 'idle');
  } finally {
    await closeOpened(opened);
    await removeDir(dataDir);
  }
});

test('an automatic compaction that finds nothing to compact leaves no record', { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-compact-auto-'));
  let opened = null;
  try {
    opened = await openKernel(dataDir);
    const { store, kernel } = opened;
    const conv = await newConv(dataDir, store, kernel);
    await say(kernel, store, conv, 'first');
    const { harnessId } = await store.getConversation(conv.id);
    // The faux model reports no usage, so the threshold never fires by itself.
    // Admit the same task Pi's generation admits for a threshold compaction.
    const taskId = await kernel.harness.commit((tx) => tx.createTask(
      CompactionTask,
      { reason: 'threshold' },
      { ownership: { kind: 'conversation' }, conversationId: harnessId, background: true },
    ), kernel.context);
    const settled = await waitFor(async () => {
      const task = await kernel.harness.commit((tx) => tx.task(taskId), kernel.context);
      return task?.state?.outcome ? task : null;
    }, 'automatic compaction task settled');
    assert.deepEqual(settled.state.outcome.result, {}, JSON.stringify(settled.state.outcome));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const entries = await kernel.harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: harnessId }, 100)).items,
      kernel.context,
    );
    assert.equal(entries.some((entry) => entry.kind === COMPACTION_SKIPPED_KIND), false);
    assert.equal(notes(await snapshot(kernel, store, conv.id)).length, 0);
  } finally {
    await closeOpened(opened);
    await removeDir(dataDir);
  }
});

test('runStateView stays idle with no compaction rows', () => {
  assert.deepEqual(runStateView({ status: 'done', lang: 'zh', hasWorkspace: true }).compaction, { state: 'idle' });
});
