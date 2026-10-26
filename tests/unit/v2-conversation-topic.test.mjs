import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseSSE } from '../../src/core/sse.mjs';
import { compileSchema, validateResponse } from '../../src/v2/validate.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import {
  attachConversationTopic,
  liveItemId,
} from '../../src/v2/stream/conversation-topic.ts';
import { toolGroupSummaryView } from '../../src/v2/views/tools.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const TOKEN = 'v2-conv-topic-token';
const BASIC = path.join(ROOT, 'tests/fixtures/basic.json');
const STREAM_TEXT = 'abcdefghijklmnopqrstuvwxyz0123456789';

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

function assertEntityValue(entity, value) {
  if (entity === 'conversation') assertSchema('ConversationView', value);
  else if (entity === 'item') assertSchema('ThreadItem', value);
  else if (entity === 'tool') assertSchema('ToolCall', value);
  else if (entity === 'subagent') assertSchema('Subagent', value);
  else if (entity === 'change') assertSchema('Change', value);
  else assert.fail(`unexpected entity ${entity}`);
}

function assertPushedEntities(events) {
  for (const ev of events) {
    if (ev.event === 'snapshot') {
      assertSchema('SnapshotEvent', ev.data);
      for (const item of ev.data.entities || []) {
        assertEntityValue(item.entity, item.value);
      }
    } else if (ev.event === 'upsert') {
      assertSchema('UpsertEvent', ev.data);
      assertEntityValue(ev.data.entity, ev.data.value);
    } else if (ev.event === 'remove') {
      assertSchema('RemoveEvent', ev.data);
    } else if (ev.event === 'text.delta') {
      assertSchema('TextDeltaEvent', ev.data);
    }
  }
}

function entityKey(entity, id) {
  return `${entity}\t${id}`;
}

function applyEvents(events, store = new Map()) {
  for (const ev of events) {
    if (ev.event === 'snapshot') {
      store.clear();
      for (const item of ev.data?.entities || []) {
        store.set(entityKey(item.entity, item.id), structuredClone(item.value));
      }
    } else if (ev.event === 'upsert') {
      store.set(entityKey(ev.data.entity, ev.data.id), structuredClone(ev.data.value));
    } else if (ev.event === 'remove') {
      store.delete(entityKey(ev.data.entity, ev.data.id));
    } else if (ev.event === 'text.delta') {
      const item = store.get(entityKey('item', ev.data.itemId));
      if (!item || typeof item.text !== 'string') continue;
      const offset = Number(ev.data.offset) || 0;
      item.text = `${item.text.slice(0, offset)}${ev.data.append || ''}`;
    }
  }
  return store;
}

function snapshotFromStore(store, cid) {
  const conversation = store.get(entityKey('conversation', cid));
  const items = (conversation?.itemIds || []).map((id) => store.get(entityKey('item', id))).filter(Boolean);
  const toolIds = [];
  for (const item of items) {
    if (item.kind === 'tool_group') toolIds.push(...(item.toolIds || []));
  }
  const tools = toolIds.map((id) => store.get(entityKey('tool', id))).filter(Boolean);
  return { conversation, items, tools };
}

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function getV2(base, apiPath, token) {
  const res = await fetch(base + apiPath, { headers: token ? v2Headers(token) : {} });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text, headers: res.headers };
}

async function postV2(base, apiPath, token, body = {}) {
  const res = await fetch(base + apiPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? v2Headers(token) : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

async function waitForFile(file, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await readFile(file, 'utf8');
      return;
    } catch {
      await sleep(30);
    }
  }
  throw new Error(`file not ready: ${file}`);
}

async function openConversation(base) {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'v2-topic' }, TOKEN);
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'topic' }, TOKEN);
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return { ws: ws.body, conv: conv.body };
}

async function waitFinished(base, id, timeoutMs = 25000) {
  const started = Date.now();
  let body;
  while (Date.now() - started < timeoutMs) {
    const got = await request(base, 'GET', `/api/conversations/${id}`, undefined, TOKEN);
    body = got.body;
    if (body?.status === 'done' || body?.status === 'failed') return body;
    await sleep(50);
  }
  throw new Error(`conversation ${id} did not finish: ${JSON.stringify(body)}`);
}

