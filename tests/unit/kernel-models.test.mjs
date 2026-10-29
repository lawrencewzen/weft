import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore, createModelsStore } from '../../src/core/provider-stores.mjs';
import {
  createKernelModels,
  explicitDemo,
  fetchCustomProviderModels,
  parseFetchedChatModels,
  selectChatRuntime,
} from '../../src/kernel/models.mjs';
import { startFakeModel } from './kernel-models-fake.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-models-token';
const KEY_DEFAULT = 'sk-default-secret-1111';
const KEY_DEFAULT_NEXT = 'sk-default-secret-3333';
const KEY_CODER = 'sk-coder-secret-2222';
const KEY_DS = 'sk-deepseek-secret-4444';
const SECRETS = [KEY_DEFAULT, KEY_DEFAULT_NEXT, KEY_CODER, KEY_DS];
const CUSTOM_DEFAULT = 'custom-aaaaaaaa';
const CUSTOM_CODER = 'custom-bbbbbbbb';

test('explicit demo is only the three switches', () => {
  assert.equal(explicitDemo({}), false);
  assert.equal(explicitDemo({ WEFT_LLM: 'faux' }), true);
  assert.equal(explicitDemo({ LLM_API: 'faux' }), true);
  assert.equal(explicitDemo({ WEFT_FAUX_SCRIPT: '/tmp/script.json' }), true);
  assert.equal(explicitDemo({ WEFT_LLM: 'openai' }), false);
  assert.equal(explicitDemo({ LLM_API_KEY: KEY_DEFAULT }), false);
  assert.equal(explicitDemo({ [`PI${'_'}WORK_LLM`]: 'faux' }), false);
  assert.equal(explicitDemo({ [`PI${'_'}WORK_FAUX_SCRIPT`]: '/tmp/script.json' }), false);
});

test('chat runtime uses a real model when one is connected, and faux only when asked', () => {
  assert.equal(selectChatRuntime('faux', { hasApiKey: true }), 'faux');
  assert.equal(selectChatRuntime('openai', { hasApiKey: false }), 'openai');
  assert.equal(selectChatRuntime(undefined, { hasApiKey: true }), 'openai');
  assert.equal(selectChatRuntime('', { hasBaseUrl: true }), 'openai');
  assert.equal(selectChatRuntime('', { llmApi: 'faux' }), 'faux');
  assert.equal(selectChatRuntime('', { fauxScript: true }), 'faux');
  assert.equal(selectChatRuntime('openai', { fauxScript: true, llmApi: 'faux' }), 'openai');
  assert.equal(selectChatRuntime('', {}), 'none');
  assert.equal(selectChatRuntime(undefined, {}), 'none');
  assert.equal(selectChatRuntime('', { llmApi: 'openai-completions' }), 'none');
});

function customProvider(id, { baseUrl, enabled, overrides = {}, name = id } = {}) {
  return {
    id,
    kind: 'custom',
    name,
    baseUrl,
    api: 'openai-completions',
    enabled,
    overrides,
  };
}

function v3Settings(providers, defaultModel) {
  return { version: 3, providers, defaultModel };
}

async function modelOf(settings, conv = {}, env = {}) {
  const models = createModels();
  const routes = createKernelModels({ models, getSettings: async () => settings, env });
  const ref = await routes.modelFor(conv);
  return { models, routes, ref, model: ref ? models.getModel(ref.provider, ref.modelId) : null };
}

