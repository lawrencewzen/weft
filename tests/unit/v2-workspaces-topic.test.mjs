import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseSSE } from '../../src/core/sse.mjs';
import { compileSchema } from '../../src/v2/validate.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import {
  attachWorkspacesTopic,
  WORKSPACES_TOPIC,
} from '../../src/v2/stream/workspaces-topic.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const TOKEN = 'v2-ws-topic-token';

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
  if (entity === 'workspace') assertSchema('Workspace', value);
  else if (entity === 'conversation_summary') assertSchema('ConversationSummary', value);
  else assert.fail(`unexpected entity ${entity}`);
}

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function getV2(base, apiPath, token) {
  const res = await fetch(base + apiPath, { headers: token ? v2Headers(token) : {} });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
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
  return { status: res.status, body: parsed, text };
}

async function delV2(base, apiPath, token) {
  const res = await fetch(base + apiPath, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      ...(token ? v2Headers(token) : {}),
    },
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
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

async function waitEvents(session, ready, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (session.res.statusCode && session.res.statusCode !== 200) {
      throw new Error(`events status ${session.res.statusCode}`);
    }
    if (ready(session.events)) return session.events;
    await sleep(20);
  }
  throw new Error(`events did not match: ${JSON.stringify(session.events.map((ev) => ({ event: ev.event, id: ev.id, data: ev.data })))}`);
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

test('in-process workspaces topic upserts on notify and status events, removes deleted', async () => {
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  const workspaces = [{ id: 'w1', name: 'n', path: '/p', source: 'local' }];
  const convs = [];
  const statusById = new Map();
  const listeners = new Set();
  const topic = attachWorkspacesTopic(hub, {
    loader: {
      listWorkspaces: async () => workspaces,
      listConversations: async () => convs,
      statusOf: async (conv) => statusById.get(conv.id) || 'idle',
      subagentDigests: async () => new Map(),
    },
    subscribeAll(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    coalesceMs: 20,
    sweepMs: 60_000,
    log() {},
  });
  try {
    const frames = [];
    const session = hub.connect({
      topics: [WORKSPACES_TOPIC],
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    assert.equal(topic.subscriberActive(), true);
    assert.equal(frames[0].event, 'snapshot');
    assertSchema('SnapshotEvent', frames[0].data);
    const snapWs = frames[0].data.entities.find((item) => item.entity === 'workspace');
    assert.equal(snapWs.id, 'w1');
    assertEntityValue('workspace', snapWs.value);

    convs.push({ id: 'c1', workspaceId: 'w1', title: 'new', updatedAt: 5 });
    statusById.set('c1', 'idle');
    topic.notify();
    const started = Date.now();
    while (Date.now() - started < 2000) {
      if (frames.some((frame) => (
        frame.event === 'upsert' && frame.data.entity === 'conversation_summary' && frame.data.id === 'c1'
      ))) break;
      await sleep(20);
    }
    const created = frames.find((frame) => (
      frame.event === 'upsert' && frame.data.entity === 'conversation_summary' && frame.data.id === 'c1'
    ));
    assert.ok(created, JSON.stringify(frames.map((frame) => frame.event)));
    assertEntityValue('conversation_summary', created.data.value);
    assert.equal(created.data.value.status, 'idle');

    statusById.set('c1', 'running');
    for (const fn of listeners) fn('c1', { event: 'status', data: { status: 'running' } });
    const runAt = Date.now();
    while (Date.now() - runAt < 2000) {
      if (frames.some((frame) => (
        frame.event === 'upsert'
        && frame.data.entity === 'conversation_summary'
        && frame.data.value?.status === 'running'
      ))) break;
      await sleep(20);
    }
    const running = frames.find((frame) => (
      frame.event === 'upsert'
      && frame.data.entity === 'conversation_summary'
      && frame.data.value?.status === 'running'
    ));
    assert.ok(running, JSON.stringify(frames.filter((frame) => frame.event === 'upsert').map((frame) => frame.data.value?.status)));
    assert.equal(running.data.value.runningAgents, 1);

    workspaces.length = 0;
    convs.length = 0;
    topic.notify();
    const rmAt = Date.now();
    while (Date.now() - rmAt < 2000) {
      const removedWs = frames.some((frame) => frame.event === 'remove' && frame.data.entity === 'workspace' && frame.data.id === 'w1');
      const removedConv = frames.some((frame) => frame.event === 'remove' && frame.data.entity === 'conversation_summary' && frame.data.id === 'c1');
      if (removedWs && removedConv) break;
      await sleep(20);
    }
    assert.equal(frames.some((frame) => frame.event === 'remove' && frame.data.entity === 'workspace' && frame.data.id === 'w1'), true);
    assert.equal(frames.some((frame) => frame.event === 'remove' && frame.data.entity === 'conversation_summary' && frame.data.id === 'c1'), true);

    session.close();
    assert.equal(topic.subscriberActive(), false);
  } finally {
    topic.dispose();
    hub.dispose();
  }
});

test('subscribe workspaces: v2 create, old create, running then idle, remove', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-v2-ws-topic-'));
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
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'topic' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));

    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: WORKSPACES_TOPIC,
      lang: 'zh',
    });
    await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    const snap = session.events.find((ev) => ev.event === 'snapshot');
    assertSchema('SnapshotEvent', snap.data);

    const created = await postV2(srv.base, `/api/v2/workspaces/${ws.body.id}/conversations`, discovery.token, {
      title: 'from-v2',
    });
    assert.equal(created.status, 201, created.text);
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'conversation_summary'
      && ev.data.id === created.body.id
    )));
    const v2Upsert = session.events.find((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'conversation_summary' && ev.data.id === created.body.id
    ));
    assertEntityValue('conversation_summary', v2Upsert.data.value);

    const old = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'from-old' }, TOKEN);
    assert.equal(old.status, 201, JSON.stringify(old.body));
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'conversation_summary'
      && ev.data.id === old.body.id
    )));

    const sent = await postV2(srv.base, `/api/v2/conversations/${created.body.id}/messages`, discovery.token, {
      text: 'hold',
    });
    assert.equal(sent.status, 202, sent.text);
    await waitForFile(ready);
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'conversation_summary'
      && ev.data.id === created.body.id
      && ev.data.value?.status === 'running'
    )));

    const stopped = await postV2(srv.base, `/api/v2/conversations/${created.body.id}/stop`, discovery.token, {});
    assert.equal(stopped.status, 202, stopped.text);
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'conversation_summary'
      && ev.data.id === created.body.id
      && ev.data.value?.status === 'idle'
    )));

    const removed = await delV2(srv.base, `/api/v2/workspaces/${ws.body.id}`, discovery.token);
    assert.equal(removed.status, 200, removed.text);
    await waitEvents(session, (list) => {
      const wsGone = list.some((ev) => ev.event === 'remove' && ev.data.entity === 'workspace' && ev.data.id === ws.body.id);
      const convGone = list.some((ev) => ev.event === 'remove' && ev.data.entity === 'conversation_summary' && ev.data.id === created.body.id);
      return wsGone && convGone;
    });
    session.close();

    const listed = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.workspaces.length, 0);
  } finally {
    await stopServer(srv);
  }
});
