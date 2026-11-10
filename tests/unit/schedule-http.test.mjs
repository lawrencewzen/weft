import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseSSE } from '../../src/core/sse.mjs';
import { validateResponse } from '../../src/v2/validate.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import { attachSchedulesTopic, SCHEDULES_TOPIC } from '../../src/v2/stream/schedules-topic.ts';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const TOKEN = 'v2-schedules-token';

async function sendV2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const checked = validateResponse(apiPath.split('?')[0], method, res.status, parsed);
  assert.equal(checked.ok, true, `${method} ${apiPath} ${res.status}: ${JSON.stringify(checked.errors)}\n${text}`);
  return { status: res.status, body: parsed, text };
}

function openEvents({ port, token, topics }) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const events = [];
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: `/api/v2/events?topics=${topics}`,
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    }, (res) => {
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          if (!part.trim() || part.trim() === ':') continue;
          events.push(...parseSSE(`${part}\n\n`));
        }
      });
      resolve({ events, close: () => req.destroy() });
    });
    req.on('error', (err) => {
      if (err?.code === 'ECONNRESET') return;
      reject(err);
    });
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('timeout');
}

const frames = (session, entity) => session.events.filter((ev) => ev.data?.entity === entity);

test('schedules topic: snapshot, upsert on change, nothing when the value is the same, remove', async () => {
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  const base = {
    id: 's1',
    name: 'A',
    message: 'm',
    target: { kind: 'conversation', conversationId: 'c1', title: 'T' },
    rule: { kind: 'daily', time: '09:00' },
    enabled: true,
    createdBy: 'user',
    nextRunAt: 1000,
    lastRun: null,
  };
  let list = [structuredClone(base)];
  const topic = attachSchedulesTopic(hub, { load: async () => structuredClone(list), coalesceMs: 0, log() {} });
  const seen = [];
  const sub = hub.connect({ topics: [SCHEDULES_TOPIC], lang: 'zh', send: (frame) => seen.push(frame) });
  try {
    await sub.ready;
    assert.equal(topic.subscriberActive(), true);
    assert.equal(seen[0].event, 'snapshot');
    assert.deepEqual(seen[0].data.entities.map((e) => [e.entity, e.id]), [['schedule', 's1']]);
    const after = () => seen.slice(1).map((f) => `${f.event}:${f.data.id}`);

    topic.notify();
    await sleep(100);
    assert.deepEqual(after(), [], 'nothing changed, nothing pushed');

    list = [{ ...base, nextRunAt: 2000, lastRun: { id: 'r1', at: 1500, status: 'ok', conversationId: 'c1', error: null } }];
    topic.notify();
    await waitFor(() => after().length === 1);
    assert.deepEqual(after(), ['upsert:s1']);
    assert.equal(seen[1].data.value.lastRun.status, 'ok');

    topic.notify();
    await sleep(100);
    assert.equal(after().length, 1);

    list = [];
    topic.notify();
    await waitFor(() => after().length === 2);
    assert.deepEqual(after(), ['upsert:s1', 'remove:s1']);
  } finally {
    sub.close();
    topic.dispose();
    hub.dispose();
  }
});

