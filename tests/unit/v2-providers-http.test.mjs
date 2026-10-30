import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { handleProvidersApi } from '../../src/v2/providers-http.ts';
import { phrase } from '../../src/v2/phrases/index.ts';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore, createModelsStore } from '../../src/core/provider-stores.mjs';
import {
  createProviderService,
  EXCLUDED_PROVIDER_IDS,
  POPULAR_PROVIDER_IDS,
} from '../../src/core/provider-service.mjs';
import { readDiscovery, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  fakeKeyProvider,
  fakeOAuthProvider,
  waitUntil,
} from './provider-fakes.mjs';

const TOKEN = 'v2-providers-http-token';
const SECRET = 'sk-http-never-leak-key-99';

function assertChecked(apiPath, method, status, body) {
  const checked = validateResponse(apiPath.split('?')[0], method, status, body);
  assert.equal(checked.ok, true, `${method} ${apiPath} ${status}: ${JSON.stringify(checked.errors)}\n${JSON.stringify(body)}`);
}

function assertNoSecret(value, secret = SECRET) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(secret), false, `secret leaked: ${text.slice(0, 400)}`);
}

async function send(base, method, apiPath, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body == null || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

function deepseekFake(onCall) {
  return fakeKeyProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    models: ['deepseek-chat', 'deepseek-flash'],
    envVar: 'DEEPSEEK_API_KEY',
    onCall,
  });
}

async function readObjectBody(req, res, pathname, method, sendV2) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    sendV2(res, pathname, method, 400, { error: 'invalid body', code: 'E_BAD_REQUEST' });
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendV2(res, pathname, method, 400, { error: 'invalid body', code: 'E_BAD_REQUEST' });
      return null;
    }
    return parsed;
  } catch {
    sendV2(res, pathname, method, 400, { error: 'invalid JSON', code: 'E_BAD_REQUEST' });
    return null;
  }
}

function sendV2(res, requestPath, method, status, body) {
  if (status === 204) {
    res.writeHead(204, {
      'cache-control': 'no-store',
      'Weft-Protocol': PROTOCOL_VERSION,
    });
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'Weft-Protocol': PROTOCOL_VERSION,
  });
  res.end(JSON.stringify(body));
}

async function withHttp(fn, serviceOpts = {}) {
  const dir = await makeTempDir('weft-providers-http-');
  const store = createSqliteStore(dir);
  const credentials = createCredentialStore(store);
  const modelsStore = createModelsStore(store);
  if (serviceOpts.settings) await store.replaceSettings(serviceOpts.settings);
  const changes = [];
  const service = createProviderService({
    store,
    credentials,
    modelsStore,
    env: { GROK_HOME: dir, ...(serviceOpts.env || {}) },
    extraProviders: serviceOpts.extraProviders,
    fetchImpl: serviceOpts.fetchImpl,
    now: serviceOpts.now,
    loginTtlMs: serviceOpts.loginTtlMs,
    onChange() { changes.push(Date.now()); },
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const handled = await handleProvidersApi({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method || 'GET',
      sendV2,
      readObjectBody: (incoming, outgoing, pathname, method) => (
        readObjectBody(incoming, outgoing, pathname, method, sendV2)
      ),
    }, { service });
    if (!handled) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', code: 'E_NOT_FOUND' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn({
      base,
      service,
      store,
      credentials,
      modelsStore,
      changes,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await removeTempDir(dir);
  }
}

test('GET /api/v2/providers empty snapshot; 401 on the live server', async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const unauth = await fetch(`${srv.base}/api/v2/providers`);
    const unauthBody = await unauth.json();
    assert.equal(unauth.status, 401);
    assertChecked('/api/v2/providers', 'GET', 401, unauthBody);

    const got = await fetch(`${srv.base}/api/v2/providers`, {
      headers: { authorization: `Bearer ${discovery.token}` },
    });
    const body = await got.json();
    assert.equal(got.status, 200, JSON.stringify(body));
    assert.equal(got.headers.get('weft-protocol'), PROTOCOL_VERSION);
    assertChecked('/api/v2/providers', 'GET', 200, body);
    assert.deepEqual(body.providers, []);
    assert.equal(body.defaultModel, null);
  } finally {
    await stopServer(srv);
  }
});

