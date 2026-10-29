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
import { attachProvidersTopic, PROVIDERS_TOPIC } from '../../src/v2/stream/providers-topic.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const TOKEN = 'v2-providers-topic-token';

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

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function sendV2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? v2Headers(token) : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
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

function startFake(label) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: label }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('in-process providers topic snapshots defaults and upserts/removes providers', async () => {
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  let settings = { sources: [], models: {} };
  const topic = attachProvidersTopic(hub, {
    loader: {
      getSettings: async () => settings,
    },
    log() {},
  });
  try {
    const frames = [];
    const session = hub.connect({
      topics: [PROVIDERS_TOPIC],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    assert.equal(topic.subscriberActive(), true);
    assert.equal(frames[0].event, 'snapshot');
    assertSchema('SnapshotEvent', frames[0].data);
    const defaults = frames[0].data.entities.find((item) => item.entity === 'defaults' && item.id === 'self');
    assert.ok(defaults);
    assertSchema('ProviderDefaults', defaults.value);
    assert.equal(defaults.value.model, null);

    settings = {
      sources: [{
        id: 'abcd1234',
        kind: 'api',
        vendor: 'custom',
        name: 'A',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-hidden-value',
        models: ['alpha'],
      }],
      models: { default: { sourceId: 'abcd1234', model: 'alpha' } },
    };
    topic.notify();
    const started = Date.now();
    while (Date.now() - started < 2000) {
      if (frames.some((frame) => frame.event === 'upsert' && frame.data.entity === 'provider' && frame.data.id === 'abcd1234')) break;
      await sleep(20);
    }
    const upsert = frames.find((frame) => frame.event === 'upsert' && frame.data.entity === 'provider' && frame.data.id === 'abcd1234');
    assert.ok(upsert, JSON.stringify(frames.map((frame) => frame.event)));
    assertSchema('Provider', upsert.data.value);
    assert.equal(JSON.stringify(upsert.data.value).includes('sk-hidden-value'), false);
    const defUp = frames.find((frame) => frame.event === 'upsert' && frame.data.entity === 'defaults');
    assert.ok(defUp);
    assert.deepEqual(defUp.data.value.model, { providerId: 'abcd1234', modelId: 'alpha' });

    settings = { sources: [], models: {} };
    topic.notify();
    const rmAt = Date.now();
    while (Date.now() - rmAt < 2000) {
      if (frames.some((frame) => frame.event === 'remove' && frame.data.entity === 'provider' && frame.data.id === 'abcd1234')) break;
      await sleep(20);
    }
    assert.equal(frames.some((frame) => frame.event === 'remove' && frame.data.entity === 'provider' && frame.data.id === 'abcd1234'), true);
    session.close();
    assert.equal(topic.subscriberActive(), false);
  } finally {
    topic.dispose();
    hub.dispose();
  }
});

test('v2 and old source APIs both push providers; conversation topic updates after model patch', async () => {
  const fake = await startFake('alpha');
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: 'providers',
      lang: 'zh',
    });
    await waitEvents(session, (events) => events.some((ev) => ev.event === 'snapshot'));
    const snap = session.events.find((ev) => ev.event === 'snapshot');
    assertSchema('SnapshotEvent', snap.data);
    const checked = validateResponse('/api/v2/events', 'GET', 200, { ok: true });
    assert.equal(typeof checked.ok, 'boolean');

    const created = await sendV2(srv.base, 'POST', '/api/v2/providers', discovery.token, {
      vendor: 'custom',
      name: 'Live',
      baseUrl: fake.baseUrl,
      apiKey: 'key-live-secret',
      models: ['alpha'],
    });
    assert.equal(created.status, 201, created.text);
    await waitEvents(session, (events) => events.some((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'provider' && ev.data.id === created.body.id
    )));
    const live = session.events.find((ev) => ev.event === 'upsert' && ev.data.id === created.body.id);
    assertSchema('Provider', live.data.value);
    assert.equal(JSON.stringify(live.data.value).includes('key-live-secret'), false);

    const viaOld = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'Old',
      baseUrl: fake.baseUrl,
      apiKey: 'key-old-secret',
      models: ['alpha'],
    }, TOKEN);
    assert.equal(viaOld.status, 201, JSON.stringify(viaOld.body));
    await waitEvents(session, (events) => events.some((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'provider' && ev.data.id === viaOld.body.id
    )));

    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 't' }, TOKEN);
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'c' }, TOKEN);
    assert.equal(conv.status, 201);
    await sendV2(srv.base, 'PATCH', `/api/v2/providers/${created.body.id}`, discovery.token, {
      defaultModel: 'alpha',
    });

    const convSession = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.body.id}`,
      lang: 'zh',
    });
    await waitEvents(convSession, (events) => events.some((ev) => ev.event === 'snapshot'));
    const patched = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${conv.body.id}`, discovery.token, {
      model: { providerId: created.body.id, modelId: 'alpha' },
    });
    assert.equal(patched.status, 200, patched.text);
    await waitEvents(convSession, (events) => events.some((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'conversation'
      && ev.data.value?.model?.modelId === 'alpha'
    )));
    convSession.close();
    session.close();
  } finally {
    await stopServer(srv);
    await fake.close();
  }
});