function parseCompleteSse(buf) {
  const parts = String(buf).split('\n\n');
  const rest = parts.pop() || '';
  const events = [];
  for (const part of parts) {
    if (!part.trim() || part.trim() === ':') continue;
    events.push(...parseSSE(`${part}\n\n`));
  }
  return { events, rest };
}

function openEvents({ port, token, topics, lang, lastEventId }) {
  const query = new URLSearchParams({ topics });
  if (lang) query.set('lang', lang);
  if (lastEventId != null && lastEventId !== '') query.set('lastEventId', String(lastEventId));
  return new Promise((resolve, reject) => {
    let buf = '';
    const events = [];
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: `/api/v2/events?${query.toString()}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
      },
    }, (res) => {
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const parsed = parseCompleteSse(buf);
        buf = parsed.rest;
        events.push(...parsed.events);
      });
      resolve({
        req,
        res,
        events,
        raw: () => buf,
        close() {
          req.destroy();
        },
      });
    });
    req.on('error', (err) => {
      const code = err && typeof err === 'object' ? err.code : '';
      if (code === 'ECONNRESET' || code === 'ABORT_ERR') return;
      reject(err);
    });
    req.end();
  });
}

async function waitEvents(session, ready, timeoutMs = 25000, quietMs = 0) {
  const started = Date.now();
  let quietSince = 0;
  let lastLen = 0;
  while (Date.now() - started < timeoutMs) {
    if (session.res.statusCode && session.res.statusCode !== 200) {
      throw new Error(`events status ${session.res.statusCode}`);
    }
    if (session.events.length !== lastLen) {
      lastLen = session.events.length;
      quietSince = 0;
    }
    if (ready(session.events)) {
      if (!quietMs) return session.events;
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) return session.events;
    } else {
      quietSince = 0;
    }
    await sleep(20);
  }
  throw new Error(`events did not match: ${JSON.stringify(session.events.map((ev) => ({ event: ev.event, id: ev.id, data: ev.data })))}`);
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

test('in-process: missing conversation snapshot, kernel sub/unsub, live item then formal replace', async () => {
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  const listeners = new Set();
  let unsubCount = 0;
  const data = {
    presented: presentedFixture(),
    subagents: [],
    modelTarget: null,
    window: 128000,
  };
  const topic = attachConversationTopic(hub, {
    loadConversation: async (id) => (id === 'c1' ? data : null),
    subscribe: (_cid, fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        unsubCount += 1;
      };
    },
    coalesceMs: 20,
    log() {},
  });
  try {
    const missingFrames = [];
    const missing = hub.connect({
      topics: ['conversation:nope'],
      send: (frame) => missingFrames.push(frame),
    });
    await missing.ready;
    missing.close();
    assert.equal(missingFrames[0].event, 'snapshot');
    assert.deepEqual(missingFrames[0].data.entities, []);
    assert.deepEqual(missingFrames[0].data.missing, ['conversation:nope']);
    assertSchema('SnapshotEvent', missingFrames[0].data);

    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    assert.equal(topic.kernelSubscriptionCount(), 1);
    assert.equal(frames[0].event, 'snapshot');
    assert.equal(frames[0].data.missing, undefined);
    const snapConv = frames[0].data.entities.find((item) => item.entity === 'conversation');
    assert.equal(snapConv.value.id, 'c1');
    assert.deepEqual(snapConv.value.itemIds, []);

    const emit = (ev) => {
      for (const fn of listeners) fn(ev);
    };
    data.presented = presentedFixture({
      status: 'running',
      messages: [{ id: 'u1', role: 'user', text: 'hi' }],
    });
    emit({ event: 'message.done', data: { messageId: 'u1', text: 'hi', role: 'user' } });
    emit({ event: 'status', data: { status: 'running' } });
    await sleep(60);
    emit({ event: 'message.delta', data: { messageId: 'live-1', text: 'ab' } });
    emit({ event: 'message.delta', data: { messageId: 'live-1', text: 'cd' } });
    await sleep(20);
    data.presented = presentedFixture({
      status: 'done',
      messages: [
        { id: 'u1', role: 'user', text: 'hi' },
        { id: 'a1', role: 'assistant', text: 'abcd' },
      ],
    });
    emit({ event: 'message.done', data: { messageId: 'a1', text: 'abcd', liveId: 'live-1' } });
    emit({ event: 'status', data: { status: 'done' } });
    await sleep(80);

    const liveId = liveItemId('live-1');
    const kinds = frames.map((frame) => {
      if (frame.event === 'upsert') return `upsert:${frame.data.entity}:${frame.data.id}:${frame.data.value?.kind || frame.data.value?.status || ''}`;
      if (frame.event === 'remove') return `remove:${frame.data.entity}:${frame.data.id}`;
      if (frame.event === 'text.delta') return `delta:${frame.data.itemId}:${frame.data.offset}:${frame.data.append}`;
      return frame.event;
    });
    const userAt = kinds.findIndex((row) => row.startsWith('upsert:item:u1:'));
    const runningAt = kinds.findIndex((row) => row.startsWith('upsert:conversation:c1:') && frames.find((frame, i) => i === kinds.indexOf(row)));
    const runningFrame = frames.find((frame) => (
      frame.event === 'upsert'
      && frame.data.entity === 'conversation'
      && frame.data.value?.status === 'running'
    ));
    const liveAt = kinds.findIndex((row) => row === `upsert:item:${liveId}:assistant`);
    const deltas = frames.filter((frame) => frame.event === 'text.delta' && frame.data.itemId === liveId);
    const removeAt = kinds.findIndex((row) => row === `remove:item:${liveId}`);
    const formalAt = kinds.findIndex((row) => row === 'upsert:item:a1:assistant');
    const idleFrame = [...frames].reverse().find((frame) => (
      frame.event === 'upsert'
      && frame.data.entity === 'conversation'
      && frame.data.value?.status === 'idle'
    ));
    assert.ok(userAt >= 0, JSON.stringify(kinds));
    assert.ok(runningFrame, JSON.stringify(kinds));
    assert.ok(liveAt >= 0, JSON.stringify(kinds));
    assert.equal(userAt < liveAt, true, JSON.stringify(kinds));
    assert.equal(deltas.length >= 2, true, JSON.stringify(deltas));
    let offset = 0;
    let text = '';
    for (const delta of deltas) {
      assert.equal(delta.data.offset, offset);
      text += delta.data.append;
      offset += delta.data.append.length;
    }
    assert.equal(text, 'abcd');
    assert.ok(removeAt > liveAt, JSON.stringify(kinds));
    assert.ok(formalAt > removeAt, JSON.stringify(kinds));
    assert.ok(idleFrame, JSON.stringify(kinds));
    assert.equal(idleFrame.data.value.itemIds.includes(liveId), false);
    assertPushedEntities(frames.filter((frame) => frame.event !== 'heartbeat'));

    const unsubBefore = unsubCount;
    session.close();
    assert.equal(topic.kernelSubscriptionCount(), 0);
    assert.equal(unsubCount, unsubBefore + 1);
  } finally {
    topic.dispose();
    hub.dispose();
  }
});

test('GET /api/v2/events conversation snapshot matches GET /api/v2/conversations/{id}', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: BASIC },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base);
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done));

    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'zh',
    });
    const events = await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    session.close();
    const snapshot = events.find((ev) => ev.event === 'snapshot');
    assert.ok(snapshot);
    assertSchema('SnapshotEvent', snapshot.data);
    assertPushedEntities(events);
    const got = await getV2(srv.base, `/api/v2/conversations/${conv.id}`, discovery.token);
    assert.equal(got.status, 200, got.text);
    const reconstructed = snapshotFromStore(applyEvents(events), conv.id);
    assert.deepEqual(reconstructed, got.body);
  } finally {
    await stopServer(srv);
  }
});

async function startScriptServer(turns, extraEnv = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-v2-topic-'));
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({ turns }));
  return startServer({
    dataDir,
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script, ...extraEnv },
  });
}

function liveIdFromEvents(events) {
  const upsert = events.find((ev) => (
    ev.event === 'upsert'
    && ev.data?.entity === 'item'
    && ev.data?.value?.kind === 'assistant'
    && ev.data?.value?.streaming === true
    && String(ev.data.id).startsWith('live:')
  ));
  return upsert?.data?.id || null;
}

function runSettled(events, cid, { tools = false } = {}) {
  const store = applyEvents(events);
  const conv = store.get(entityKey('conversation', cid));
  if (!conv || conv.status !== 'idle' || conv.run?.status !== 'idle') return false;
  const items = (conv.itemIds || []).map((id) => store.get(entityKey('item', id))).filter(Boolean);
  const hasUser = items.some((item) => item.kind === 'user');
  const hasAssistant = items.some((item) => item.kind === 'assistant' && item.streaming === false);
  const hasLive = items.some((item) => item.kind === 'assistant' && item.streaming === true);
  if (!hasUser || !hasAssistant || hasLive) return false;
  if (tools && !items.some((item) => item.kind === 'tool_group')) return false;
  return true;
}

test('POST message while subscribed streams live item, deltas, then replaces with formal assistant', { timeout: 45_000 }, async () => {
  const srv = await startScriptServer([{ text: STREAM_TEXT }], { WEFT_FAUX_TPS: '4' });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base);
    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'zh',
    });
    await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const events = await waitEvents(session, (list) => {
      const liveId = liveIdFromEvents(list);
      if (!liveId) return false;
      const removed = list.some((ev) => ev.event === 'remove' && ev.data.entity === 'item' && ev.data.id === liveId);
      const deltas = list.filter((ev) => ev.event === 'text.delta' && ev.data.itemId === liveId);
      return removed && deltas.length > 0 && runSettled(list, conv.id);
    }, 40000, 300);
    session.close();
    assertPushedEntities(events.filter((ev) => ev.event !== 'heartbeat'));

    const userAt = events.findIndex((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'item' && ev.data.value?.kind === 'user'
    ));
    const runningAt = events.findIndex((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'conversation' && ev.data.value?.status === 'running'
    ));
    const liveAt = events.findIndex((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'item'
      && ev.data.value?.kind === 'assistant'
      && ev.data.value?.streaming === true
    ));
    const liveId = liveIdFromEvents(events);
    assert.ok(liveId, JSON.stringify(events.map((ev) => ev.event)));
    const deltas = events.filter((ev) => ev.event === 'text.delta' && ev.data.itemId === liveId);
    const removeAt = events.findIndex((ev) => ev.event === 'remove' && ev.data.entity === 'item' && ev.data.id === liveId);
    const formalAt = events.findIndex((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'item'
      && ev.data.value?.kind === 'assistant'
      && ev.data.value?.streaming === false
      && !String(ev.data.id).startsWith('live:')
    ));
    const idleAt = events.findIndex((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'conversation' && ev.data.value?.status === 'idle'
    ));
    assert.ok(userAt >= 0, 'missing user upsert');
    assert.ok(runningAt >= 0, 'missing running conversation');
    assert.ok(liveAt >= 0, 'missing live item');
    assert.ok(userAt < runningAt, 'user should arrive before running conversation');
    assert.ok(userAt < liveAt, 'user should arrive before live item');
    assert.ok(runningAt < liveAt, 'running should arrive before live item');
    assert.equal(deltas.length >= 1, true, JSON.stringify(deltas));
    let offset = 0;
    let text = '';
    for (const delta of deltas) {
      assert.equal(delta.data.offset, offset, JSON.stringify(deltas));
      text += delta.data.append;
      offset += String(delta.data.append).length;
    }
    const formal = events[formalAt];
    assert.ok(formal, 'missing formal assistant');
    assert.equal(text, formal.data.value.text);
    assert.equal(formal.data.value.text, STREAM_TEXT);
    assert.ok(removeAt > liveAt, 'live item should be removed after streaming');
    assert.ok(formalAt > removeAt, 'formal assistant after live remove');
    assert.ok(idleAt > formalAt, 'conversation returns to idle');
    assert.equal(events[idleAt].data.value.itemIds.includes(liveId), false);
  } finally {
    await stopServer(srv);
  }
});

test('tool script pushes tool_group and tool entities in zh and en', { timeout: 45_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: BASIC },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base);
    const zh = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'zh',
    });
    const en = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'en',
    });
    await waitEvents(zh, (list) => list.some((ev) => ev.event === 'snapshot'));
    await waitEvents(en, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await waitEvents(zh, (list) => runSettled(list, conv.id, { tools: true }), 40000);
    await waitEvents(en, (list) => runSettled(list, conv.id, { tools: true }), 40000);
    zh.close();
    en.close();
    assertPushedEntities(zh.events.filter((ev) => ev.event !== 'heartbeat'));
    assertPushedEntities(en.events.filter((ev) => ev.event !== 'heartbeat'));

    const zhStore = applyEvents(zh.events);
    const enStore = applyEvents(en.events);
    const zhSnap = snapshotFromStore(zhStore, conv.id);
    const enSnap = snapshotFromStore(enStore, conv.id);
    const zhGroup = zhSnap.items.find((item) => item.kind === 'tool_group');
    const enGroup = enSnap.items.find((item) => item.kind === 'tool_group');
    assert.ok(zhGroup, JSON.stringify(zhSnap.items.map((item) => item.kind)));
    assert.ok(enGroup);
    assert.notEqual(zhGroup.summary.text, enGroup.summary.text);
    assert.equal(zhSnap.tools.length > 0, true);
    const done = await request(srv.base, 'GET', `/api/conversations/${conv.id}`, undefined, TOKEN);
    const rawTools = (done.body.messages || []).filter((m) => m.role === 'tool').map((m) => m.tool);
    assert.equal(zhGroup.summary.text, toolGroupSummaryView(rawTools, 'zh').text);
    assert.equal(enGroup.summary.text, toolGroupSummaryView(rawTools, 'en').text);

    const toolId = zhGroup.toolIds[0];
    const runningTool = zh.events.find((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'tool' && ev.data.id === toolId && ev.data.value?.status === 'running'
    ));
    const doneTool = [...zh.events].reverse().find((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'tool' && ev.data.id === toolId
    ));
    assert.ok(doneTool, 'missing tool entity');
    assert.equal(doneTool.data.value.status, 'done');
    if (runningTool) {
      assert.ok(
        zh.events.indexOf(runningTool) < zh.events.indexOf(doneTool),
        'tool entity should update after the tool ends',
      );
    }
  } finally {
    await stopServer(srv);
  }
});

test('Last-Event-ID resume reconstructs the same snapshot as GET', { timeout: 45_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: BASIC },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base);
    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
    });
    await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const first = await waitEvents(session, (list) => runSettled(list, conv.id, { tools: true }), 40000);
    const lastId = [...first].reverse().find((ev) => ev.id != null)?.id;
    assert.ok(lastId != null);
    session.close();

    const resume = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lastEventId: lastId,
    });
    await sleep(400);
    resume.close();
    assert.equal(resume.events.some((ev) => ev.event === 'snapshot'), false, JSON.stringify(resume.events));
    const store = applyEvents([...first, ...resume.events]);
    const reconstructed = snapshotFromStore(store, conv.id);
    const got = await getV2(srv.base, `/api/v2/conversations/${conv.id}`, discovery.token);
    assert.equal(got.status, 200, got.text);
    assert.deepEqual(reconstructed, got.body);
    assertPushedEntities(first.filter((ev) => ev.event !== 'heartbeat'));
  } finally {
    await stopServer(srv);
  }
});

test('last subscriber leaving unsubscribes the kernel', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base);
    const a = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
    });
    const b = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
    });
    await waitEvents(a, (list) => list.some((ev) => ev.event === 'snapshot'));
    await waitEvents(b, (list) => list.some((ev) => ev.event === 'snapshot'));
    assert.match(srv.logs(), new RegExp(`WEFT_V2_CONV_SUB ${conv.id}`));
    a.close();
    await sleep(150);
    assert.equal(/WEFT_V2_CONV_UNSUB/.test(srv.logs()), false, srv.logs());
    b.close();
    const started = Date.now();
    while (Date.now() - started < 3000) {
      if (srv.logs().includes(`WEFT_V2_CONV_UNSUB ${conv.id}`)) break;
      await sleep(50);
    }
    assert.match(srv.logs(), new RegExp(`WEFT_V2_CONV_UNSUB ${conv.id}`));
  } finally {
    await stopServer(srv);
  }
});

test('subscribing to a missing conversation yields an empty snapshot with missing', { timeout: 20_000 }, async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: 'conversation:does-not-exist',
    });
    const events = await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    await sleep(200);
    assert.equal(session.res.statusCode, 200);
    session.close();
    const snapshot = events.find((ev) => ev.event === 'snapshot');
    assert.ok(snapshot);
    assert.deepEqual(snapshot.data.entities, []);
    assert.deepEqual(snapshot.data.missing, ['conversation:does-not-exist']);
    assertSchema('SnapshotEvent', snapshot.data);
    assert.equal(events.some((ev) => ev.event === 'upsert' || ev.event === 'remove'), false);
  } finally {
    await stopServer(srv);
  }
});

function assertLivePushSequence(events, convId, expectedText) {
  assertPushedEntities(events.filter((ev) => ev.event !== 'heartbeat'));
  const userAt = events.findIndex((ev) => (
    ev.event === 'upsert' && ev.data.entity === 'item' && ev.data.value?.kind === 'user'
  ));
  const runningAt = events.findIndex((ev) => (
    ev.event === 'upsert' && ev.data.entity === 'conversation' && ev.data.value?.status === 'running'
  ));
  const liveAt = events.findIndex((ev) => (
    ev.event === 'upsert'
    && ev.data.entity === 'item'
    && ev.data.value?.kind === 'assistant'
    && ev.data.value?.streaming === true
  ));
  const liveId = liveIdFromEvents(events);
  assert.ok(liveId, JSON.stringify(events.map((ev) => ev.event)));
  const deltas = events.filter((ev) => ev.event === 'text.delta' && ev.data.itemId === liveId);
  const removeAt = events.findIndex((ev) => ev.event === 'remove' && ev.data.entity === 'item' && ev.data.id === liveId);
  const formalAt = events.findIndex((ev) => (
    ev.event === 'upsert'
    && ev.data.entity === 'item'
    && ev.data.value?.kind === 'assistant'
    && ev.data.value?.streaming === false
    && !String(ev.data.id).startsWith('live:')
  ));
  const idleAt = events.findIndex((ev) => (
    ev.event === 'upsert' && ev.data.entity === 'conversation' && ev.data.value?.status === 'idle'
  ));
  assert.ok(userAt >= 0, 'missing user upsert');
  assert.ok(runningAt >= 0, 'missing running conversation');
  assert.ok(liveAt >= 0, 'missing live item');
  assert.ok(userAt < runningAt, 'user should arrive before running conversation');
  assert.ok(userAt < liveAt, 'user should arrive before live item');
  assert.ok(runningAt < liveAt, 'running should arrive before live item');
  assert.equal(deltas.length >= 1, true, JSON.stringify(deltas));
  let offset = 0;
  let text = '';
  for (const delta of deltas) {
    assert.equal(delta.data.offset, offset, JSON.stringify(deltas));
    text += delta.data.append;
    offset += String(delta.data.append).length;
  }
  const formal = events[formalAt];
  assert.ok(formal, 'missing formal assistant');
  assert.equal(text, formal.data.value.text);
  assert.equal(formal.data.value.text, expectedText);
  assert.ok(removeAt > liveAt, 'live item should be removed after streaming');
  assert.ok(formalAt > removeAt, 'formal assistant after live remove');
  assert.ok(idleAt > formalAt, 'conversation returns to idle');
  assert.equal(events[idleAt].data.value.itemIds.includes(liveId), false);
  assert.equal(events[runningAt].data.id, convId);
}

test('v2 POST /messages while subscribed matches old-API push sequence; v2 POST /stop ends a held run', { timeout: 90_000 }, async () => {
  const streamSrv = await startScriptServer([{ text: STREAM_TEXT }], { WEFT_FAUX_TPS: '4' });
  try {
    const discovery = await readDiscovery(streamSrv.dataDir);
    const { conv } = await openConversation(streamSrv.base);
    const session = await openEvents({
      port: streamSrv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'zh',
    });
    await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await postV2(streamSrv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'go',
    });
    assert.equal(sent.status, 202, sent.text);
    assert.equal(typeof sent.body?.runId, 'string');
    assert.ok(sent.body.runId);
    const events = await waitEvents(session, (list) => {
      const liveId = liveIdFromEvents(list);
      if (!liveId) return false;
      const removed = list.some((ev) => ev.event === 'remove' && ev.data.entity === 'item' && ev.data.id === liveId);
      const deltas = list.filter((ev) => ev.event === 'text.delta' && ev.data.itemId === liveId);
      return removed && deltas.length > 0 && runSettled(list, conv.id);
    }, 40000, 300);
    session.close();
    assertLivePushSequence(events, conv.id, STREAM_TEXT);
  } finally {
    await stopServer(streamSrv);
  }

  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-v2-topic-stop-'));
  const ready = path.join(dataDir, 'hold-ready');
  const stopSrv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_HOLD: '1',
      WEFT_FAUX_HOLD_READY: ready,
    },
  });
  try {
    const discovery = await readDiscovery(stopSrv.dataDir);
    const { conv } = await openConversation(stopSrv.base);
    const session = await openEvents({
      port: stopSrv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'zh',
    });
    await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await postV2(stopSrv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'hold-stop',
    });
    assert.equal(sent.status, 202, sent.text);
    await waitForFile(ready);
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'conversation'
      && (ev.data.value?.run?.status === 'running' || ev.data.value?.status === 'running')
    )));
    const stopped = await postV2(stopSrv.base, `/api/v2/conversations/${conv.id}/stop`, discovery.token, {});
    assert.equal(stopped.status, 202, stopped.text);
    assert.equal(stopped.body?.stopping, true);
    const afterStop = await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'conversation'
      && ['stopped', 'idle'].includes(ev.data.value?.run?.status)
    )));
    session.close();
    assertPushedEntities(afterStop.filter((ev) => ev.event !== 'heartbeat'));
    const runStatus = [...afterStop].reverse().find((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'conversation'
      && ['stopped', 'idle'].includes(ev.data.value?.run?.status)
    ))?.data?.value?.run?.status;
    assert.ok(['stopped', 'idle'].includes(runStatus), JSON.stringify(runStatus));
  } finally {
    await stopServer(stopSrv);
  }
});

test('new subscriber while a conversation is streaming matches GET and does not drop items', { timeout: 45_000 }, async () => {
  const srv = await startScriptServer([{ text: STREAM_TEXT }], { WEFT_FAUX_TPS: '4' });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base);
    const first = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'zh',
    });
    await waitEvents(first, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await waitEvents(first, (list) => {
      const liveId = liveIdFromEvents(list);
      if (!liveId) return false;
      return list.some((ev) => ev.event === 'text.delta' && ev.data.itemId === liveId);
    }, 40000);

    const second = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'zh',
    });
    const events = await waitEvents(second, (list) => runSettled(list, conv.id), 40000, 300);
    second.close();
    first.close();

    const snapshot = events.find((ev) => ev.event === 'snapshot');
    assert.ok(snapshot);
    const reconstructed = snapshotFromStore(applyEvents(events), conv.id);
    const got = await getV2(srv.base, `/api/v2/conversations/${conv.id}`, discovery.token);
    assert.equal(got.status, 200, got.text);
    assert.deepEqual(reconstructed, got.body);
    assert.equal(reconstructed.items.some((item) => item.kind === 'user'), true);
    assert.equal(reconstructed.items.some((item) => item.kind === 'assistant' && item.streaming === false), true);
    assertPushedEntities(events.filter((ev) => ev.event !== 'heartbeat'));
  } finally {
    await stopServer(srv);
  }
});

test('new subscriber during a held run keeps GET items', { timeout: 45_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-v2-topic-midsub-'));
  const ready = path.join(dataDir, 'hold-ready');
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_HOLD: '1',
      WEFT_FAUX_HOLD_READY: ready,
    },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base);
    const first = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'zh',
    });
    await waitEvents(first, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'hold-mid' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await waitForFile(ready);
    await waitEvents(first, (list) => list.some((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'conversation'
      && (ev.data.value?.run?.status === 'running' || ev.data.value?.status === 'running')
    )));

    const second = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'zh',
    });
    await waitEvents(second, (list) => list.some((ev) => ev.event === 'snapshot'));
    const got = await getV2(srv.base, `/api/v2/conversations/${conv.id}`, discovery.token);
    assert.equal(got.status, 200, got.text);
    const snapshot = second.events.find((ev) => ev.event === 'snapshot');
    assert.ok(snapshot);
    for (const item of got.body.items || []) {
      const inSnap = (snapshot.data.entities || []).some((row) => row.entity === 'item' && row.id === item.id);
      const inUpsert = second.events.some((ev) => (
        ev.event === 'upsert' && ev.data.entity === 'item' && ev.data.id === item.id
      ));
      assert.equal(inSnap || inUpsert, true, `missing item ${item.id}`);
    }
    const convRef = (snapshot.data.entities || []).find((row) => row.entity === 'conversation' && row.id === conv.id)
      || second.events.find((ev) => ev.event === 'upsert' && ev.data.entity === 'conversation' && ev.data.id === conv.id)?.data;
    assert.ok(convRef, 'missing conversation entity');
    second.close();
    first.close();
  } finally {
    await stopServer(srv);
  }
});

