import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseSSE } from '../../src/core/sse.mjs';
import { compileSchema, validateResponse } from '../../src/v2/validate.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, startServer, stopServer } from './_server.mjs';

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

function collectUntil(hubOpts, run) {
  const frames = [];
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION, ...hubOpts });
  try {
    run(hub, frames);
  } finally {
    hub.dispose();
  }
  return frames;
}

test('publish assigns a global increasing sequence', () => {
  const hub = createEventHub({ heartbeatMs: 60_000 });
  try {
    hub.register('a', { snapshot: () => [] });
    hub.register('b', { snapshot: () => [] });
    assert.equal(hub.currentSeq(), 0);
    assert.equal(hub.publish('a', { event: 'upsert', entity: 'a', id: '1', value: { n: 1 } }), 1);
    assert.equal(hub.publish('b', { event: 'remove', entity: 'b', id: '1' }), 2);
    assert.equal(hub.publish('a', { event: 'text.delta', itemId: 'i', offset: 0, append: 'x' }), 3);
    assert.equal(hub.currentSeq(), 3);
  } finally {
    hub.dispose();
  }
});

test('resume replays only subscribed topics after Last-Event-ID', () => {
  const hub = createEventHub({ heartbeatMs: 60_000 });
  try {
    hub.register('a', { snapshot: () => [{ entity: 'a', id: '1', value: { n: 0 } }] });
    hub.register('b', { snapshot: () => [{ entity: 'b', id: '1', value: { n: 0 } }] });
    hub.publish('a', { event: 'upsert', entity: 'a', id: '1', value: { n: 1 } });
    const seqB = hub.publish('b', { event: 'upsert', entity: 'b', id: '1', value: { n: 2 } });
    hub.publish('a', { event: 'remove', entity: 'a', id: '1' });
    const frames = [];
    const session = hub.connect({
      topics: ['b'],
      lastEventId: '0',
      send: (frame) => frames.push(frame),
    });
    assert.equal(hub.connectionCount(), 1);
    session.close();
    assert.equal(hub.connectionCount(), 0);
    assert.deepEqual(frames.map((frame) => ({ id: frame.id, event: frame.event, topic: frame.data.topic })), [
      { id: seqB, event: 'upsert', topic: 'b' },
    ]);
    assert.equal(frames[0].data.value.n, 2);
  } finally {
    hub.dispose();
  }
});

test('buffer overflow with a stale Last-Event-ID sends a snapshot', () => {
  const hub = createEventHub({ bufferSize: 2, heartbeatMs: 60_000 });
  try {
    hub.register('a', { snapshot: () => [{ entity: 'a', id: '1', value: { n: 0 } }] });
    hub.publish('a', { event: 'upsert', entity: 'a', id: '1', value: { n: 1 } });
    hub.publish('a', { event: 'upsert', entity: 'a', id: '1', value: { n: 2 } });
    hub.publish('a', { event: 'upsert', entity: 'a', id: '1', value: { n: 3 } });
    assert.equal(hub.currentSeq(), 3);
    const frames = [];
    hub.connect({
      topics: ['a'],
      lastEventId: '0',
      send: (frame) => frames.push(frame),
    }).close();
    assert.equal(frames.length, 1);
    assert.equal(frames[0].event, 'snapshot');
    assert.equal(frames[0].id, 3);
    assert.equal(frames[0].data.entities[0].value.n, 0);
  } finally {
    hub.dispose();
  }
});

