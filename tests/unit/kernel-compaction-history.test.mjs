// Compaction must not drop the thread the user sees. The model still receives
// only the summary and the entries the summary keeps. Written against the
// unfixed reader first: present() / the v2 thread snapshot follow
// conversation.context(), whose entries are the active transcript.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import {
  createMapContext,
  createViewProjector,
  messagesFromEntries,
  projectViewUpdate,
} from '../../src/kernel/events.mjs';
import { FAUX_MODEL } from '../../src/kernel/index.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { formatPasteBlock } from '../../src/core/user-message-parts.mjs';
import { nameFromTask } from '../../src/kernel/subagents.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { conversationSnapshot } from '../../src/v2/views/conversation.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'compaction-history-token';
const EARLY_A = 'EARLY_A_MARKER';
const EARLY_B = 'EARLY_B_MARKER';
const PAD_MARK = 'PAD_UNIQUE';
const KEPT = 'KEPT_UNIQUE';
const AFTER = 'AFTER_UNIQUE';
const SUMMARY_TEXT = 'SUMMARY_OR_FIRST';
const TOOL_REPLY = 'REPLY_TOOL';
const AFTER_TOOL = 'REPLY_AFTER_TOOL';
const PAD_REPLY = 'REPLY_PAD';
const KEPT_REPLY = 'REPLY_KEPT';
const AFTER_REPLY = 'REPLY_AFTER_COMPACT';
const SUMMARY_MARK = 'compacted into the following summary';
const DROPPED_USAGE = 20000;
// Default keepRecentTokens is 20000 and estimates are about 3.5 chars/token.
const PAD = `${PAD_MARK}\n${'p'.repeat(80_000)}`;

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
}

function modelLines(messages) {
  return (messages || []).map((message) => ({
    role: message?.role || '',
    text: blockText(message?.content),
  }));
}

function clip(text) {
  const raw = String(text ?? '');
  if (raw.length <= 80) return raw;
  return `${raw.slice(0, 24)}…(${raw.length})`;
}

function threadRows(snapshot) {
  return (snapshot?.items || []).map((item) => ({
    kind: item.kind,
    text: item.text || item.body || '',
    toolIds: item.toolIds || [],
  }));
}

async function writeScript(dir, name, turns) {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

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
    env: {
      WEFT_LLM: 'faux',
      WEFT_RETRY_MAX: '2',
      WEFT_RETRY_BASE_MS: '20',
      ...env,
    },
  });
  return { store, kernel };
}

async function makeConversation(store, kernel, dataDir) {
  const wsPath = path.join(dataDir, 'ws');
  await mkdir(wsPath, { recursive: true });
  await writeFile(path.join(wsPath, 'notes.txt'), 'notes\n');
  const ws = await store.createWorkspace({ name: 'compact', path: wsPath });
  const conv = await kernel.createConversation({
    workspaceId: ws.id,
    workspacePath: wsPath,
    title: 'compact',
  });
  return { ws, wsPath, conv };
}

