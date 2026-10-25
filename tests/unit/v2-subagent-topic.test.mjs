import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseSSE } from '../../src/core/sse.mjs';
import { matchContractPath, compileSchema, validateResponse } from '../../src/v2/validate.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import { attachConversationTopic } from '../../src/v2/stream/conversation-topic.ts';
import { attachSubagentTopic } from '../../src/v2/stream/subagent-topic.ts';
import { createStuckWatch } from '../../src/v2/stream/stuck-watch.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const TOKEN = 'v2-subagent-topic-token';
const SUBAGENT_REPORT = path.join(ROOT, 'tests/fixtures/v2-subagent-report.json');

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
  else assert.fail(`unexpected entity ${entity}`);
}

function assertPushedEntities(events) {
  for (const ev of events) {
    if (ev.event === 'snapshot') {
      assertSchema('SnapshotEvent', ev.data);
      for (const item of ev.data.entities || []) assertEntityValue(item.entity, item.value);
    } else if (ev.event === 'upsert') {
      assertSchema('UpsertEvent', ev.data);
      assertEntityValue(ev.data.entity, ev.data.value);
    } else if (ev.event === 'remove') {
      assertSchema('RemoveEvent', ev.data);
    }
  }
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

function assertChecked(requestPath, method, status, body) {
  const checked = validateResponse(requestPath, method, status, body);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
}

function subPath(cid, aid, suffix = '') {
  return `/api/v2/conversations/${encodeURIComponent(cid)}/subagents/${encodeURIComponent(aid)}${suffix}`;
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
    pending() {
      return timers.filter((item) => !item.cancelled);
    },
  };
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

function openEvents({ port, token, topics, lang }) {
  const query = new URLSearchParams({ topics });
  if (lang) query.set('lang', lang);
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
        close() { req.destroy(); },
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
  throw new Error(`events did not match: ${JSON.stringify(session.events.map((ev) => ({ event: ev.event, data: ev.data })))}`);
}

async function openConversation(base, title = 'sub') {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'v2-sub' }, TOKEN);
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title }, TOKEN);
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return { ws: ws.body, conv: conv.body };
}

function subagentsOf(body) {
  return (body?.agents || []).filter((agent) => String(agent.id || '').includes(':sub:'));
}