test('upsert value functions evaluate per connection language and cache per lang', () => {
  const hub = createEventHub({ heartbeatMs: 60_000 });
  try {
    hub.register('greet', { snapshot: () => [] });
    let calls = 0;
    const zhLive = [];
    const zhLive2 = [];
    const enLive = [];
    hub.connect({ topics: ['greet'], lang: 'zh', send: (frame) => zhLive.push(frame) });
    hub.connect({ topics: ['greet'], lang: 'zh', send: (frame) => zhLive2.push(frame) });
    hub.connect({ topics: ['greet'], lang: 'en', send: (frame) => enLive.push(frame) });
    const seq = hub.publish('greet', {
      event: 'upsert',
      entity: 'msg',
      id: '1',
      value: (lang) => {
        calls += 1;
        return { text: lang === 'en' ? 'hello' : '你好' };
      },
    });
    assert.equal(seq, 1);
    assert.equal(calls, 2);
    const zhEvent = zhLive.find((frame) => frame.event === 'upsert');
    const enEvent = enLive.find((frame) => frame.event === 'upsert');
    assert.equal(zhEvent?.id, seq);
    assert.equal(enEvent?.id, seq);
    assert.equal(zhEvent?.data.value.text, '你好');
    assert.equal(zhLive2.find((frame) => frame.event === 'upsert')?.data.value.text, '你好');
    assert.equal(enEvent?.data.value.text, 'hello');

    const zhReplay = [];
    const enReplay = [];
    hub.connect({
      topics: ['greet'],
      lang: 'zh',
      lastEventId: '0',
      send: (frame) => zhReplay.push(frame),
    }).close();
    hub.connect({
      topics: ['greet'],
      lang: 'en',
      lastEventId: '0',
      send: (frame) => enReplay.push(frame),
    }).close();
    assert.equal(zhReplay[0].event, 'upsert');
    assert.equal(zhReplay[0].data.value.text, '你好');
    assert.equal(enReplay[0].event, 'upsert');
    assert.equal(enReplay[0].data.value.text, 'hello');
    assert.equal(calls, 2);
  } finally {
    hub.dispose();
  }
});

test('Last-Event-ID newer than the current seq sends a snapshot', () => {
  const hub = createEventHub({ heartbeatMs: 60_000 });
  try {
    hub.register('a', { snapshot: () => [{ entity: 'a', id: '1', value: { ok: true } }] });
    hub.publish('a', { event: 'upsert', entity: 'a', id: '1', value: { ok: true } });
    const frames = [];
    hub.connect({
      topics: ['a'],
      lastEventId: '99',
      send: (frame) => frames.push(frame),
    }).close();
    assert.equal(frames[0].event, 'snapshot');
    assert.equal(frames[0].id, hub.currentSeq());
  } finally {
    hub.dispose();
  }
});

test('hub event payloads match contract schemas', () => {
  const frames = collectUntil({}, (hub, frames) => {
    hub.register('service', {
      snapshot: () => [{
        entity: 'service',
        id: 'self',
        value: { protocolVersion: PROTOCOL_VERSION, serviceVersion: '0.1.0', pid: 1, startedAt: 1 },
      }],
    });
    hub.register('chat', { snapshot: () => [] });
    hub.connect({
      topics: ['service', 'chat'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    hub.publish('service', { event: 'upsert', entity: 'service', id: 'self', value: { ok: true } });
    hub.publish('service', { event: 'remove', entity: 'service', id: 'self' });
    hub.publish('chat', { event: 'text.delta', itemId: 'item-1', offset: 0, append: 'hi' });
    hub.heartbeat();
  });

  const byEvent = Object.fromEntries(frames.map((frame) => [frame.event, frame.data]));
  assert.ok(byEvent.snapshot);
  assert.ok(byEvent.upsert);
  assert.ok(byEvent.remove);
  assert.ok(byEvent['text.delta']);
  assert.ok(byEvent.heartbeat);
  assertSchema('SnapshotEvent', byEvent.snapshot);
  assertSchema('UpsertEvent', byEvent.upsert);
  assertSchema('RemoveEvent', byEvent.remove);
  assertSchema('TextDeltaEvent', byEvent['text.delta']);
  assertSchema('HeartbeatEvent', byEvent.heartbeat);
  assertSchema('EntityRef', byEvent.snapshot.entities[0]);
});

function rawEvents({ port, path: reqPath, headers = {}, until, timeoutMs = 2000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    const finish = (res, why) => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      resolve({
        status: res.statusCode,
        headers: res.headers,
        text,
        json,
        events: parseSSE(text),
        why,
      });
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: reqPath,
      headers,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => finish(res, 'end'));
        return;
      }
      const timer = setTimeout(() => {
        req.destroy();
        finish(res, 'timeout');
      }, timeoutMs);
      res.on('data', (chunk) => {
        chunks.push(chunk);
        if (until && until(parseSSE(Buffer.concat(chunks).toString('utf8')), res)) {
          clearTimeout(timer);
          req.destroy();
          finish(res, 'until');
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        finish(res, 'end');
      });
    });
    req.on('error', (err) => {
      if (settled) return;
      const code = err && typeof err === 'object' ? err.code : '';
      if (code === 'ECONNRESET' || code === 'ABORT_ERR') return;
      reject(err);
    });
    req.end();
  });
}