async function waitDone(kernel, store, id) {
  let body = null;
  for (let i = 0; i < 200; i += 1) {
    const live = await store.getConversation(id);
    body = await kernel.present(live, { includeMessages: true });
    if (body.status === 'done' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return body;
}

async function say(kernel, store, conv, text) {
  const posted = await kernel.postMessage(conv, text);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const done = await waitDone(kernel, store, conv.id);
  assert.equal(done.status, 'done', JSON.stringify(done.llmError || done.status));
  return done;
}

async function snapshotOf(kernel, store, conv) {
  const live = await store.getConversation(conv.id);
  const presented = await kernel.present(live, { includeMessages: true });
  const subagents = await kernel.listSubagents(live);
  return conversationSnapshot({ presented, subagents, window: 128000 });
}

async function compact(kernel, harnessId) {
  const handle = await kernel.harness.conversation(harnessId, kernel.context);
  assert.ok(handle);
  const taskId = await handle.compact(undefined, kernel.context);
  const task = await kernel.harness.waitForTask(taskId, kernel.context);
  const outcome = task?.state?.outcome;
  assert.equal(outcome?.status, 'completed', JSON.stringify(outcome || task));
  const submissionId = outcome.result?.submissionId;
  const entryId = outcome.result?.entryId;
  assert.ok(
    submissionId != null || entryId != null,
    `compaction did not cut: ${JSON.stringify(outcome?.result)}`,
  );
  if (submissionId != null) {
    const submission = await kernel.harness.submission(submissionId, kernel.context);
    assert.ok(submission);
    const placed = await submission.wait(kernel.context);
    assert.equal(placed.status, 'done', JSON.stringify(placed));
  }
  const active = await handle.context(kernel.context);
  const activeText = modelLines(active.messages).map((row) => row.text).join('\n');
  assert.equal(activeText.includes(SUMMARY_MARK), true, 'model context has no compaction summary');
  assert.equal(activeText.includes(EARLY_A), false, 'model context still has the dropped user text');
  assert.equal(
    (active.entries || []).some((entry) => entry?.kind === 'pi.compaction'),
    true,
    `active entries: ${(active.entries || []).map((entry) => entry?.kind).join(',')}`,
  );
  return { handle, active };
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function userEntry(text, extra = []) {
  const content = extra.length
    ? [{ type: 'text', text }, ...extra]
    : text;
  return {
    kind: 'pi.user',
    model: [{ role: 'user', content, timestamp: Date.now() }],
  };
}

function traceEntries(handle) {
  const proto = Object.getPrototypeOf(handle);
  if (proto.entries?.weftTrace) return proto.entries.weftTrace;
  const original = proto.entries;
  const calls = [];
  const traced = async function entries(query, limit, cursor, ctx) {
    calls.push({
      conversationId: Number(this.id),
      order: query?.order || '',
      minEntryId: query?.minEntryId ?? null,
      maxEntryId: query?.maxEntryId ?? null,
      limit,
      cursor: cursor ?? null,
    });
    return original.call(this, query, limit, cursor, ctx);
  };
  traced.weftTrace = { calls, restore() { proto.entries = original; } };
  proto.entries = traced;
  return traced.weftTrace;
}

function callsSince(calls, from, harnessId) {
  return calls.slice(from).filter((call) => call.conversationId === Number(harnessId));
}

test('a multi-page history is read in official ranges and is not scanned again', { timeout: 120000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-compact-pages-'));
  let opened = null;
  let restore = null;
  try {
    opened = await openKernel(dataDir, { WEFT_FAUX_TEXT: 'ok' });
    const { store, kernel } = opened;
    const { conv } = await makeConversation(store, kernel, dataDir);
    const conversation = await kernel.harness.conversation(conv.harnessId, kernel.context);
    const traced = traceEntries(conversation);
    restore = traced.restore;
    const drafts = [];
    for (let i = 0; i < 80; i += 1) drafts.push(userEntry(`MARK_${i}`));
    drafts.push(userEntry('EARLY_MEDIA', [
      { type: 'text', text: formatPasteBlock('PASTE_BODY_EARLY') },
      { type: 'image', data: PNG, mimeType: 'image/png', name: 'early.png' },
    ]));
    for (let i = 81; i < 161; i += 1) drafts.push(userEntry(`MARK_${i}`));
    drafts.push(userEntry('LATE_MEDIA', [
      { type: 'image', data: PNG, mimeType: 'image/png', name: 'late.png' },
    ]));
    const ids = [];
    await conversation.commit(async (tx) => {
      for (const draft of drafts) {
        ids.push((await tx.appendEntry(conv.harnessId, draft)).id);
      }
    }, kernel.context);
    const earlyId = ids[80];
    const lateId = ids[ids.length - 1];
    const firstId = ids[0];
    const mark = traced.calls.length;
    const lateImage = await kernel.getMessageImage(conv.id, lateId, 0);
    const lateCalls = callsSince(traced.calls, mark, conv.harnessId);
    assert.equal(lateImage?.name, 'late.png', JSON.stringify(lateImage));
    assert.deepEqual(lateCalls, [], `recent image scanned storage: ${JSON.stringify(lateCalls)}`);

    const earlyMark = traced.calls.length;
    const earlyImage = await kernel.getMessageImage(conv.id, earlyId, 0);
    const earlyCalls = callsSince(traced.calls, earlyMark, conv.harnessId);
    assert.equal(earlyImage?.name, 'early.png', JSON.stringify(earlyCalls));
    assert.equal(earlyCalls.length >= 1, true, JSON.stringify(earlyCalls));
    assert.equal(earlyCalls.every((call) => (
      call.limit === 50 && call.cursor == null && (call.maxEntryId != null || call.minEntryId != null)
    )), true, JSON.stringify(earlyCalls));

    const threadMark = traced.calls.length;
    const snap = await snapshotOf(kernel, store, conv);
    const threadCalls = callsSince(traced.calls, threadMark, conv.harnessId);
    const texts = threadRows(snap).map((row) => row.text);
    assert.equal(texts.some((text) => text.startsWith('MARK_0')), true, texts.slice(0, 3).map(clip).join(' | '));
    assert.equal(texts.some((text) => text.includes('EARLY_MEDIA')), true);
    assert.equal(texts.some((text) => text.includes('LATE_MEDIA')), true);
    assert.equal(snap.items.some((item) => String(item.id) === String(firstId)), true);
    assert.equal(threadCalls.length >= 1, true, `image read already scanned every page: ${JSON.stringify(earlyCalls)}`);
    assert.equal(threadCalls.every((call) => (
      call.limit === 50 && call.cursor == null && (call.maxEntryId != null || call.minEntryId != null)
    )), true, JSON.stringify(threadCalls));
    const ranges = [...earlyCalls, ...threadCalls].map((call) => (
      `${call.order}:${call.minEntryId}:${call.maxEntryId}`
    ));
    assert.equal(new Set(ranges).size, ranges.length, `repeated range: ${JSON.stringify(ranges)}`);

    const againMark = traced.calls.length;
    const again = await snapshotOf(kernel, store, conv);
    assert.deepEqual(threadRows(again).map((row) => row.text), texts);
    const imageAgain = await kernel.getMessageImage(conv.id, earlyId, 0);
    const paste = await kernel.getMessagePaste(conv.id, earlyId, 0);
    assert.equal(imageAgain?.name, 'early.png');
    assert.equal(paste, 'PASTE_BODY_EARLY');
    assert.deepEqual(callsSince(traced.calls, againMark, conv.harnessId), []);

    await kernel.close();
    store.close();
    opened = null;
    const restartMark = traced.calls.length;
    opened = await openKernel(dataDir, { WEFT_FAUX_TEXT: 'ok' });
    const restartCalls = callsSince(traced.calls, restartMark, conv.harnessId);
    assert.equal(restartCalls.length >= 2, true, JSON.stringify(restartCalls));
    assert.equal(restartCalls.every((call) => call.limit === 50 && call.cursor == null), true, JSON.stringify(restartCalls));
    const quiet = traced.calls.length;
    const reopened = await snapshotOf(opened.kernel, opened.store, conv);
    assert.equal(threadRows(reopened).some((row) => row.text.startsWith('MARK_0')), true);
    assert.deepEqual(callsSince(traced.calls, quiet, conv.harnessId), []);
  } finally {
    if (restore) restore();
    if (opened?.kernel) await opened.kernel.close();
    if (opened?.store) opened.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('pi.compaction is not a user or assistant bubble', () => {
  const summary = `The conversation history before this point was ${SUMMARY_MARK}:\n\n<summary>\n${SUMMARY_TEXT}\n</summary>`;
  const entries = [
    {
      id: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: EARLY_A }] }],
    },
    {
      id: 2,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: SUMMARY_TEXT }], stopReason: 'stop' }],
    },
    {
      id: 3,
      kind: 'pi.compaction',
      head: 4,
      model: [{ role: 'user', content: [{ type: 'text', text: summary }] }],
      data: { reason: 'manual' },
    },
    {
      id: 4,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: KEPT }] }],
    },
  ];
  const { messages } = messagesFromEntries(entries);
  assert.deepEqual(messages.map((message) => ({
    role: message.role,
    kind: message.kind,
    text: message.text,
  })), [
    { role: 'user', kind: undefined, text: EARLY_A },
    { role: 'assistant', kind: undefined, text: SUMMARY_TEXT },
    { role: 'note', kind: 'compaction', text: undefined },
    { role: 'user', kind: undefined, text: KEPT },
  ]);
  assert.equal(messages.some((message) => (
    (message.role === 'user' || message.role === 'assistant')
    && String(message.text || '').includes(SUMMARY_MARK)
  )), false);
  assert.equal(JSON.stringify(messages).includes(SUMMARY_MARK), false);

  const ctx = createMapContext();
  const projector = createViewProjector();
  const opened = projectViewUpdate(projector, { entries: entries.slice(0, 2), docs: {} }, ctx);
  assert.equal(opened.refresh, true);
  assert.deepEqual(opened.events, []);
  const next = projectViewUpdate(projector, { entries, docs: {} }, ctx);
  const dones = next.events.filter((event) => event.event === 'message.done');
  assert.deepEqual(dones.map((event) => event.data), [
    { messageId: '4', text: KEPT, role: 'user' },
  ]);
  assert.equal(JSON.stringify(next.events).includes(SUMMARY_MARK), false);
  assert.equal(next.events.some((event) => event.data?.role === 'assistant' && String(event.data?.text || '').includes(summary)), false);
});