async function waitConv(base, cid, ready, attempts = 120) {
  let body = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`, undefined, TOKEN);
    body = got.body;
    if (ready(body)) return body;
    await sleep(100);
  }
  return body;
}

test('contract path templates cover subagent routes', () => {
  assert.equal(
    matchContractPath('/api/v2/conversations/abc-123/subagents/abc-123:sub:4'),
    '/api/v2/conversations/{id}/subagents/{agentId}',
  );
  assert.equal(
    matchContractPath('/api/v2/conversations/abc-123/subagents/abc-123:sub:4/messages'),
    '/api/v2/conversations/{id}/subagents/{agentId}/messages',
  );
  assert.equal(
    matchContractPath('/api/v2/conversations/abc-123/subagents/abc-123:sub:4/stop'),
    '/api/v2/conversations/{id}/subagents/{agentId}/stop',
  );
});

test('stuck watch does not schedule without subscribers; schedules and clears with retain/release', () => {
  const clock = createFakeClock();
  const fired = [];
  const watch = createStuckWatch({
    stuckAfterMs: 500,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  watch.listen((cid) => fired.push(cid));
  const agent = { id: 'c1:sub:1', status: 'running', lastActivityAt: clock.now() };
  watch.sync('c1', [agent]);
  assert.equal(watch.timerCount(), 0);

  watch.retain('c1');
  watch.sync('c1', [agent]);
  assert.equal(watch.timerCount('c1'), 1);
  assert.equal(watch.timerCount(), 1);

  watch.release('c1');
  assert.equal(watch.timerCount(), 0);
  assert.deepEqual(fired, []);
  watch.dispose();
});

test('in-process: conversation topic upserts stuck after the threshold; no timer without subscribers', async () => {
  const clock = createFakeClock();
  const stuck = createStuckWatch({
    stuckAfterMs: 500,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  const agent = {
    id: 'c1:sub:1',
    name: '巡查',
    status: 'running',
    step: 1,
    totalSteps: 2,
    lastActivityAt: clock.now(),
    lastText: 'working',
  };
  const data = {
    presented: presentedFixture(),
    subagents: [agent],
    modelTarget: null,
    window: 128000,
  };
  const topic = attachConversationTopic(hub, {
    loadConversation: async (id) => (id === 'c1' ? data : null),
    subscribe: () => () => {},
    coalesceMs: 5,
    now: clock.now,
    stuckAfterMs: 500,
    stuck,
    log() {},
  });
  try {
    assert.equal(stuck.timerCount(), 0);
    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    const snap = frames.find((frame) => frame.event === 'snapshot');
    assert.ok(snap);
    const sub = snap.data.entities.find((item) => item.entity === 'subagent' && item.id === agent.id);
    assert.ok(sub, JSON.stringify(snap.data.entities));
    assert.equal(sub.value.status, 'running');
    assertSchema('Subagent', sub.value);
    assert.equal(stuck.timerCount('c1'), 1);

    clock.advance(501);
    clock.fireDue();
    await sleep(30);
    const stuckUpsert = frames.find((frame) => (
      frame.event === 'upsert'
      && frame.data.entity === 'subagent'
      && frame.data.id === agent.id
      && frame.data.value?.status === 'stuck'
    ));
    assert.ok(stuckUpsert, JSON.stringify(frames.filter((frame) => frame.event === 'upsert').map((frame) => frame.data)));
    assertSchema('Subagent', stuckUpsert.data.value);
    assert.equal(stuck.timerCount('c1'), 0);

    session.close();
    assert.equal(stuck.timerCount(), 0);
  } finally {
    topic.dispose();
    stuck.dispose();
    hub.dispose();
  }
});

test('in-process: subagent topic upserts an item when the child gets a new message', async () => {
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  const listeners = new Set();
  const agent = {
    id: 'c1:sub:1',
    name: '巡查',
    status: 'running',
    step: 1,
    totalSteps: 1,
    lastActivityAt: Date.now(),
  };
  const loaded = {
    presented: presentedFixture(),
    agent,
    messages: [{ id: 'u1', role: 'user', text: '请查看' }],
  };
  const topic = attachSubagentTopic(hub, {
    loadSubagent: async (cid, agentId) => (
      cid === 'c1' && agentId === agent.id ? loaded : null
    ),
    subscribe: (_cid, fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    coalesceMs: 15,
    log() {},
  });
  try {
    const frames = [];
    const session = hub.connect({
      topics: [`subagent:c1:${agent.id}`],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    const snap = frames.find((frame) => frame.event === 'snapshot');
    assert.ok(snap);
    assertSchema('SnapshotEvent', snap.data);
    const sub = snap.data.entities.find((item) => item.entity === 'subagent');
    assert.ok(sub);
    assertSchema('Subagent', sub.value);
    assert.equal(snap.data.entities.some((item) => item.entity === 'item' && item.id === 'u1'), true);

    loaded.messages = [
      { id: 'u1', role: 'user', text: '请查看' },
      { id: 'a1', role: 'assistant', text: '仓库干净' },
    ];
    for (const fn of listeners) fn({ event: 'agent', data: { ...agent, lastText: '仓库干净' } });
    const started = Date.now();
    let upsert = null;
    while (Date.now() - started < 2000) {
      upsert = frames.find((frame) => (
        frame.event === 'upsert'
        && frame.data.entity === 'item'
        && frame.data.id === 'a1'
      ));
      if (upsert) break;
      await sleep(15);
    }
    assert.ok(upsert, JSON.stringify(frames.map((frame) => ({ event: frame.event, data: frame.data }))));
    assert.equal(upsert.data.value.kind, 'assistant');
    assert.equal(upsert.data.value.text, '仓库干净');
    assertPushedEntities(frames.filter((frame) => frame.event !== 'heartbeat'));
    session.close();
  } finally {
    topic.dispose();
    hub.dispose();
  }
});

test('GET /api/v2/conversations/{id}/subagents/{agentId} snapshot matches contract; missing 404; no creds 401', { timeout: 60_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: SUBAGENT_REPORT },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const missingConv = await getV2(srv.base, subPath('nope', 'nope:sub:1'), discovery.token);
    assert.equal(missingConv.status, 404);
    assertChecked(subPath('nope', 'nope:sub:1'), 'GET', 404, missingConv.body);

    const unauth = await getV2(srv.base, subPath('c1', 'c1:sub:1'));
    assert.equal(unauth.status, 401);
    assertChecked(subPath('c1', 'c1:sub:1'), 'GET', 401, unauth.body);

    const { conv } = await openConversation(srv.base, 'report');
    const missingAgent = await getV2(srv.base, subPath(conv.id, `${conv.id}:sub:missing`), discovery.token);
    assert.equal(missingAgent.status, 404);
    assertChecked(subPath(conv.id, `${conv.id}:sub:missing`), 'GET', 404, missingAgent.body);

    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitConv(srv.base, conv.id, (body) => (
      body?.status === 'done' && subagentsOf(body).length > 0
    ));
    const child = subagentsOf(done).find((agent) => agent.name === '巡查') || subagentsOf(done)[0];
    assert.ok(child, JSON.stringify(done?.agents));

    const snap = await getV2(srv.base, `${subPath(conv.id, child.id)}?lang=zh`, discovery.token);
    assert.equal(snap.status, 200, snap.text);
    assertChecked(subPath(conv.id, child.id), 'GET', 200, snap.body);
    assert.equal(snap.headers.get('weft-protocol'), PROTOCOL_VERSION);
    assert.equal(snap.body.subagent.id, child.id);
    assert.equal(snap.body.subagent.parentConversationId, conv.id);
    assert.equal(typeof snap.body.subagent.title, 'string');
    assert.ok(Array.isArray(snap.body.items));
    assert.ok(Array.isArray(snap.body.tools));
    assert.equal(snap.body.items.some((item) => item.kind === 'user' || item.kind === 'assistant'), true);
  } finally {
    await stopServer(srv);
  }
});

test('POST subagent messages 202; stop 202 then stopped; missing 404; no creds 401', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-v2-subcmd-'));
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: 'hold-task' } },
      { text: 'parent-idle' },
      { when: 'hold-task', delayMs: 20000, text: 'SHOULD_NOT' },
    ],
  }));
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script, WEFT_RETRY_MAX: '2' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const unauthMsg = await postV2(srv.base, subPath('c1', 'c1:sub:1', '/messages'), undefined, { text: 'hi' });
    assert.equal(unauthMsg.status, 401);
    assertChecked(subPath('c1', 'c1:sub:1', '/messages'), 'POST', 401, unauthMsg.body);
    const unauthStop = await postV2(srv.base, subPath('c1', 'c1:sub:1', '/stop'));
    assert.equal(unauthStop.status, 401);
    assertChecked(subPath('c1', 'c1:sub:1', '/stop'), 'POST', 401, unauthStop.body);

    const missingMsg = await postV2(srv.base, subPath('nope', 'nope:sub:1', '/messages'), discovery.token, { text: 'hi' });
    assert.equal(missingMsg.status, 404);
    assertChecked(subPath('nope', 'nope:sub:1', '/messages'), 'POST', 404, missingMsg.body);
    const missingStop = await postV2(srv.base, subPath('nope', 'nope:sub:1', '/stop'), discovery.token, {});
    assert.equal(missingStop.status, 404);
    assertChecked(subPath('nope', 'nope:sub:1', '/stop'), 'POST', 404, missingStop.body);

    const { conv } = await openConversation(srv.base, 'cmd');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'spawn' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const idle = await waitConv(srv.base, conv.id, (body) => (
      body?.status === 'done'
      && subagentsOf(body).some((agent) => agent.name === 'worker' && agent.status === 'running')
    ));
    const worker = subagentsOf(idle).find((agent) => agent.name === 'worker');
    assert.ok(worker, JSON.stringify(idle?.agents));

    const unknownAgent = await postV2(srv.base, subPath(conv.id, `${conv.id}:sub:missing`, '/messages'), discovery.token, { text: 'hi' });
    assert.equal(unknownAgent.status, 404);
    assertChecked(subPath(conv.id, `${conv.id}:sub:missing`, '/messages'), 'POST', 404, unknownAgent.body);

    const steered = await postV2(srv.base, subPath(conv.id, worker.id, '/messages'), discovery.token, { text: '  please-steer  ' });
    assert.equal(steered.status, 202, steered.text);
    assertChecked(subPath(conv.id, worker.id, '/messages'), 'POST', 202, steered.body);
    assert.deepEqual(steered.body, { ok: true });
    assert.equal(steered.headers.get('weft-protocol'), PROTOCOL_VERSION);

    const stopped = await postV2(srv.base, subPath(conv.id, worker.id, '/stop'), discovery.token, {});
    assert.equal(stopped.status, 202, stopped.text);
    assertChecked(subPath(conv.id, worker.id, '/stop'), 'POST', 202, stopped.body);
    assert.deepEqual(stopped.body, { stopping: true });

    const after = await waitConv(srv.base, conv.id, (body) => (
      subagentsOf(body).find((agent) => agent.id === worker.id)?.status === 'stopped'
    ), 80);
    assert.equal(subagentsOf(after).find((agent) => agent.id === worker.id)?.status, 'stopped');
  } finally {
    await stopServer(srv);
  }
});

test('HTTP conversation topic snapshot includes subagent; child item arrives on subagent topic', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-v2-subpush-'));
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { tool: 'subagent', args: { action: 'spawn', name: '巡查', message: 'please-look' } },
      { text: '已派出巡查。' },
      { when: 'please-look', delayMs: 600, text: '仓库干净，没有未提交改动。' },
    ],
  }));
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script, WEFT_RETRY_MAX: '2' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base, 'push');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const live = await waitConv(srv.base, conv.id, (body) => (
      subagentsOf(body).some((agent) => agent.name === '巡查')
    ));
    const child = subagentsOf(live).find((agent) => agent.name === '巡查');
    assert.ok(child, JSON.stringify(live?.agents));

    const convEvents = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
      lang: 'zh',
    });
    await waitEvents(convEvents, (list) => list.some((ev) => (
      ev.event === 'snapshot' && (ev.data.entities || []).some((item) => item.entity === 'subagent')
    )));
    convEvents.close();
    const convSnap = convEvents.events.find((ev) => ev.event === 'snapshot');
    const subEntity = convSnap.data.entities.find((item) => item.entity === 'subagent');
    assert.ok(subEntity);
    assertSchema('Subagent', subEntity.value);

    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `subagent:${conv.id}:${child.id}`,
      lang: 'zh',
    });
    await waitEvents(session, (list) => {
      const store = new Map();
      for (const ev of list) {
        if (ev.event === 'snapshot') {
          for (const item of ev.data?.entities || []) store.set(`${item.entity}\t${item.id}`, item.value);
        } else if (ev.event === 'upsert') {
          store.set(`${ev.data.entity}\t${ev.data.id}`, ev.data.value);
        }
      }
      return [...store.values()].some((value) => (
        value?.kind === 'assistant' && String(value.text || '').includes('仓库干净')
      ));
    }, 40000);
    session.close();
    assertPushedEntities(session.events.filter((ev) => ev.event !== 'heartbeat'));
  } finally {
    await stopServer(srv);
  }
});