test('GET /api/v2/events without credentials is 401', async () => {
  const srv = await startServer();
  try {
    const res = await rawEvents({ port: srv.port, path: '/api/v2/events?topics=service' });
    assert.equal(res.status, 401);
    assert.equal(res.headers['weft-protocol'], PROTOCOL_VERSION);
    assert.equal(res.json?.code, 'E_UNAUTHORIZED');
    const checked = validateResponse('/api/v2/events', 'GET', 401, res.json);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  } finally {
    await stopServer(srv);
  }
});

test('GET /api/v2/events with unknown or empty topics is 400', async () => {
  const srv = await startServer();
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const auth = { authorization: `Bearer ${discovery.token}` };
    const unknown = await rawEvents({
      port: srv.port,
      path: '/api/v2/events?topics=nope',
      headers: auth,
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json?.code, 'E_BAD_REQUEST');
    const unknownChecked = validateResponse('/api/v2/events', 'GET', 400, unknown.json);
    assert.equal(unknownChecked.ok, true, JSON.stringify(unknownChecked.errors));

    const empty = await rawEvents({
      port: srv.port,
      path: '/api/v2/events?topics=',
      headers: auth,
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.json?.code, 'E_BAD_REQUEST');

    const missing = await rawEvents({
      port: srv.port,
      path: '/api/v2/events',
      headers: auth,
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json?.code, 'E_BAD_REQUEST');
  } finally {
    await stopServer(srv);
  }
});

test('GET /api/v2/events with Bearer first sends a service snapshot whose id is the current seq', async () => {
  const srv = await startServer();
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const res = await rawEvents({
      port: srv.port,
      path: '/api/v2/events?topics=service&lang=zh',
      headers: { authorization: `Bearer ${discovery.token}` },
      until: (events) => events.some((ev) => ev.event === 'snapshot'),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/event-stream/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(res.headers['x-accel-buffering'], 'no');
    assert.equal(res.headers['weft-protocol'], PROTOCOL_VERSION);
    const snapshot = res.events.find((ev) => ev.event === 'snapshot');
    assert.ok(snapshot);
    assert.equal(snapshot.id, 0);
    assertSchema('SnapshotEvent', snapshot.data);
    assert.equal(snapshot.data.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(snapshot.data.topics, ['service']);
    const entity = snapshot.data.entities.find((item) => item.entity === 'service' && item.id === 'self');
    assert.ok(entity);
    assert.equal(entity.topic, 'service');
    assert.equal(entity.value.protocolVersion, PROTOCOL_VERSION);
    assert.equal(entity.value.pid, srv.proc.pid);
    const serviceChecked = compileNamed('ServiceInfo');
    assert.equal(serviceChecked(entity.value), true, JSON.stringify(serviceChecked.errors));
  } finally {
    await stopServer(srv);
  }
});

test('GET /api/v2/events emits heartbeat when WEFT_V2_HEARTBEAT_MS is 200', async () => {
  const srv = await startServer({ env: { WEFT_V2_HEARTBEAT_MS: '200' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const res = await rawEvents({
      port: srv.port,
      path: '/api/v2/events?topics=service',
      headers: { authorization: `Bearer ${discovery.token}` },
      until: (events) => events.some((ev) => ev.event === 'heartbeat'),
      timeoutMs: 2000,
    });
    assert.equal(res.status, 200);
    const heartbeat = res.events.find((ev) => ev.event === 'heartbeat');
    assert.ok(heartbeat);
    assert.equal(heartbeat.id, undefined);
    assert.deepEqual(heartbeat.data, {});
    assertSchema('HeartbeatEvent', heartbeat.data);
  } finally {
    await stopServer(srv);
  }
});

test('query lastEventId and Last-Event-ID header resume the same way', async () => {
  const srv = await startServer({ env: { WEFT_V2_HEARTBEAT_MS: '200' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const auth = { authorization: `Bearer ${discovery.token}` };
    const first = await rawEvents({
      port: srv.port,
      path: '/api/v2/events?topics=service',
      headers: auth,
      until: (events) => events.some((ev) => ev.event === 'snapshot'),
    });
    const snapshot = first.events.find((ev) => ev.event === 'snapshot');
    assert.ok(snapshot);
    const seq = String(snapshot.id);

    const viaHeader = await rawEvents({
      port: srv.port,
      path: '/api/v2/events?topics=service',
      headers: { ...auth, 'Last-Event-ID': seq },
      until: (events) => events.some((ev) => ev.event === 'heartbeat'),
      timeoutMs: 2000,
    });
    const viaQuery = await rawEvents({
      port: srv.port,
      path: `/api/v2/events?topics=service&lastEventId=${encodeURIComponent(seq)}`,
      headers: auth,
      until: (events) => events.some((ev) => ev.event === 'heartbeat'),
      timeoutMs: 2000,
    });
    assert.equal(viaHeader.status, 200);
    assert.equal(viaQuery.status, 200);
    assert.equal(viaHeader.events.some((ev) => ev.event === 'snapshot'), false);
    assert.equal(viaQuery.events.some((ev) => ev.event === 'snapshot'), false);
    assert.equal(viaHeader.events.some((ev) => ev.event === 'heartbeat'), true);
    assert.equal(viaQuery.events.some((ev) => ev.event === 'heartbeat'), true);

    const badHeader = await rawEvents({
      port: srv.port,
      path: '/api/v2/events?topics=service',
      headers: { ...auth, 'Last-Event-ID': 'nope' },
      until: (events) => events.some((ev) => ev.event === 'snapshot'),
    });
    const badQuery = await rawEvents({
      port: srv.port,
      path: '/api/v2/events?topics=service&lastEventId=nope',
      headers: auth,
      until: (events) => events.some((ev) => ev.event === 'snapshot'),
    });
    assert.equal(badHeader.events[0]?.event, 'snapshot');
    assert.equal(badQuery.events[0]?.event, 'snapshot');
  } finally {
    await stopServer(srv);
  }
});

const IDLE_MINUTES = '0.02';
const IDLE_MS = Number(IDLE_MINUTES) * 60_000;

async function waitExit(proc, timeoutMs, logs = () => '') {
  if (proc.exitCode != null || proc.signalCode != null) {
    return { code: proc.exitCode, signal: proc.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.off('exit', onExit);
      reject(new Error(`process still running after ${timeoutMs}ms:\n${logs()}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    proc.once('exit', onExit);
  });
}

test('v2 events SSE keeps a launcher-started idle service alive until the connection closes', { timeout: 45000 }, async () => {
  const srv = await startServer({
    env: {
      WEFT_LAUNCHED_BY: 'weft-open',
      WEFT_IDLE_EXIT_MINUTES: IDLE_MINUTES,
      WEFT_LLM: 'faux',
    },
  });
  let req;
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const opened = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: srv.port,
        path: '/api/v2/events?topics=service',
        headers: {
          authorization: `Bearer ${discovery.token}`,
          accept: 'text/event-stream',
        },
      }, (res) => {
        res.on('data', () => {});
        resolve({ req: request, res });
      });
      request.on('error', reject);
      request.end();
    });
    req = opened.req;
    assert.equal(opened.res.statusCode, 200);
    await sleep(IDLE_MS * 2.5);
    assert.equal(srv.proc.exitCode, null, srv.logs());
    req.destroy();
    req = null;
    const ended = await waitExit(srv.proc, IDLE_MS * 8, srv.logs);
    assert.equal(ended.code, 0, srv.logs());
  } finally {
    try { req?.destroy(); } catch { /* ignore */ }
    await stopServer(srv);
  }
});
