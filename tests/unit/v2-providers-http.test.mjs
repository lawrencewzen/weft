import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { createV2Runtime } from '../../src/v2/index.ts';
import { discoveryPath } from '../../src/v2/daemon/discovery.ts';
import { readDiscovery, request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-providers-http-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

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
  return { status: res.status, body: parsed, text, headers: res.headers };
}

function assertChecked(apiPath, method, status, body) {
  const checked = validateResponse(apiPath, method, status, body);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
}

function assertNoSecret(payload, secret, label) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  assert.equal(text.includes(secret), false, `${label} leaked key: ${text}`);
}

function writeSettings(dataDir, value) {
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'));
  db.prepare('INSERT INTO settings (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
    .run('app', JSON.stringify(value));
  db.close();
}

function startFake(label, { status = 200, delayMs = 0, body } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || '',
        host: req.headers.host,
      });
      const reply = () => {
        if (status === 401) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `rejected ${label}` } }));
          return;
        }
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'fail' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body || { data: [{ id: label }] }));
      };
      if (delayMs) setTimeout(reply, delayMs);
      else reply();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        label,
        hits,
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('GET /api/v2/providers returns vendors and empty providers; unauth is 401', async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const empty = await sendV2(srv.base, 'GET', '/api/v2/providers', discovery.token);
    assert.equal(empty.status, 200, empty.text);
    assert.equal(empty.headers.get('weft-protocol'), PROTOCOL_VERSION);
    assertChecked('/api/v2/providers', 'GET', 200, empty.body);
    assert.equal(empty.body.providers.length, 0);
    assert.equal(empty.body.vendors.length, 11);
    assert.equal(empty.body.defaultModel, null);
    assert.equal(empty.body.vendors[0].id, 'deepseek');

    const unauth = await sendV2(srv.base, 'GET', '/api/v2/providers');
    assert.equal(unauth.status, 401);
    assertChecked('/api/v2/providers', 'GET', 401, unauth.body);
  } finally {
    await stopServer(srv);
  }
});

test('POST/PATCH/DELETE providers follow old source rules and never leak the key', async () => {
  const fake = await startFake('alpha');
  const other = await startFake('beta');
  const secret = 'key-alpha-secret';
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const created = await sendV2(srv.base, 'POST', '/api/v2/providers', discovery.token, {
      vendor: 'custom',
      name: 'A',
      baseUrl: fake.baseUrl,
      apiKey: secret,
      models: ['alpha'],
    });
    assert.equal(created.status, 201, created.text);
    assertChecked('/api/v2/providers', 'POST', 201, created.body);
    assert.equal(created.body.name, 'A');
    assert.equal(created.body.access, 'custom_endpoint');
    assert.equal(created.body.hasKey, true);
    assert.ok(created.body.keyMasked);
    assert.equal(created.body.status, 'untested');
    assertNoSecret(created.body, secret, 'create');
    const id = created.body.id;

    const listed = await sendV2(srv.base, 'GET', '/api/v2/providers', discovery.token);
    assert.equal(listed.status, 200, listed.text);
    assertChecked('/api/v2/providers', 'GET', 200, listed.body);
    assert.equal(listed.body.providers.length, 1);
    assertNoSecret(listed.body, secret, 'list');

    const renamed = await sendV2(srv.base, 'PATCH', `/api/v2/providers/${id}`, discovery.token, { name: 'Alpha' });
    assert.equal(renamed.status, 200, renamed.text);
    assertChecked(`/api/v2/providers/${id}`, 'PATCH', 200, renamed.body);
    assert.equal(renamed.body.name, 'Alpha');
    assert.equal(renamed.body.hasKey, true);

    const cleared = await sendV2(srv.base, 'PATCH', `/api/v2/providers/${id}`, discovery.token, {
      baseUrl: other.baseUrl,
    });
    assert.equal(cleared.status, 400, cleared.text);
    assert.equal(cleared.body.error, 'api key required');
    const still = await sendV2(srv.base, 'GET', '/api/v2/providers', discovery.token);
    assert.equal(still.body.providers[0].hasKey, true);
    assert.equal(still.body.providers[0].baseUrl, fake.baseUrl);

    const moved = await sendV2(srv.base, 'PATCH', `/api/v2/providers/${id}`, discovery.token, {
      baseUrl: other.baseUrl,
      apiKey: 'key-beta-secret',
    });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.body.hasKey, true);
    assertNoSecret(moved.body, 'key-beta-secret', 'moved');
    assertNoSecret(moved.body, secret, 'moved-old');

    const asDefault = await sendV2(srv.base, 'PATCH', `/api/v2/providers/${id}`, discovery.token, {
      defaultModel: 'alpha',
    });
    assert.equal(asDefault.status, 200, asDefault.text);
    const afterDefault = await sendV2(srv.base, 'GET', '/api/v2/providers', discovery.token);
    assert.deepEqual(afterDefault.body.defaultModel, { providerId: id, modelId: 'alpha' });
    assert.equal(afterDefault.body.providers[0].isDefault, true);

    const deleted = await sendV2(srv.base, 'DELETE', `/api/v2/providers/${id}`, discovery.token, {});
    assert.equal(deleted.status, 200, deleted.text);
    assertChecked(`/api/v2/providers/${id}`, 'DELETE', 200, deleted.body);
    const gone = await sendV2(srv.base, 'GET', '/api/v2/providers', discovery.token);
    assert.equal(gone.body.providers.length, 0);
    assert.equal(gone.body.defaultModel, null);
    assert.equal(JSON.stringify(srv.logs()).includes(secret), false);
    assert.equal(JSON.stringify(srv.logs()).includes('key-beta-secret'), false);
  } finally {
    await stopServer(srv);
    await Promise.all([fake.close(), other.close()]);
  }
});