test('modelFor uses the pinned enabled model, then defaultModel, otherwise null', async () => {
  const settings = v3Settings([
    customProvider(CUSTOM_DEFAULT, {
      baseUrl: 'http://127.0.0.1:4101/v1',
      enabled: ['model-default'],
    }),
    customProvider(CUSTOM_CODER, {
      baseUrl: 'http://127.0.0.1:4102/v1',
      enabled: ['model-coder'],
    }),
  ], { providerId: CUSTOM_DEFAULT, modelId: 'model-default' });
  const models = createModels();
  const routes = createKernelModels({ models, getSettings: async () => settings, env: {} });

  const main = await routes.modelFor({});
  const pinned = await routes.modelFor({ modelSourceId: CUSTOM_CODER, modelId: 'model-coder' });
  assert.equal(main.modelId, 'model-default');
  assert.equal(pinned.modelId, 'model-coder');
  assert.equal(main.provider, CUSTOM_DEFAULT);
  assert.equal(pinned.provider, CUSTOM_CODER);
  assert.equal(models.getModel(main.provider, main.modelId).baseUrl, 'http://127.0.0.1:4101/v1');

  const missing = await routes.modelFor({ modelSourceId: 'missing', modelId: 'ghost' });
  assert.equal(missing.modelId, 'model-default');

  const disabled = await routes.modelFor({
    modelSourceId: CUSTOM_CODER,
    modelId: 'not-enabled',
  });
  assert.equal(disabled.modelId, 'model-default');

  const empty = createKernelModels({
    models: createModels(),
    getSettings: async () => v3Settings([], null),
    env: {},
  });
  assert.equal(await empty.modelFor({}), null);
});

test('builtin catalog metadata is kept and user/env overrides apply', async () => {
  const base = v3Settings([
    { id: 'deepseek', kind: 'builtin', enabled: ['deepseek-flash'], overrides: {} },
  ], { providerId: 'deepseek', modelId: 'deepseek-flash' });

  const flash = (await modelOf(base, {}, { LLM_CONTEXT_WINDOW: '200000' })).model;
  assert.equal(flash.contextWindow, 1_000_000);
  assert.equal(flash.maxTokens, 384000);
  assert.equal(flash.reasoning, true);
  assert.equal(flash.thinkingLevelMap.low, 'low');
  assert.deepEqual(flash.input, ['text', 'image']);
  assert.equal(flash.cost.input, 0.3);
  assert.equal(flash.compat?.maxTokensField, 'max_tokens');
  assert.equal(flash.compat?.thinkingFormat, 'deepseek');

  const unknown = (await modelOf(v3Settings([
    customProvider(CUSTOM_DEFAULT, {
      baseUrl: 'http://127.0.0.1:4101/v1',
      enabled: ['not-a-real-model'],
    }),
  ], { providerId: CUSTOM_DEFAULT, modelId: 'not-a-real-model' }))).model;
  assert.equal(unknown.contextWindow, 128000);
  assert.equal(unknown.maxTokens, 32768);
  assert.equal(unknown.reasoning, Boolean(0));
  assert.deepEqual(unknown.input, ['text']);

  const userWindow = (await modelOf(v3Settings([
    {
      id: 'deepseek',
      kind: 'builtin',
      enabled: ['deepseek-flash'],
      overrides: { 'deepseek-flash': { contextWindow: 256000 } },
    },
  ], { providerId: 'deepseek', modelId: 'deepseek-flash' }))).model;
  assert.equal(userWindow.contextWindow, 256000);
  assert.equal(userWindow.maxTokens, 256000);
  assert.equal(userWindow.reasoning, true);

  const envMax = (await modelOf(base, {}, { WEFT_MAX_OUTPUT_TOKENS: '2048' })).model;
  assert.equal(envMax.contextWindow, 1_000_000);
  assert.equal(envMax.maxTokens, 2048);
});

function rewriteDeepseekFetch(fakeBaseUrl) {
  const fake = new URL(fakeBaseUrl);
  return async (input, init) => {
    const href = typeof input === 'string'
      ? input
      : (input instanceof URL ? input.href : (input && typeof input.url === 'string' ? input.url : ''));
    const url = new URL(href);
    if (url.hostname !== 'api.deepseek.com') return fetch(input, init);
    url.protocol = fake.protocol;
    url.host = fake.host;
    if (input instanceof Request) return fetch(new Request(url, input), init);
    return fetch(url, init);
  };
}

