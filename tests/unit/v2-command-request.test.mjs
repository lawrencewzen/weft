// T147-11: who started a handoff or compaction, and the focus text they gave.
// The thread note carries `request` so the client can draw a user bubble.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import { HANDOFF_REQUEST_KIND } from '../../src/kernel/handoff.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { conversationSnapshot } from '../../src/v2/views/conversation.ts';
import { compactionView } from '../../src/v2/views/compaction.ts';
import { runStateView } from '../../src/v2/views/run.ts';
import { buildThread } from '../../src/v2/views/thread.ts';
import { compileSchema } from '../../src/v2/validate.ts';
import { ROOT } from './_root.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validateItem = compileSchema(structuredClone(spec.components.schemas.ThreadItem));
const validateRun = compileSchema(structuredClone(spec.components.schemas.RunState));

const NOTE = '迁移进度。下一步跑验证。';

function userEntry(id, text) {
  return { id, kind: 'pi.user', model: [{ role: 'user', content: text }] };
}
function resetEntry(id) {
  return { id, kind: 'pi.reset', head: 'self', model: [{ role: 'user', content: NOTE }] };
}
function requestEntry(id, instructions) {
  return {
    id,
    kind: HANDOFF_REQUEST_KIND,
    model: [{ role: 'user', content: '请交接' }],
    ...(instructions ? { data: { instructions } } : {}),
  };
}
function compactionEntry(id, reason) {
  return {
    id,
    kind: 'pi.compaction',
    head: 1,
    model: [{ role: 'user', content: '<summary>摘要</summary>' }],
    data: { reason },
  };
}

async function noteOf(entries, noteKind) {
  const { messages } = messagesFromEntries(entries);
  const thread = await buildThread(messages, { lang: 'zh' });
  const note = thread.items.find((item) => item.kind === 'system_note' && item.noteKind === noteKind);
  assert.ok(note, JSON.stringify(thread.items));
  assert.equal(validateItem(note), true, JSON.stringify(validateItem.errors));
  return note;
}

test('user handoff carries request.by=user, with the focus only when given', async () => {
  const withFocus = await noteOf([userEntry(1, 'a'), requestEntry(2, '  配置文件 '), resetEntry(3)], 'handoff');
  assert.deepEqual(withFocus.request, { by: 'user', instructions: '配置文件' });
  const without = await noteOf([userEntry(1, 'a'), requestEntry(2), resetEntry(3)], 'handoff');
  assert.deepEqual(without.request, { by: 'user' });
});

test('model handoff has no request, and a stale request does not leak into it', async () => {
  const model = await noteOf([userEntry(1, 'a'), resetEntry(2)], 'handoff');
  assert.equal('request' in model, false);
  // The model never answered the request; a later user turn and a model-made reset
  // must not be credited to the user.
  const stale = await noteOf([userEntry(1, 'a'), requestEntry(2, '重点'), userEntry(3, 'b'), resetEntry(4)], 'handoff');
  assert.equal('request' in stale, false);
  // A request is used once.
  const twice = messagesFromEntries([requestEntry(2, '重点'), resetEntry(3), resetEntry(4)]).messages;
  assert.equal(twice[0].request.by, 'user');
  assert.equal('request' in twice[1], false);
});

test('manual compaction is by user; threshold and overflow are not', async () => {
  const manual = await noteOf([userEntry(1, 'a'), compactionEntry(2, 'manual')], 'compaction');
  assert.deepEqual(manual.request, { by: 'user' });
  for (const reason of ['threshold', 'overflow']) {
    const auto = await noteOf([userEntry(1, 'a'), compactionEntry(2, reason)], 'compaction');
    assert.equal('request' in auto, false, reason);
  }
});