test('GET /api/v2/providers returns the first enabled model when defaultModel is unset or disabled', async () => {
  const providers = [{
    id: 'custom-aaaaaaaa',
    kind: 'custom',
    name: 'Local',
    baseUrl: 'http://127.0.0.1:9/v1',
    api: 'openai-completions',
    enabled: ['alpha', 'beta'],
    overrides: {},
  }];

  await withHttp(async ({ base, store }) => {
    assert.equal((await store.getSettings()).defaultModel, null);
    const listed = await send(base, 'GET', '/api/v2/providers');
    assert.equal(listed.status, 200);
    assertChecked('/api/v2/providers', 'GET', 200, listed.body);
    assert.deepEqual(listed.body.defaultModel, {
      providerId: 'custom-aaaaaaaa',
      modelId: 'alpha',
    });
  }, {
    settings: { version: 3, providers, defaultModel: null },
  });

  await withHttp(async ({ base }) => {
    const listed = await send(base, 'GET', '/api/v2/providers');
    assert.equal(listed.status, 200);
    assertChecked('/api/v2/providers', 'GET', 200, listed.body);
    assert.deepEqual(listed.body.defaultModel, {
      providerId: 'custom-aaaaaaaa',
      modelId: 'alpha',
    });
  }, {
    settings: {
      version: 3,
      providers,
      defaultModel: { providerId: 'custom-aaaaaaaa', modelId: 'gone' },
    },
  });

  await withHttp(async ({ base }) => {
    const listed = await send(base, 'GET', '/api/v2/providers');
    assert.equal(listed.status, 200);
    assertChecked('/api/v2/providers', 'GET', 200, listed.body);
    assert.equal(listed.body.defaultModel, null);
  }, {
    settings: {
      version: 3,
      providers: [{ ...providers[0], enabled: [] }],
      defaultModel: null,
    },
  });
});