test('builtin DeepSeek request uses catalog reasoning and stored Authorization', async () => {
  const fake = await startFakeModel({ mode: 'openai', text: 'from-catalog' });
  const dir = await makeTempDir('weft-kmodels-ds-');
  const store = createSqliteStore(dir);
  const credentials = createCredentialStore(store);
  try {
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: KEY_DS }));
    const models = createModels({ credentials });
    const settings = v3Settings([
      { id: 'deepseek', kind: 'builtin', enabled: ['deepseek-flash'], overrides: {} },
    ], { providerId: 'deepseek', modelId: 'deepseek-flash' });
    const routes = createKernelModels({ models, getSettings: async () => settings, env: {} });
    const ref = await routes.modelFor({});
    const model = models.getModel(ref.provider, ref.modelId);
    assert.equal(ref.provider, 'deepseek');
    assert.equal(model.reasoning, true);

    const stream = models.streamSimple(model, {
      messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
    }, { fetch: rewriteDeepseekFetch(fake.baseUrl), maxRetries: 0 });
    await stream.result();

    const hit = fake.seen.find((item) => item.path.endsWith('/chat/completions'));
    assert.ok(hit, JSON.stringify(fake.seen));
    assert.equal(hit.authorization, `Bearer ${KEY_DS}`);
    assert.equal(hit.body.model, 'deepseek-flash');
    assert.equal(hit.body.max_tokens, 384000);
    assert.deepEqual(hit.body.thinking, { type: 'disabled' });
    assert.equal(Object.prototype.hasOwnProperty.call(hit.body, 'reasoning'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(hit.body, 'reasoning_effort'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(hit.body, 'enable_thinking'), false);
  } finally {
    store.close();
    await fake.close();
    await removeTempDir(dir);
  }
});

test('custom OpenAI-compatible provider sends to baseUrl with Authorization', async () => {
  const fake = await startFakeModel({ mode: 'openai', text: 'from-custom' });
  const dir = await makeTempDir('weft-kmodels-custom-');
  const store = createSqliteStore(dir);
  const credentials = createCredentialStore(store);
  try {
    await credentials.modify(CUSTOM_DEFAULT, async () => ({ type: 'api_key', key: KEY_DEFAULT }));
    const models = createModels({ credentials });
    const settings = v3Settings([
      customProvider(CUSTOM_DEFAULT, {
        baseUrl: fake.baseUrl,
        enabled: ['model-default'],
        overrides: { 'model-default': { contextWindow: 256000 } },
      }),
    ], { providerId: CUSTOM_DEFAULT, modelId: 'model-default' });
    const routes = createKernelModels({ models, getSettings: async () => settings, env: {} });
    const ref = await routes.modelFor({});
    const model = models.getModel(ref.provider, ref.modelId);
    assert.equal(model.contextWindow, 256000);
    const stream = models.streamSimple(model, {
      messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
    }, { maxRetries: 0 });
    await stream.result();
    const hit = fake.seen.find((item) => item.path.endsWith('/chat/completions'));
    assert.ok(hit, JSON.stringify(fake.seen));
    assert.equal(hit.authorization, `Bearer ${KEY_DEFAULT}`);
    assert.equal(hit.body.model, 'model-default');
  } finally {
    store.close();
    await fake.close();
    await removeTempDir(dir);
  }
});