test('provider test hits the given baseUrl: success, 401, and saved lastTest', async () => {
  const secret = 'sk-probe-secret-7788';
  const okFake = await startFake('ok-model');
  const authFake = await startFake('nope', { status: 401 });
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const draftOk = await sendV2(srv.base, 'POST', '/api/v2/providers/test', discovery.token, {
      vendor: 'custom',
      baseUrl: okFake.baseUrl,
      apiKey: secret,
    });
    assert.equal(draftOk.status, 200, draftOk.text);
    assertChecked('/api/v2/providers/test', 'POST', 200, draftOk.body);
    assert.equal(draftOk.body.ok, true);
    assert.deepEqual(draftOk.body.models, ['ok-model']);
    assert.equal(draftOk.body.status, 'ok');
    assertNoSecret(draftOk.body, secret, 'draft-ok');
    assert.equal(okFake.hits.some((hit) => String(hit.url).endsWith('/models')), true);
    assert.equal(okFake.hits[0].authorization, `Bearer ${secret}`);

    const draftAuth = await sendV2(srv.base, 'POST', '/api/v2/providers/test', discovery.token, {
      vendor: 'custom',
      baseUrl: authFake.baseUrl,
      apiKey: secret,
    });
    assert.equal(draftAuth.status, 200, draftAuth.text);
    assert.equal(draftAuth.body.ok, false);
    assert.equal(draftAuth.body.status, 'needs_auth');
    assert.match(draftAuth.body.statusText, /鉴权失败|Authentication failed/);
    assertNoSecret(draftAuth.body, secret, 'draft-401');
    const listed = await sendV2(srv.base, 'GET', '/api/v2/providers', discovery.token);
    assert.equal(listed.body.providers.length, 0);

    const created = await sendV2(srv.base, 'POST', '/api/v2/providers', discovery.token, {
      vendor: 'custom',
      name: 'Saved',
      baseUrl: okFake.baseUrl,
      apiKey: secret,
      models: [],
    });
    assert.equal(created.status, 201, created.text);
    const tested = await sendV2(srv.base, 'POST', `/api/v2/providers/${created.body.id}/test`, discovery.token, {});
    assert.equal(tested.status, 200, tested.text);
    assertChecked(`/api/v2/providers/${created.body.id}/test`, 'POST', 200, tested.body);
    assert.equal(tested.body.status, 'ok');
    assert.deepEqual(tested.body.models.map((item) => item.id), ['ok-model']);
    assert.ok(tested.body.lastTestedAt);
    assertNoSecret(tested.body, secret, 'saved-test');

    const en = await sendV2(srv.base, 'POST', `/api/v2/providers/test?lang=en`, discovery.token, {
      vendor: 'custom',
      baseUrl: authFake.baseUrl,
      apiKey: secret,
    });
    assert.equal(en.body.statusText, 'Authentication failed: rejected nope');
  } finally {
    await stopServer(srv);
    await Promise.all([okFake.close(), authFake.close()]);
  }
});