test('compacted thread keeps every user, assistant, and tool message', { timeout: 180000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-compact-hist-'));
  const record = path.join(dataDir, 'requests.jsonl');
  const script = await writeScript(dataDir, 'turns.json', [
    {
      text: SUMMARY_TEXT,
      usage: { total_tokens: DROPPED_USAGE, prompt_tokens: 88000, completion_tokens: 2000 },
    },
    { text: TOOL_REPLY, tool: 'read', args: { path: 'notes.txt' } },
    { text: AFTER_TOOL },
    { text: PAD_REPLY },
    { text: KEPT_REPLY },
    { text: AFTER_REPLY },
  ]);
  let opened = null;
  try {
    opened = await openKernel(dataDir, { WEFT_FAUX_SCRIPT: script, WEFT_FAUX_RECORD: record });
    const { store, kernel } = opened;
    const { conv } = await makeConversation(store, kernel, dataDir);
    const sse = [];
    const unsub = kernel.subscribe(conv.id, (event) => sse.push(event));
    try {
      await say(kernel, store, conv, EARLY_A);
      await say(kernel, store, conv, EARLY_B);
      await say(kernel, store, conv, PAD);
      await say(kernel, store, conv, KEPT);

      const handle = await kernel.harness.conversation(conv.harnessId, kernel.context);
      const before = await handle.context(kernel.context);
      const beforeText = modelLines(before.messages).map((row) => row.text).join('\n');
      assert.equal(beforeText.includes(EARLY_A), true, 'auto compaction already dropped the early turn');
      assert.equal((before.entries || []).some((entry) => entry?.kind === 'pi.compaction'), false);
      const early = (before.entries || []).find((entry) => (
        entry?.kind === 'pi.user' && blockText(entry.model?.[0]?.content).includes(EARLY_A)
      ));
      assert.ok(early, 'missing early entry to fork');
      const forked = await handle.fork(early.id, {
        ownership: { kind: 'ownerless' },
        agent: { model: FAUX_MODEL },
      }, kernel.context);
      const forkRow = await store.updateConversation(
        (await store.createConversation({
          workspaceId: conv.workspaceId,
          workspacePath: conv.workspacePath,
          title: 'fork',
        })).id,
        { harnessId: forked.id },
      );

      const sseAtCompact = sse.length;
      await compact(kernel, conv.harnessId);
      const during = sse.slice(sseAtCompact);
      const duringDones = during.filter((event) => event.event === 'message.done' || event.event === 'message.delta');
      assert.deepEqual(duringDones, [], `compaction SSE replayed messages: ${JSON.stringify(duringDones)}`);

      const snap = await snapshotOf(kernel, store, conv);
      const rows = threadRows(snap);
      const texts = rows.map((row) => `${row.kind}:${clip(row.text)}`);
      const fail = `thread after compact: ${JSON.stringify(texts)}`;
      assert.equal(texts.some((row) => row.startsWith('user:') && row.includes(EARLY_A)), true, fail);
      assert.equal(texts.some((row) => row.startsWith('user:') && row.includes(EARLY_B)), true, fail);
      assert.equal(texts.some((row) => row.startsWith('assistant:') && row.includes(SUMMARY_TEXT)), true, fail);
      assert.equal(texts.some((row) => row.startsWith('assistant:') && row.includes(TOOL_REPLY)), true, fail);
      assert.equal(texts.some((row) => row.startsWith('assistant:') && row.includes(AFTER_TOOL)), true, fail);
      assert.equal(texts.some((row) => row.startsWith('user:') && row.includes(PAD_MARK)), true, fail);
      assert.equal(texts.some((row) => row.startsWith('assistant:') && row.includes(PAD_REPLY)), true, fail);
      assert.equal(texts.some((row) => row.startsWith('user:') && row.includes(KEPT)), true, fail);
      assert.equal(texts.some((row) => row.startsWith('assistant:') && row.includes(KEPT_REPLY)), true, fail);
      assert.equal(texts.some((row) => row.includes(SUMMARY_MARK)), false, fail);
      const order = texts.filter((row) => row.startsWith('user:') || row.startsWith('assistant:') || row.startsWith('tool_group:'));
      const at = (needle) => order.findIndex((row) => row.includes(needle));
      assert.ok(at(EARLY_A) < at(EARLY_B), fail);
      assert.ok(at(EARLY_B) < at(TOOL_REPLY), fail);
      assert.ok(at(TOOL_REPLY) < at(AFTER_TOOL), fail);
      assert.ok(at(AFTER_TOOL) < at(PAD_MARK), fail);
      assert.ok(at(PAD_MARK) < at(KEPT), fail);
      const readTool = (snap.tools || []).find((tool) => tool.kind === 'read' || tool.path === 'notes.txt');
      assert.ok(readTool, `tools: ${JSON.stringify(snap.tools)}`);
      const group = rows.find((row) => row.kind === 'tool_group' && row.toolIds.includes(readTool.id));
      assert.ok(group, fail);
      assert.equal(snap.conversation.context.used, 0, JSON.stringify(snap.conversation.context));
      assert.equal(snap.conversation.context.percent, 0, JSON.stringify(snap.conversation.context));

      const forkSnap = await snapshotOf(kernel, store, forkRow);
      const forkTexts = threadRows(forkSnap).map((row) => `${row.kind}:${row.text}`);
      assert.equal(forkTexts.some((row) => row.includes(EARLY_A)), true, JSON.stringify(forkTexts));
      assert.equal(forkTexts.some((row) => row.includes(KEPT)), false, JSON.stringify(forkTexts));
      assert.equal(forkTexts.some((row) => row.includes(PAD_MARK)), false, JSON.stringify(forkTexts));

      const again = await snapshotOf(kernel, store, conv);
      assert.deepEqual(threadRows(again), rows);

      await say(kernel, store, conv, AFTER);
      const follow = await kernel.harness.conversation(conv.harnessId, kernel.context);
      const sent = modelLines((await follow.context(kernel.context)).messages);
      const sentText = sent.map((row) => row.text).join('\n');
      assert.equal(sentText.includes(SUMMARY_MARK), true, JSON.stringify(sent));
      assert.equal(sentText.includes(PAD_MARK), true, 'kept pad missing from the model request');
      assert.equal(sentText.includes(KEPT), true, 'kept turn missing from the model request');
      assert.equal(sentText.includes(AFTER), true, 'new turn missing from the model request');
      assert.equal(sentText.includes(EARLY_A), false, JSON.stringify(sent.map((row) => row.role)));
      assert.equal(sentText.includes(EARLY_B), false);
      assert.equal(sentText.includes(AFTER_TOOL), false);
      const lines = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const last = lines[lines.length - 1];
      assert.equal((last?.users || []).some((text) => String(text).includes(EARLY_A)), false, JSON.stringify(last?.users));
      assert.equal((last?.users || []).some((text) => String(text).includes(AFTER)), true, JSON.stringify(last?.users));
      assert.ok(Array.isArray(last?.messages), 'recorded model request has no messages');
      const recorded = last.messages.map((row) => `${row.role}:${row.text || ''}`).join('\n');
      const recordedView = last.messages.map((row) => `${row.role}:${clip(row.text)}`).join('\n');
      assert.equal(recorded.includes(EARLY_A), false, recordedView);
      assert.equal(recorded.includes(EARLY_B), false, recordedView);
      assert.equal(recorded.includes(SUMMARY_MARK), true, recordedView);
      assert.equal(recorded.includes(PAD_MARK), true, recordedView);
      assert.equal(recorded.includes(KEPT), true, recordedView);
      assert.equal(recorded.includes(AFTER), true, recordedView);

      const doneIds = sse.filter((event) => event.event === 'message.done').map((event) => Number(event.data?.messageId));
      assert.equal(new Set(doneIds).size, doneIds.length, JSON.stringify(doneIds));
      for (let i = 1; i < doneIds.length; i += 1) {
        assert.ok(doneIds[i] > doneIds[i - 1], JSON.stringify(doneIds));
      }
      assert.equal(sse.some((event) => JSON.stringify(event.data || {}).includes(SUMMARY_MARK)), false);
    } finally {
      unsub();
    }

    const keptSnap = await snapshotOf(kernel, store, conv);
    await kernel.close();
    opened.kernel = null;
    store.close();
    opened.store = null;
    opened = null;

    const reopened = await openKernel(dataDir, { WEFT_FAUX_SCRIPT: script });
    opened = reopened;
    const reread = await snapshotOf(reopened.kernel, reopened.store, conv);
    assert.deepEqual(
      threadRows(reread).map((row) => row.text),
      threadRows(keptSnap).map((row) => row.text),
    );
    assert.equal(reread.conversation.context.used, 0, JSON.stringify(reread.conversation.context));
    await reopened.kernel.close();
    reopened.store.close();
    opened = null;

    const srv = await startServer({
      token: TOKEN,
      dataDir,
      env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script, WEFT_RETRY_MAX: '2', WEFT_RETRY_BASE_MS: '20' },
    });
    try {
      const discovery = await readDiscovery(dataDir);
      const http = await request(srv.base, 'GET', `/api/v2/conversations/${conv.id}`, undefined, discovery.token);
      assert.equal(http.status, 200, JSON.stringify(http.body));
      const checked = validateResponse(`/api/v2/conversations/${conv.id}`, 'GET', 200, http.body);
      assert.equal(checked.ok, true, JSON.stringify(checked.errors));
      const httpTexts = threadRows(http.body).map((row) => row.text);
      assert.deepEqual(httpTexts, threadRows(keptSnap).map((row) => row.text));
      assert.equal(http.body.conversation.context.used, 0, JSON.stringify(http.body.conversation.context));
    } finally {
      await stopServer(srv);
    }
  } finally {
    if (opened?.kernel) await opened.kernel.close();
    if (opened?.store) opened.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a fork-unrelated child still lists after the parent is compacted', { timeout: 180000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-compact-child-'));
  const taskText = 'Say CHILD_STILL_HERE';
  const script = await writeScript(dataDir, 'child.json', [
    {
      text: SUMMARY_TEXT,
      usage: { total_tokens: DROPPED_USAGE, prompt_tokens: 88000, completion_tokens: 2000 },
    },
    { tool: 'delegate', args: { task: taskText } },
    { text: 'PARENT_AFTER_CHILD' },
    { when: taskText, text: 'CHILD_STILL_HERE' },
    { text: PAD_REPLY },
    { text: KEPT_REPLY },
  ]);
  let opened = null;
  try {
    opened = await openKernel(dataDir, { WEFT_FAUX_SCRIPT: script });
    const { store, kernel } = opened;
    const { conv } = await makeConversation(store, kernel, dataDir);
    await say(kernel, store, conv, EARLY_A);
    await say(kernel, store, conv, 'dispatch child');
    await say(kernel, store, conv, PAD);
    await say(kernel, store, conv, KEPT);
    const before = await kernel.listSubagents(await store.getConversation(conv.id));
    const child = before.find((agent) => agent.name === nameFromTask(taskText));
    assert.ok(child, JSON.stringify(before));
    const beforeMessages = await kernel.childMessages(conv.id, child.id);
    assert.equal(beforeMessages.status, 200);
    assert.match(JSON.stringify(beforeMessages.body.messages), /CHILD_STILL_HERE/);

    await compact(kernel, conv.harnessId);
    const after = await kernel.listSubagents(await store.getConversation(conv.id));
    const still = after.find((agent) => agent.id === child.id);
    assert.ok(still, `child missing after compact: ${JSON.stringify(after)}`);
    assert.equal(still.name, child.name);
    assert.equal(still.mode, 'foreground');
    const messages = await kernel.childMessages(conv.id, child.id);
    assert.equal(messages.status, 200, JSON.stringify(messages.body));
    assert.match(JSON.stringify(messages.body.messages), /CHILD_STILL_HERE/);
    const parent = await snapshotOf(kernel, store, conv);
    const parentText = threadRows(parent).map((row) => row.text).join('\n');
    assert.equal(parentText.includes(EARLY_A), true, parentText.slice(0, 500));
    assert.equal(parent.conversation.context.used, 0, JSON.stringify(parent.conversation.context));
  } finally {
    if (opened?.kernel) await opened.kernel.close();
    if (opened?.store) opened.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