test('running run state carries the focus for handoff and manual compaction', () => {
  const run = runStateView({
    status: 'running',
    lang: 'zh',
    hasWorkspace: true,
    handoffRunning: true,
    handoffInstructions: '配置文件',
    live: { compactions: [{ trigger: 'manual' }] },
    compactionInstructions: '保留人名',
  });
  assert.equal(validateRun(run), true, JSON.stringify(validateRun.errors));
  assert.deepEqual(run.handoff, { state: 'running', instructions: '配置文件' });
  assert.deepEqual(run.compaction, { state: 'running', trigger: 'manual', instructions: '保留人名' });
  const bare = runStateView({ status: 'running', lang: 'zh', hasWorkspace: true, handoffRunning: true });
  assert.deepEqual(bare.handoff, { state: 'running' });
  // An automatic compaction never shows a focus.
  assert.deepEqual(
    compactionView({ compactions: [{ trigger: 'threshold' }] }, 'zh', '不该出现'),
    { state: 'running', trigger: 'threshold' },
  );
});

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
    env: { WEFT_LLM: 'faux', WEFT_RETRY_MAX: '1', WEFT_RETRY_BASE_MS: '20', ...env },
  });
  return { store, kernel };
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

async function snapshot(kernel, store, id) {
  const presented = await kernel.present(await store.getConversation(id), { includeMessages: true });
  return conversationSnapshot({ presented, subagents: [], window: 128000 });
}

function notes(snap, noteKind) {
  return snap.items.filter((item) => item.kind === 'system_note' && item.noteKind === noteKind);
}

test('manual compaction request survives reopening the kernel', { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-cmd-request-'));
  const pad = `PAD\n${'p'.repeat(80_000)}`;
  let opened = null;
  try {
    opened = await openKernel(dataDir, { WEFT_FAUX_TEXT: 'ok' });
    let { store, kernel } = opened;
    const wsPath = path.join(dataDir, 'ws');
    await mkdir(wsPath, { recursive: true });
    await writeFile(path.join(wsPath, 'notes.txt'), 'notes\n');
    const ws = await store.createWorkspace({ name: 'cmd', path: wsPath });
    const conv = await kernel.createConversation({ workspaceId: ws.id, workspacePath: wsPath, title: 'cmd' });
    const compactions = async () => notes(await snapshot(kernel, store, conv.id), 'compaction').length;

    for (const text of ['first', pad, 'kept', pad, 'kept2']) await say(kernel, store, conv, text);
    const accepted = await kernel.compact(conv.id, '保留人名');
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    await waitFor(async () => (await compactions()) === 1, 'first compaction');
    for (const text of [pad, 'kept3', pad, 'kept4']) await say(kernel, store, conv, text);
    const plain = await kernel.compact(conv.id, undefined);
    assert.equal(plain.status, 202, JSON.stringify(plain.body));
    await waitFor(async () => (await compactions()) === 2, 'second compaction');

    const check = async () => {
      const snap = await snapshot(kernel, store, conv.id);
      const found = notes(snap, 'compaction');
      assert.deepEqual(found.map((item) => item.request), [
        { by: 'user', instructions: '保留人名' },
        { by: 'user' },
      ], JSON.stringify(found));
    };
    await check();

    await kernel.close();
    opened = await openKernel(dataDir, { WEFT_FAUX_TEXT: 'ok' });
    ({ store, kernel } = opened);
    await check();
  } finally {
    if (opened?.kernel) await opened.kernel.close();
    if (opened?.store) opened.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a handoff the model starts has no request in the snapshot', { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-cmd-model-handoff-'));
  const script = path.join(dataDir, 'turns.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { tool: 'handoff', args: { text: NOTE } },
      { when: '迁移进度', text: '继续' },
    ],
  }));
  let opened = null;
  try {
    opened = await openKernel(dataDir, { WEFT_FAUX_SCRIPT: script });
    const { store, kernel } = opened;
    const wsPath = path.join(dataDir, 'ws');
    await mkdir(wsPath, { recursive: true });
    const ws = await store.createWorkspace({ name: 'cmd', path: wsPath });
    const conv = await kernel.createConversation({ workspaceId: ws.id, workspacePath: wsPath, title: 'cmd' });
    await say(kernel, store, conv, '开始');
    const snap = await waitFor(async () => {
      const current = await snapshot(kernel, store, conv.id);
      return notes(current, 'handoff').length ? current : null;
    }, 'handoff note');
    assert.equal('request' in notes(snap, 'handoff')[0], false);
  } finally {
    if (opened?.kernel) await opened.kernel.close();
    if (opened?.store) opened.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