test('POST /api/v2/providers/test times out against a hanging origin', async () => {
  process.env.WEFT_V2_VALIDATE = '1';
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-v2-probe-timeout-'));
  const hanging = await startFake('slow', { delayMs: 5_000 });
  const runtime = createV2Runtime({
    serviceVersion: '0.1.0',
    startedAt: 1,
    dataDir,
    probeTimeoutMs: 120,
    getSettings: async () => ({ sources: [], models: {} }),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    runtime.handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  runtime.writeDiscoveryFile(port);
  try {
    const discovery = JSON.parse(await readFile(discoveryPath(dataDir), 'utf8'));
    const probed = await sendV2(`http://127.0.0.1:${port}`, 'POST', '/api/v2/providers/test', discovery.token, {
      vendor: 'custom',
      baseUrl: hanging.baseUrl,
      apiKey: 'sk-timeout-secret',
    });
    assert.equal(probed.status, 200, probed.text);
    assertChecked('/api/v2/providers/test', 'POST', 200, probed.body);
    assert.equal(probed.body.ok, false);
    assert.equal(probed.body.status, 'unreachable');
    assert.match(probed.body.statusText, /超时|Timed out/);
    assertNoSecret(probed.body, 'sk-timeout-secret', 'timeout');
    assert.equal(probed.body.models.length, 0);
  } finally {
    runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
    await hanging.close();
  }
});

test('context-window set/restore updates conversation context; PATCH model updates conversation.model', async () => {
  const fake = await startFake('alpha', { body: { data: [{ id: 'alpha' }, { id: 'beta' }] } });
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const created = await sendV2(srv.base, 'POST', '/api/v2/providers', discovery.token, {
      vendor: 'custom',
      name: 'A',
      baseUrl: fake.baseUrl,
      apiKey: 'key-alpha-secret',
      models: ['alpha', 'beta'],
    });
    assert.equal(created.status, 201, created.text);
    const id = created.body.id;
    const bound = await sendV2(srv.base, 'PATCH', `/api/v2/providers/${id}`, discovery.token, {
      defaultModel: 'alpha',
    });
    assert.equal(bound.status, 200, bound.text);

    const tooSmall = await sendV2(srv.base, 'PUT', `/api/v2/providers/${id}/models/alpha/context-window`, discovery.token, {
      window: 12,
    });
    assert.equal(tooSmall.status, 400);
    assertChecked(`/api/v2/providers/${id}/models/alpha/context-window`, 'PUT', 400, tooSmall.body);

    const setWin = await sendV2(srv.base, 'PUT', `/api/v2/providers/${id}/models/alpha/context-window`, discovery.token, {
      window: 256000,
    });
    assert.equal(setWin.status, 200, setWin.text);
    assertChecked(`/api/v2/providers/${id}/models/alpha/context-window`, 'PUT', 200, setWin.body);
    const alpha = setWin.body.models.find((item) => item.id === 'alpha');
    assert.equal(alpha.contextWindow, 256000);
    assert.equal(alpha.contextWindowCustom, true);

    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'models' });
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'm' });
    assert.equal(conv.status, 201);
    const snap = await sendV2(srv.base, 'GET', `/api/v2/conversations/${conv.body.id}`, discovery.token);
    assert.equal(snap.status, 200, snap.text);
    assert.equal(snap.body.conversation.context.window, 256000);
    assert.equal(snap.body.conversation.model.sourceId, id);
    assert.equal(snap.body.conversation.model.modelId, 'alpha');

    const switched = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${conv.body.id}`, discovery.token, {
      model: { providerId: id, modelId: 'beta' },
    });
    assert.equal(switched.status, 200, switched.text);
    assertChecked(`/api/v2/conversations/${conv.body.id}`, 'PATCH', 200, switched.body);
    assert.equal(switched.body.model.modelId, 'beta');
    assert.equal(switched.body.context.window, 128000);

    const restored = await sendV2(srv.base, 'PUT', `/api/v2/providers/${id}/models/alpha/context-window`, discovery.token, {
      window: null,
    });
    assert.equal(restored.status, 200, restored.text);
    const alpha2 = restored.body.models.find((item) => item.id === 'alpha');
    assert.equal(alpha2.contextWindowCustom, false);

    const back = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${conv.body.id}`, discovery.token, {
      model: null,
    });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.body.model.modelId, 'alpha');
    assert.equal(back.body.context.window, 128000);

    const bad = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${conv.body.id}`, discovery.token, {
      model: { providerId: id, modelId: 'missing' },
    });
    assert.equal(bad.status, 400);
  } finally {
    await stopServer(srv);
    await fake.close();
  }
});

test('leftover kind:grok source is omitted from GET /api/v2/providers and sending a message does not crash', {
  timeout: 60000,
}, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-v2-legacy-source-'));
  const first = await startServer({ token: TOKEN, dataDir });
  await stopServer(first);
  writeSettings(dataDir, {
    version: 2,
    sources: [{
      id: 'grok',
      kind: 'grok',
      vendor: 'grok',
      name: 'Grok 订阅',
      baseUrl: '',
      apiKey: '',
      models: ['grok-build'],
    }],
    models: { default: { sourceId: 'grok', model: 'grok-build' } },
  });
  const srv = await startServer({ token: TOKEN, dataDir });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const listed = await sendV2(srv.base, 'GET', '/api/v2/providers', discovery.token);
    assert.equal(listed.status, 200, listed.text);
    assertChecked('/api/v2/providers', 'GET', 200, listed.body);
    assert.equal(listed.body.providers.some((item) => item.id === 'grok' || item.vendor === 'Grok'), false, JSON.stringify(listed.body.providers));
    assert.equal(listed.body.providers.length, 0);

    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'legacy-source' });
    assert.equal(ws.status, 201, ws.text);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'pinned-to-dropped-source',
    });
    assert.equal(conv.status, 201, conv.text);
    const sent = await sendV2(srv.base, 'POST', `/api/v2/conversations/${conv.body.id}/messages`, discovery.token, {
      text: 'hello leftover',
    });
    assert.equal(sent.status, 202, sent.text);
    assertChecked(`/api/v2/conversations/${conv.body.id}/messages`, 'POST', 202, sent.body);

    let last = null;
    for (let i = 0; i < 80; i += 1) {
      last = await sendV2(srv.base, 'GET', `/api/v2/conversations/${conv.body.id}`, discovery.token);
      const runStatus = last.body?.conversation?.run?.status;
      if (last.status === 200 && (runStatus === 'failed' || runStatus === 'idle' || runStatus === 'done')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(last.status, 200, last?.text);
    const run = last.body?.conversation?.run;
    assert.equal(run?.status, 'failed', JSON.stringify(last.body));
    assert.equal(run?.error?.code, 'E_NO_MODEL');
  } finally {
    await stopServer(srv);
  }
});