test('HTTP: create, validate, idempotency, run, runs, edit, delete, and the schedules topic pushes', { timeout: 120_000 }, async () => {
  const dataDir = await makeTempDir('weft-v2-schedules-');
  const srv = await startServer({ token: TOKEN, dataDir, env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'sched-reply' } });
  let events = null;
  try {
    const { token } = await readDiscovery(dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'sched' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'Daily notes' }, TOKEN);
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    const api = (method, apiPath, body) => sendV2(srv.base, method, apiPath, token, body);

    events = await openEvents({ port: srv.port, token, topics: 'schedules' });
    await waitFor(() => events.events.some((ev) => ev.event === 'snapshot'));
    assert.deepEqual(events.events[0].data.entities, []);

    assert.deepEqual((await api('GET', '/api/v2/schedules')).body, { schedules: [] });

    const target = { kind: 'conversation', conversationId: conv.body.id, title: 'whatever' };
    const body = { name: 'Morning CI', message: 'check CI', target, rule: { kind: 'weekly', days: [5, 1, 3], time: '09:30' }, requestId: 'http-create-1' };
    const created = await api('POST', '/api/v2/schedules', body);
    assert.equal(created.status, 201, created.text);
    const id = created.body.id;
    assert.equal(created.body.name, 'Morning CI');
    assert.equal(created.body.createdBy, 'user');
    assert.equal(created.body.enabled, true);
    assert.deepEqual(created.body.rule, { kind: 'weekly', days: [1, 3, 5], time: '09:30' });
    assert.deepEqual(created.body.target, { kind: 'conversation', conversationId: conv.body.id, title: 'Daily notes' });
    assert.equal(typeof created.body.nextRunAt, 'number');
    assert.ok(created.body.nextRunAt > Date.now());
    assert.equal(new Date(created.body.nextRunAt).getHours(), 9);
    assert.equal(new Date(created.body.nextRunAt).getMinutes(), 30);
    assert.equal(created.body.lastRun, null);

    // requestId: the same answer, no second schedule.
    const again = await api('POST', '/api/v2/schedules', body);
    assert.equal(again.status, 201);
    assert.deepEqual(again.body, created.body);
    assert.equal((await api('GET', '/api/v2/schedules')).body.schedules.length, 1);

    // Pushed on the topic.
    await waitFor(() => frames(events, 'schedule').some((ev) => ev.event === 'upsert' && ev.data.id === id));

    // 400 with field names.
    const bad = await api('POST', '/api/v2/schedules', { name: '', message: 'm', target, rule: { kind: 'interval', everyMinutes: 1 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'E_INVALID_SCHEDULE');
    assert.deepEqual([...bad.body.fields].sort(), ['name', 'rule.everyMinutes']);
    const past = await api('POST', '/api/v2/schedules', { name: 'p', message: 'm', target, rule: { kind: 'once', at: Date.now() - 1000 } });
    assert.deepEqual(past.body.fields, ['rule.at']);
    const noDays = await api('PATCH', `/api/v2/schedules/${id}`, { rule: { kind: 'weekly', days: [], time: '09:00' } });
    assert.equal(noDays.status, 400);
    assert.deepEqual(noDays.body.fields, ['rule.days']);
    const en = await api('POST', '/api/v2/schedules?lang=en', { name: 'x', message: 'm', target, rule: { kind: 'interval', everyMinutes: 2 } });
    assert.match(en.body.error, /at least 5 minutes/);
    assert.equal((await api('POST', '/api/v2/schedules', { name: 'x', message: 'm', target: { kind: 'conversation', conversationId: 'nope' }, rule: { kind: 'daily', time: '09:00' } })).body.fields[0], 'target.conversationId');

    // Same value: no push. A different value: push.
    const upsertsBefore = frames(events, 'schedule').filter((ev) => ev.event === 'upsert').length;
    const same = await api('PATCH', `/api/v2/schedules/${id}`, { name: 'Morning CI' });
    assert.equal(same.status, 200);
    await sleep(400);
    assert.equal(frames(events, 'schedule').filter((ev) => ev.event === 'upsert').length, upsertsBefore);
    const renamed = await api('PATCH', `/api/v2/schedules/${id}`, { name: 'Morning CI 2', enabled: false });
    assert.equal(renamed.body.name, 'Morning CI 2');
    assert.equal(renamed.body.enabled, false);
    assert.equal(renamed.body.nextRunAt, null);
    await waitFor(() => frames(events, 'schedule').filter((ev) => ev.event === 'upsert').length > upsertsBefore);
    const resumed = await api('PATCH', `/api/v2/schedules/${id}`, { enabled: true });
    assert.equal(resumed.body.enabled, true);
    assert.equal(typeof resumed.body.nextRunAt, 'number');

    // Run now, with a requestId.
    assert.deepEqual((await api('GET', `/api/v2/schedules/${id}/runs`)).body, { runs: [] });
    const ran = await api('POST', `/api/v2/schedules/${id}/run`, { requestId: 'http-run-1' });
    assert.equal(ran.status, 200);
    assert.equal(ran.body.status, 'ok');
    assert.equal(ran.body.conversationId, conv.body.id);
    assert.equal(ran.body.error, null);
    assert.deepEqual((await api('POST', `/api/v2/schedules/${id}/run`, { requestId: 'http-run-1' })).body, ran.body);
    const runs = await api('GET', `/api/v2/schedules/${id}/runs`);
    assert.deepEqual(runs.body.runs, [ran.body]);
    const listed = (await api('GET', '/api/v2/schedules')).body.schedules[0];
    assert.deepEqual(listed.lastRun, ran.body);
    await waitFor(() => frames(events, 'schedule').some((ev) => ev.event === 'upsert' && ev.data.value?.lastRun?.id === ran.body.id));
    const noBody = await fetch(`${srv.base}/api/v2/schedules/${id}/run`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    assert.equal(noBody.status, 200, 'POST /run without a body is fine');

    // New-conversation target.
    const fresh = await api('POST', '/api/v2/schedules', {
      name: 'Fresh', message: 'hello fresh', target: { kind: 'new', workspaceId: ws.body.id, model: null }, rule: { kind: 'interval', everyMinutes: 60 },
    });
    assert.equal(fresh.status, 201, fresh.text);
    assert.equal(fresh.body.target.workspaceName, 'sched');
    assert.equal(fresh.body.target.model, null);
    const freshRun = await api('POST', `/api/v2/schedules/${fresh.body.id}/run`, {});
    assert.equal(freshRun.body.status, 'ok');
    assert.notEqual(freshRun.body.conversationId, conv.body.id);
    const snapshot = await api('GET', `/api/v2/conversations/${freshRun.body.conversationId}`);
    assert.equal(snapshot.body.conversation.title, 'Fresh');

    // 404s.
    assert.equal((await api('PATCH', '/api/v2/schedules/nope', { name: 'x' })).status, 404);
    assert.equal((await api('DELETE', '/api/v2/schedules/nope')).status, 404);
    assert.equal((await api('POST', '/api/v2/schedules/nope/run', {})).status, 404);
    assert.equal((await api('GET', '/api/v2/schedules/nope/runs')).status, 404);

    // Delete, with a requestId.
    const deleted = await api('DELETE', `/api/v2/schedules/${id}?requestId=http-del-1`);
    assert.deepEqual(deleted.body, { ok: true, id });
    assert.deepEqual((await api('DELETE', `/api/v2/schedules/${id}?requestId=http-del-1`)).body, { ok: true, id });
    await waitFor(() => frames(events, 'schedule').some((ev) => ev.event === 'remove' && ev.data.id === id));
    assert.equal((await api('GET', '/api/v2/schedules')).body.schedules.length, 1);
    assert.equal((await sendV2(srv.base, 'GET', '/api/v2/schedules', 'wrong-token')).status, 401);
  } finally {
    events?.close();
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});

test('HTTP: schedules and their tasks survive a server restart', { timeout: 120_000 }, async () => {
  const dataDir = await makeTempDir('weft-v2-schedules-restart-');
  let srv = await startServer({ token: TOKEN, dataDir, env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ok' } });
  try {
    let { token } = await readDiscovery(dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'sched' }, TOKEN);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'Keep' }, TOKEN);
    const made = await sendV2(srv.base, 'POST', '/api/v2/schedules', token, {
      name: 'Survivor', message: 'm', target: { kind: 'conversation', conversationId: conv.body.id }, rule: { kind: 'daily', time: '03:15' },
    });
    assert.equal(made.status, 201, made.text);
    await stopServer(srv);

    srv = await startServer({ token: TOKEN, dataDir, env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ok' } });
    ({ token } = await readDiscovery(dataDir));
    const list = await sendV2(srv.base, 'GET', '/api/v2/schedules', token);
    assert.equal(list.body.schedules.length, 1);
    assert.equal(list.body.schedules[0].id, made.body.id);
    assert.equal(list.body.schedules[0].nextRunAt, made.body.nextRunAt);
    // A sleeping schedule does not block a restart.
    const restart = await fetch(`${srv.base}/api/v2/service/restart`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(restart.status, 202);
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});