test('parseFetchedChatModels reads each documented field name', () => {
  const meta = { providerId: CUSTOM_DEFAULT, api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1' };
  const cases = [
    ['context_window', { id: 'a', context_window: 1111 }],
    ['context_length', { id: 'a', context_length: 2222 }],
    ['max_context_length', { id: 'a', max_context_length: 3333 }],
    ['max_model_len', { id: 'a', max_model_len: 4444 }],
    ['top_provider.context_length', { id: 'a', top_provider: { context_length: 5555 } }],
  ];
  for (const [label, item] of cases) {
    const [model] = parseFetchedChatModels({ data: [item] }, meta);
    assert.ok(model.contextWindow > 0, label);
  }
  assert.equal(parseFetchedChatModels({ data: [{ id: 'n', name: 'Named' }] }, meta)[0].name, 'Named');
  assert.equal(parseFetchedChatModels({ data: [{ id: 'n', display_name: 'Shown' }] }, meta)[0].name, 'Shown');
  assert.equal(parseFetchedChatModels({ data: [{ id: 'n' }] }, meta)[0].name, 'n');
  assert.equal(parseFetchedChatModels({ data: [{ id: 'n', max_output_tokens: 11 }] }, meta)[0].maxTokens, 11);
  assert.equal(parseFetchedChatModels({ data: [{ id: 'n', max_completion_tokens: 22 }] }, meta)[0].maxTokens, 22);
  assert.equal(parseFetchedChatModels({
    data: [{ id: 'n', top_provider: { max_completion_tokens: 33 } }],
  }, meta)[0].maxTokens, 33);
  assert.deepEqual(parseFetchedChatModels({
    data: [{ id: 'n', input_modalities: ['image'] }],
  }, meta)[0].input, ['text', 'image']);
  assert.deepEqual(parseFetchedChatModels({
    data: [{ id: 'n', architecture: { input_modalities: ['image'] } }],
  }, meta)[0].input, ['text', 'image']);
  assert.equal(parseFetchedChatModels({ data: [{ id: 'n', effort: 'high' }] }, meta)[0].reasoning, true);
  assert.equal(parseFetchedChatModels({ data: [{ id: 'n', reasoning: { effort: 'low' } }] }, meta)[0].reasoning, true);
  assert.equal(parseFetchedChatModels({ data: [{ id: 'n' }] }, meta)[0].reasoning, Boolean(0));
});

test('fetchModels omits Authorization without a key and persists through ModelsStore', async () => {
  const fake = await startFakeModel({
    models: { data: [{ id: 'cached', name: 'Cached', context_window: 8000 }] },
  });
  const dir = await makeTempDir('weft-kmodels-fetch-');
  const store = createSqliteStore(dir);
  const credentials = createCredentialStore(store);
  const modelsStore = createModelsStore(store);
  try {
    const none = await fetchCustomProviderModels({ signal: AbortSignal.timeout(2_000) }, {
      id: CUSTOM_DEFAULT,
      api: 'openai-completions',
      baseUrl: fake.baseUrl,
    });
    assert.equal(none[0].id, 'cached');
    const listHit = fake.seen.find((item) => item.path.endsWith('/models'));
    assert.equal(listHit.authorization, '');

    await credentials.modify(CUSTOM_DEFAULT, async () => ({ type: 'api_key', key: KEY_DEFAULT }));
    const settings = v3Settings([
      customProvider(CUSTOM_DEFAULT, { baseUrl: fake.baseUrl, enabled: ['cached'] }),
    ], { providerId: CUSTOM_DEFAULT, modelId: 'cached' });
    const first = createModels({ credentials, modelsStore });
    const routes = createKernelModels({
      models: first,
      getSettings: async () => settings,
      env: {},
      fetchImpl: globalThis.fetch,
    });
    await routes.modelFor({});
    await first.refresh({ providers: [CUSTOM_DEFAULT], allowNetwork: true });
    const stored = await modelsStore.read(CUSTOM_DEFAULT);
    assert.equal(stored.models.some((item) => item.id === 'cached'), true);

    const blocked = async () => {
      throw new Error('network should not be used');
    };
    const second = createModels({ credentials, modelsStore });
    const again = createKernelModels({
      models: second,
      getSettings: async () => settings,
      env: {},
      fetchImpl: blocked,
    });
    const ref = await again.modelFor({});
    const model = second.getModel(ref.provider, ref.modelId);
    assert.equal(model.id, 'cached');
    assert.equal(model.name, 'Cached');
    assert.equal(model.contextWindow, 8000);
  } finally {
    store.close();
    await fake.close();
    await removeTempDir(dir);
  }
});

function scrub(text) {
  let out = String(text ?? '');
  for (const secret of SECRETS) {
    if (secret) out = out.split(secret).join(`***${secret.slice(-4)}`);
  }
  return out;
}

function assertClean(text, label) {
  const raw = String(text ?? '');
  for (const secret of SECRETS) {
    if (secret && raw.includes(secret)) throw new Error(`${label} contained a raw key or token`);
  }
}

async function request(base, method, apiPath, body) {
  const res = await serverRequest(base, method, apiPath, body, TOKEN);
  assertClean(res.text, `${method} ${apiPath}`);
  return res;
}

async function waitTurn(base, cid, pred, attempts = 80) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    last = got.body;
    if (pred(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

function assistantTexts(body) {
  return (body?.messages || []).filter((message) => message.role === 'assistant').map((message) => message.text);
}

test('kernel models call each custom provider and hide keys', { timeout: 60000 }, async () => {
  const dataDir = await makeTempDir('weft-kmodels-http-');
  const defaultFake = await startFakeModel({ mode: 'openai', text: 'from-default' });
  const coderFake = await startFakeModel({ mode: 'openai', text: 'from-coder' });
  const seed = createSqliteStore(dataDir);
  const credentials = createCredentialStore(seed);
  await seed.replaceSettings(v3Settings([
    customProvider(CUSTOM_DEFAULT, {
      name: 'Default',
      baseUrl: defaultFake.baseUrl,
      enabled: ['model-default'],
    }),
    customProvider(CUSTOM_CODER, {
      name: 'Coder',
      baseUrl: coderFake.baseUrl,
      enabled: ['model-coder'],
    }),
  ], { providerId: CUSTOM_DEFAULT, modelId: 'model-default' }));
  await credentials.modify(CUSTOM_DEFAULT, async () => ({ type: 'api_key', key: KEY_DEFAULT }));
  await credentials.modify(CUSTOM_CODER, async () => ({ type: 'api_key', key: KEY_CODER }));
  seed.close();

  let srv = null;
  try {
    srv = await startServer({ dataDir, token: TOKEN, formatLog: scrub });
    const { base } = srv;
    const settings = await request(base, 'GET', '/api/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.version, 3);
    assert.equal(JSON.stringify(settings.body).includes(KEY_DEFAULT), false);

    const ws = await request(base, 'POST', '/api/workspaces', { name: 'kernel-models' });
    assert.equal(ws.status, 201);
    const mainConv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'default-model' });
    assert.equal(mainConv.status, 201);
    const coderConv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'coder-pinned',
      modelSourceId: CUSTOM_CODER,
      modelId: 'model-coder',
    });
    assert.equal(coderConv.status, 201);

    const sentMain = await request(base, 'POST', `/api/conversations/${mainConv.body.id}/messages`, { text: 'ping-default' });
    assert.equal(sentMain.status, 202);
    const mainDone = await waitTurn(base, mainConv.body.id, (body) => assistantTexts(body).includes('from-default'));
    assert.equal(mainDone.status, 'done');
    assert.deepEqual(defaultFake.seen.filter((hit) => hit.path.endsWith('/chat/completions')).map((hit) => hit.keyTail), [KEY_DEFAULT.slice(-4)]);
    assert.equal(coderFake.seen.filter((hit) => hit.path.endsWith('/chat/completions')).length, 0);

    const sentCoder = await request(base, 'POST', `/api/conversations/${coderConv.body.id}/messages`, { text: 'ping-coder' });
    assert.equal(sentCoder.status, 202);
    const coderDone = await waitTurn(base, coderConv.body.id, (body) => assistantTexts(body).includes('from-coder'));
    assert.equal(coderDone.status, 'done');
    assert.deepEqual(coderFake.seen.filter((hit) => hit.path.endsWith('/chat/completions')).map((hit) => hit.keyTail), [KEY_CODER.slice(-4)]);
    assertClean(srv.logs(), 'server log');
  } finally {
    await stopServer(srv);
    await defaultFake.close();
    await coderFake.close();
    await removeTempDir(dataDir);
  }
});
