import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore, createModelsStore } from '../../src/core/provider-stores.mjs';
import { parseFetchedChatModels } from '../../src/kernel/models.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const TOKEN = 'v2-thinking-level-token';
const KEY = 'sk-thinking-level-secret-4444';

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function sendV2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      ...v2Headers(token),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

function assertChecked(apiPath, method, status, body) {
  const checked = validateResponse(apiPath.split('?')[0], method, status, body);
  assert.equal(checked.ok, true, `${method} ${apiPath} ${status}: ${JSON.stringify(checked.errors)}\n${JSON.stringify(body)}`);
}

async function seedDeepseek(dataDir) {
  const store = createSqliteStore(dataDir);
  await store.replaceSettings({
    version: 3,
    providers: [{
      id: 'deepseek',
      kind: 'builtin',
      enabled: ['deepseek-flash', 'deepseek-v4-pro'],
      overrides: {},
    }],
    defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
  });
  const credentials = createCredentialStore(store);
  await credentials.modify('deepseek', async () => ({ type: 'api_key', key: KEY }));
  store.close();
}

test('providers list thinkingLevels and defaultThinkingLevel for catalog models', async () => {
  const dataDir = await makeTempDir('weft-v2-think-prov-');
  await seedDeepseek(dataDir);
  const srv = await startServer({ token: TOKEN, dataDir, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(dataDir);
    const listed = await sendV2(srv.base, 'GET', '/api/v2/providers', discovery.token);
    assert.equal(listed.status, 200, listed.text);
    assertChecked('/api/v2/providers', 'GET', 200, listed.body);
    const ds = listed.body.providers.find((item) => item.id === 'deepseek');
    const flash = ds.models.find((item) => item.id === 'deepseek-flash');
    const pro = ds.models.find((item) => item.id === 'deepseek-v4-pro');
    assert.deepEqual(flash.thinkingLevels, ['off', 'low', 'high', 'max']);
    assert.equal(flash.defaultThinkingLevel, 'high');
    assert.deepEqual(pro.thinkingLevels, ['off', 'high', 'max']);
    assert.equal(pro.defaultThinkingLevel, 'high');
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});

test('PATCH thinkingLevel: legal, illegal, clamp, null, and clamp after model switch', { timeout: 40_000 }, async () => {
  const dataDir = await makeTempDir('weft-v2-think-patch-');
  await seedDeepseek(dataDir);
  const srv = await startServer({ token: TOKEN, dataDir, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'think' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 't' }, TOKEN);
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    const id = conv.body.id;

    const snap = await sendV2(srv.base, 'GET', `/api/v2/conversations/${id}`, discovery.token);
    assert.equal(snap.status, 200, snap.text);
    assertChecked(`/api/v2/conversations/${id}`, 'GET', 200, snap.body);
    assert.equal(snap.body.conversation.thinkingLevel, 'high');
    assert.equal(snap.body.conversation.model.modelId, 'deepseek-flash');

    const high = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${id}`, discovery.token, {
      thinkingLevel: 'high',
    });
    assert.equal(high.status, 200, high.text);
    assertChecked(`/api/v2/conversations/${id}`, 'PATCH', 200, high.body);
    assert.equal(high.body.thinkingLevel, 'high');
    assert.equal(high.headers.get('weft-protocol'), PROTOCOL_VERSION);

    const medium = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${id}`, discovery.token, {
      thinkingLevel: 'medium',
    });
    assert.equal(medium.status, 200, medium.text);
    assert.equal(medium.body.thinkingLevel, 'high');

    const bad = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${id}`, discovery.token, {
      thinkingLevel: 'nope',
    });
    assert.equal(bad.status, 400, bad.text);
    assertChecked(`/api/v2/conversations/${id}`, 'PATCH', 400, bad.body);
    assert.equal(bad.body.error, 'invalid thinkingLevel');

    const empty = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${id}`, discovery.token, {});
    assert.equal(empty.status, 400, empty.text);

    const low = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${id}`, discovery.token, {
      thinkingLevel: 'low',
    });
    assert.equal(low.status, 200, low.text);
    assert.equal(low.body.thinkingLevel, 'low');

    const switched = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${id}`, discovery.token, {
      model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
    });
    assert.equal(switched.status, 200, switched.text);
    assert.equal(switched.body.model.modelId, 'deepseek-v4-pro');
    assert.equal(switched.body.thinkingLevel, 'high');

    const cleared = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${id}`, discovery.token, {
      thinkingLevel: null,
    });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.body.thinkingLevel, 'high');
    assert.equal(cleared.body.model.modelId, 'deepseek-v4-pro');
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});

test('custom provider models: effort.supported_levels vs none', async () => {
  const dataDir = await makeTempDir('weft-v2-think-custom-');
  const store = createSqliteStore(dataDir);
  const customId = 'custom-aaaaaaaa';
  await store.replaceSettings({
    version: 3,
    providers: [{
      id: customId,
      kind: 'custom',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      enabled: ['thinker', 'plain'],
      overrides: {},
    }],
    defaultModel: { providerId: customId, modelId: 'thinker' },
  });
  const modelsStore = createModelsStore(store);
  await modelsStore.write(customId, {
    models: parseFetchedChatModels({
      data: [
        { id: 'thinker', effort: { supported_levels: ['low', 'high', 'max'] } },
        { id: 'plain' },
      ],
    }, { providerId: customId, api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1' }),
  });
  store.close();
  const srv = await startServer({ token: TOKEN, dataDir, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(dataDir);
    const listed = await sendV2(srv.base, 'GET', '/api/v2/providers', discovery.token);
    assert.equal(listed.status, 200, listed.text);
    assertChecked('/api/v2/providers', 'GET', 200, listed.body);
    const custom = listed.body.providers.find((item) => item.id === customId);
    const thinker = custom.models.find((item) => item.id === 'thinker');
    const plain = custom.models.find((item) => item.id === 'plain');
    assert.deepEqual(thinker.thinkingLevels, ['off', 'low', 'high', 'max']);
    assert.equal(thinker.defaultThinkingLevel, 'high');
    assert.deepEqual(plain.thinkingLevels, []);
    assert.equal(plain.defaultThinkingLevel, null);
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});