test('legacy /api/sources routes still return 503 E_UNAVAILABLE', async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const listed = await fetch(`${srv.base}/api/sources`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const listedBody = await listed.json();
    assert.equal(listed.status, 503, JSON.stringify(listedBody));
    assert.equal(listedBody.code, 'E_UNAVAILABLE');
    const created = await fetch(`${srv.base}/api/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ vendor: 'custom' }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 503);
    assert.equal(createdBody.code, 'E_UNAVAILABLE');
  } finally {
    await stopServer(srv);
  }
});

test('GET /api/v2/providers/available sorts popular, excludes blocked ids, localizes zh names', async () => {
  await withHttp(async ({ base }) => {
    const zh = await send(base, 'GET', '/api/v2/providers/available?lang=zh');
    assert.equal(zh.status, 200, zh.text);
    assertChecked('/api/v2/providers/available', 'GET', 200, zh.body);
    const ids = zh.body.providers.map((item) => item.id);
    for (const blocked of EXCLUDED_PROVIDER_IDS) {
      assert.equal(ids.includes(blocked), false, blocked);
    }
    const popular = zh.body.providers.filter((item) => item.popular).map((item) => item.id);
    const expectedPopular = POPULAR_PROVIDER_IDS.filter((id) => ids.includes(id));
    assert.deepEqual(popular, expectedPopular);
    assert.deepEqual(zh.body.providers.slice(0, popular.length).map((item) => item.id), popular);
    const byId = Object.fromEntries(zh.body.providers.map((item) => [item.id, item]));
    assert.equal(byId['moonshotai-cn']?.name, 'Kimi（国内）');
    assert.equal(byId.zai?.name, '智谱 Z.AI');
    assert.equal(byId['qwen-token-plan-cn']?.name, '通义千问 Token Plan（国内）');
    assert.equal(byId['minimax-cn']?.name, 'MiniMax（国内）');
    assert.equal(byId.xiaomi?.name, '小米 MiMo');
    assert.equal(byId.deepseek?.brand, 'deepseek');
    assert.equal(byId.deepseek?.envVar, 'DEEPSEEK_API_KEY');
    assert.equal(byId.deepseek?.connected, false);
    assert.equal(ids.includes('xai'), true);
    assert.equal(ids.includes('github-copilot'), false);
    assert.equal(byId.xai?.name, 'Grok');
    assert.deepEqual(byId.xai?.authMethods, ['oauth']);
    assert.equal(byId.xai?.localLogin?.detected, false);
    assert.deepEqual(byId.anthropic?.authMethods, ['api_key']);
    assert.equal(byId.anthropic?.authMethods.includes('oauth'), false);
    const dumped = JSON.stringify(zh.body);
    assert.equal(dumped.includes('refresh_token'), false);

    const en = await send(base, 'GET', '/api/v2/providers/available?lang=en');
    assert.equal(en.status, 200, en.text);
    assertChecked('/api/v2/providers/available', 'GET', 200, en.body);
    const enById = Object.fromEntries(en.body.providers.map((item) => [item.id, item]));
    assert.equal(enById['moonshotai-cn']?.name, 'Kimi (China)');
    assert.equal(enById.zai?.name, 'Zhipu Z.AI');
    assert.equal(enById['qwen-token-plan-cn']?.name, 'Qwen Token Plan (China)');
    assert.equal(enById['minimax-cn']?.name, 'MiniMax (China)');
    assert.equal(enById.xiaomi?.name, 'Xiaomi MiMo');
    assert.equal(enById.xai?.name, 'Grok');
  });
});

test('POST connect api_key success and auth failure does not save or leak the key', async () => {
  let allow = false;
  await withHttp(async ({ base, credentials, store }) => {
    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args) => { logs.push(args.map(String).join(' ')); };
    let failed;
    try {
      failed = await send(base, 'POST', '/api/v2/providers/deepseek/connect?lang=zh', {
        method: 'api_key',
        apiKey: SECRET,
      });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.equal(failed.status, 400, failed.text);
    assert.equal(failed.body.code, 'E_AUTH');
    assertChecked('/api/v2/providers/deepseek/connect', 'POST', 400, failed.body);
    assertNoSecret(failed.body);
    assertNoSecret(logs.join('\n'));
    assert.equal(await credentials.read('deepseek'), undefined);
    assert.deepEqual((await store.getSettings()).providers, []);

    allow = true;
    const ok = await send(base, 'POST', '/api/v2/providers/deepseek/connect?lang=zh', {
      method: 'api_key',
      apiKey: SECRET,
    });
    assert.equal(ok.status, 200, ok.text);
    assertChecked('/api/v2/providers/deepseek/connect', 'POST', 200, ok.body);
    assert.equal(ok.body.provider.id, 'deepseek');
    assert.equal(ok.body.provider.auth.type, 'api_key');
    assert.equal(ok.body.provider.auth.keyTail, SECRET.slice(-4));
    assert.equal(ok.body.provider.status.state, 'ok');
    assertNoSecret(ok.body);
    assert.equal((await credentials.read('deepseek')).key, SECRET);

    const listed = await send(base, 'GET', '/api/v2/providers?lang=zh');
    assert.equal(listed.status, 200);
    assertChecked('/api/v2/providers', 'GET', 200, listed.body);
    assert.equal(listed.body.providers[0].id, 'deepseek');
    assertNoSecret(listed.body);
  }, {
    extraProviders: [deepseekFake(() => (allow
      ? { ok: true }
      : { ok: false, status: 401, errorMessage: 'invalid api key' }))],
  });
});

test('POST connect env succeeds when the env var is present', async () => {
  await withHttp(async ({ base, credentials }) => {
    const missing = await send(base, 'POST', '/api/v2/providers/deepseek/connect', { method: 'env' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'E_BAD_REQUEST');
    assertChecked('/api/v2/providers/deepseek/connect', 'POST', 400, missing.body);
  }, { extraProviders: [deepseekFake()] });

  await withHttp(async ({ base, credentials }) => {
    const ok = await send(base, 'POST', '/api/v2/providers/deepseek/connect?lang=zh', { method: 'env' });
    assert.equal(ok.status, 200, ok.text);
    assertChecked('/api/v2/providers/deepseek/connect', 'POST', 200, ok.body);
    assert.equal(ok.body.provider.auth.type, 'env');
    assert.equal(ok.body.provider.auth.envVar, 'DEEPSEEK_API_KEY');
    assert.equal(await credentials.read('deepseek'), undefined);
  }, {
    env: { DEEPSEEK_API_KEY: 'sk-from-env' },
    extraProviders: [deepseekFake()],
  });
});

test('POST connect oauth, poll, answer, done; cancel and unknown session', async () => {
  await withHttp(async ({ base, credentials }) => {
    const bad = await send(base, 'POST', '/api/v2/providers/nope/connect', { method: 'oauth' });
    assert.equal(bad.status, 404);
    assertChecked('/api/v2/providers/nope/connect', 'POST', 404, bad.body);

    const started = await send(base, 'POST', '/api/v2/providers/google/connect?lang=zh', {
      method: 'oauth',
    });
    assert.equal(started.status, 200, started.text);
    assertChecked('/api/v2/providers/google/connect', 'POST', 200, started.body);
    const sid = started.body.session.id;
    assert.ok(['pending', 'prompt'].includes(started.body.session.state));

    const prompted = await waitUntil(async () => {
      const got = await send(base, 'GET', `/api/v2/login-sessions/${sid}?lang=zh`);
      assert.equal(got.status, 200, got.text);
      assertChecked(`/api/v2/login-sessions/${sid}`, 'GET', 200, got.body);
      return got.body.session.state === 'prompt' ? got.body.session : null;
    });
    assert.equal(prompted.prompt.type, 'manual_code');
    assert.equal(prompted.events[0].type, 'auth_url');
    assert.equal(prompted.events[1].type, 'device_code');

    const answered = await send(base, 'POST', `/api/v2/login-sessions/${sid}/answer`, {
      value: 'user-code',
    });
    assert.equal(answered.status, 200, answered.text);
    assertChecked(`/api/v2/login-sessions/${sid}/answer`, 'POST', 200, answered.body);

    const done = await waitUntil(async () => {
      const got = await send(base, 'GET', `/api/v2/login-sessions/${sid}`);
      return got.body.session.state === 'done' ? got.body.session : null;
    });
    assert.equal(done.provider.id, 'google');
    assert.equal(done.provider.auth.type, 'oauth');
    assert.equal((await credentials.read('google')).type, 'oauth');

    const missing = await send(base, 'GET', '/api/v2/login-sessions/unknown');
    assert.equal(missing.status, 404);
    assertChecked('/api/v2/login-sessions/unknown', 'GET', 404, missing.body);
    assert.equal(missing.body.error, phrase('zh', 'src_err_session'));
  }, { extraProviders: [fakeOAuthProvider({ id: 'google', name: 'Google' })] });
});

test('POST login-sessions cancel', async () => {
  await withHttp(async ({ base, store }) => {
    const started = await send(base, 'POST', '/api/v2/providers/google/connect', { method: 'oauth' });
    const sid = started.body.session.id;
    await waitUntil(async () => {
      const got = await send(base, 'GET', `/api/v2/login-sessions/${sid}`);
      return got.body.session.state === 'prompt';
    });
    const cancelled = await send(base, 'POST', `/api/v2/login-sessions/${sid}/cancel`, {});
    assert.equal(cancelled.status, 200, cancelled.text);
    assertChecked(`/api/v2/login-sessions/${sid}/cancel`, 'POST', 200, cancelled.body);
    assert.equal(cancelled.body.session.state, 'cancelled');
    assert.deepEqual((await store.getSettings()).providers, []);
  }, { extraProviders: [fakeOAuthProvider({ id: 'google', name: 'Google' })] });
});

test('POST /api/v2/providers/custom fetches /models; failure does not save', async () => {
  await withHttp(async ({ base, store, credentials }) => {
    const failed = await send(base, 'POST', '/api/v2/providers/custom?lang=zh', {
      name: 'Local',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      apiKey: SECRET,
    });
    assert.equal(failed.status, 400, failed.text);
    assertChecked('/api/v2/providers/custom', 'POST', 400, failed.body);
    assertNoSecret(failed.body);
    assert.deepEqual((await store.getSettings()).providers, []);
    assert.equal((await credentials.list()).length, 0);

    const missingName = await send(base, 'POST', '/api/v2/providers/custom', {
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
    });
    assert.equal(missingName.status, 400);
    assert.equal(missingName.body.code, 'E_BAD_REQUEST');
  }, {
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }),
  });

  await withHttp(async ({ base }) => {
    const created = await send(base, 'POST', '/api/v2/providers/custom?lang=zh', {
      name: 'Local',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      apiKey: 'sk-custom-ok',
    });
    assert.equal(created.status, 200, created.text);
    assertChecked('/api/v2/providers/custom', 'POST', 200, created.body);
    assert.equal(created.body.provider.kind, 'custom');
    assert.equal(created.body.provider.brand, null);
    assert.equal(created.body.provider.models.length, 2);
    assert.equal(created.body.provider.models.every((item) => item.enabled), true);
    assertNoSecret(created.body, 'sk-custom-ok');
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta' }] }),
    }),
  });
});

test('POST test, PATCH, DELETE 204, and 404 for missing provider', async () => {
  await withHttp(async ({ base, credentials, store }) => {
    const missingTest = await send(base, 'POST', '/api/v2/providers/deepseek/test', {});
    assert.equal(missingTest.status, 404);
    assertChecked('/api/v2/providers/deepseek/test', 'POST', 404, missingTest.body);

    const connected = await send(base, 'POST', '/api/v2/providers/deepseek/connect', {
      method: 'api_key',
      apiKey: 'sk-ok-123456',
    });
    assert.equal(connected.status, 200, connected.text);

    const tested = await send(base, 'POST', '/api/v2/providers/deepseek/test', {});
    assert.equal(tested.status, 200, tested.text);
    assertChecked('/api/v2/providers/deepseek/test', 'POST', 200, tested.body);
    assert.equal(tested.body.provider.status.state, 'ok');

    const patched = await send(base, 'PATCH', '/api/v2/providers/deepseek?lang=zh', {
      enabled: ['deepseek-chat'],
      overrides: { 'deepseek-chat': { contextWindow: 64000, maxTokens: 1024 } },
      defaultModel: 'deepseek-chat',
    });
    assert.equal(patched.status, 200, patched.text);
    assertChecked('/api/v2/providers/deepseek', 'PATCH', 200, patched.body);
    const chat = patched.body.provider.models.find((item) => item.id === 'deepseek-chat');
    assert.equal(chat.enabled, true);
    assert.equal(chat.overridden.contextWindow, true);
    assert.equal(chat.overridden.maxTokens, true);
    const listed = await send(base, 'GET', '/api/v2/providers');
    assert.deepEqual(listed.body.defaultModel, {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
    });

    const cleared = await send(base, 'PATCH', '/api/v2/providers/deepseek', {
      overrides: { 'deepseek-chat': { contextWindow: null, maxTokens: null } },
      defaultModel: null,
    });
    assert.equal(cleared.status, 200);
    const clearedChat = cleared.body.provider.models.find((item) => item.id === 'deepseek-chat');
    assert.deepEqual(clearedChat.overridden, {});

    await send(base, 'PATCH', '/api/v2/providers/deepseek', { defaultModel: 'deepseek-chat' });
    const removed = await send(base, 'DELETE', '/api/v2/providers/deepseek');
    assert.equal(removed.status, 204, removed.text);
    assert.equal(removed.body, null);
    assertChecked('/api/v2/providers/deepseek', 'DELETE', 204, removed.body);
    assert.equal(await credentials.read('deepseek'), undefined);
    assert.deepEqual((await store.getSettings()).providers, []);
    const after = await send(base, 'GET', '/api/v2/providers');
    assert.equal(after.body.defaultModel, null);

    const missingDel = await send(base, 'DELETE', '/api/v2/providers/deepseek');
    assert.equal(missingDel.status, 404);
    assertChecked('/api/v2/providers/deepseek', 'DELETE', 404, missingDel.body);
  }, { extraProviders: [deepseekFake()] });
});

test('POST connect rejects unknown methods', async () => {
  await withHttp(async ({ base }) => {
    const got = await send(base, 'POST', '/api/v2/providers/deepseek/connect', { method: 'magic' });
    assert.equal(got.status, 400);
    assert.equal(got.body.code, 'E_BAD_REQUEST');
    assertChecked('/api/v2/providers/deepseek/connect', 'POST', 400, got.body);
  }, { extraProviders: [deepseekFake()] });
});

test('POST connect local_login imports Grok login and does not leak tokens', async () => {
  const access = 'access-fixture-http';
  const refresh = 'refresh-fixture-http';
  const home = await makeTempDir('weft-grok-http-');
  try {
    mkdirSync(path.join(home, '.grok'), { recursive: true });
    writeFileSync(path.join(home, '.grok', 'auth.json'), JSON.stringify({
      'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
        key: access,
        refresh_token: refresh,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        email: 'tester@x.com',
      },
    }), 'utf8');
    await withHttp(async ({ base, credentials }) => {
      const listed = await send(base, 'GET', '/api/v2/providers/available');
      assert.equal(listed.status, 200, listed.text);
      assertChecked('/api/v2/providers/available', 'GET', 200, listed.body);
      const xai = listed.body.providers.find((item) => item.id === 'xai');
      assert.equal(xai.localLogin.detected, true);
      assert.equal(xai.localLogin.account, 'tester@x.com');
      assert.equal(JSON.stringify(listed.body).includes(access), false);
      assert.equal('credential' in xai.localLogin, false);

      const denied = await send(base, 'POST', '/api/v2/providers/anthropic/connect', { method: 'local_login' });
      assert.equal(denied.status, 400);
      assert.equal(denied.body.code, 'E_BAD_REQUEST');

      const got = await send(base, 'POST', '/api/v2/providers/xai/connect', { method: 'local_login' });
      assert.equal(got.status, 200, got.text);
      assertChecked('/api/v2/providers/xai/connect', 'POST', 200, got.body);
      assert.equal(got.body.provider.id, 'xai');
      assert.equal(got.body.provider.auth.type, 'oauth');
      assert.equal(got.body.provider.auth.account, 'tester@x.com');
      const dumped = JSON.stringify(got.body);
      assert.equal(dumped.includes(access), false);
      assert.equal(dumped.includes(refresh), false);
      const cred = await credentials.read('xai');
      assert.equal(cred.type, 'oauth');
      assert.equal(cred.access, access);
    }, {
      env: { GROK_HOME: home },
      extraProviders: [fakeOAuthProvider({ id: 'xai', name: 'Grok', models: ['grok-3'] })],
    });
  } finally {
    await removeTempDir(home);
  }
});

