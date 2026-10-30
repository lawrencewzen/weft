import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from '../../src/core/model-sources.mjs';
import {
  CUSTOM_PROVIDER_ID,
  migrateSettingsV2toV3,
  normalizeProvidersV3,
  SETTINGS_VERSION_V3,
} from '../../src/core/provider-config.mjs';

const CUSTOM_ID = /^custom-[0-9a-f]{8}$/;

function apiSource(overrides = {}) {
  return {
    id: 'src1',
    kind: 'api',
    vendor: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-openai',
    models: ['gpt-4o'],
    ...overrides,
  };
}

test('migrate maps each builtin vendor and keeps extra settings fields', () => {
  const lastTest = { ok: true, at: '2026-01-01T00:00:00.000Z' };
  const gitConnections = [{ id: 'g1', kind: 'gitlab', name: 'lab' }];
  const { settings, credentials, idMap } = migrateSettingsV2toV3({
    version: 2,
    language: 'en',
    theme: 'claude',
    appearance: 'dark',
    plugins: { echo: true },
    skills: { foo: false },
    gitConnections,
    leftover: 'keep-me',
    sources: [
      apiSource({
        id: 'ds',
        vendor: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-ds',
        models: ['deepseek-chat'],
        contextWindows: { 'deepseek-chat': 64000 },
        lastTest,
      }),
      apiSource({
        id: 'oai',
        vendor: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1/',
        apiKey: 'sk-oai',
        models: ['gpt-4o'],
      }),
      apiSource({
        id: 'ant',
        vendor: 'anthropic',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant',
        models: ['claude-opus-4-7'],
      }),
      apiSource({
        id: 'gem',
        vendor: 'gemini',
        name: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: 'sk-gem',
        models: ['gemini-2.5-pro'],
      }),
      apiSource({
        id: 'kimi',
        vendor: 'moonshot',
        name: 'Kimi',
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKey: 'sk-kimi',
        models: ['kimi-k2'],
      }),
      apiSource({
        id: 'or',
        vendor: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or',
        models: ['openrouter/auto'],
      }),
    ],
    models: { default: { sourceId: 'gem', model: 'gemini-2.5-pro' } },
  });

  assert.equal(settings.version, SETTINGS_VERSION_V3);
  assert.equal(settings.language, 'en');
  assert.equal(settings.theme, 'claude');
  assert.equal(settings.appearance, 'dark');
  assert.deepEqual(settings.plugins, { echo: true });
  assert.deepEqual(settings.skills, { foo: false });
  assert.deepEqual(settings.gitConnections, gitConnections);
  assert.equal(settings.leftover, 'keep-me');
  assert.equal('sources' in settings, false);
  assert.equal('models' in settings, false);
  assert.equal('apiKey' in settings, false);

  assert.deepEqual(idMap, {
    ds: 'deepseek',
    oai: 'openai',
    ant: 'anthropic',
    gem: 'google',
    kimi: 'moonshotai-cn',
    or: 'openrouter',
  });

  const byId = Object.fromEntries(settings.providers.map((row) => [row.id, row]));
  assert.equal(byId.deepseek.kind, 'builtin');
  assert.deepEqual(byId.deepseek.enabled, ['deepseek-chat']);
  assert.deepEqual(byId.deepseek.overrides, { 'deepseek-chat': { contextWindow: 64000 } });
  assert.deepEqual(byId.deepseek.lastTest, lastTest);
  assert.equal('name' in byId.deepseek, false);
  assert.equal('baseUrl' in byId.deepseek, false);
  assert.equal('api' in byId.deepseek, false);
  assert.equal(byId.google.kind, 'builtin');
  assert.equal(byId['moonshotai-cn'].kind, 'builtin');

  assert.deepEqual(settings.defaultModel, { providerId: 'google', modelId: 'gemini-2.5-pro' });
  assert.deepEqual(
    credentials.map((row) => row.providerId).sort(),
    ['anthropic', 'deepseek', 'google', 'moonshotai-cn', 'openai', 'openrouter'],
  );
  assert.equal(credentials.find((row) => row.providerId === 'deepseek').credential.type, 'api_key');
  assert.equal(credentials.find((row) => row.providerId === 'deepseek').credential.key, 'sk-ds');
});

test('migrate drops grok and xai sources and nulls a default that pointed at them', () => {
  const { settings, credentials, idMap } = migrateSettingsV2toV3({
    version: 2,
    sources: [
      {
        id: 'grok',
        kind: 'grok',
        vendor: 'grok',
        name: 'Grok 订阅',
        baseUrl: '',
        apiKey: '',
        models: ['grok-build'],
      },
      apiSource({
        id: 'x1',
        vendor: 'xai',
        name: 'xAI',
        baseUrl: 'https://api.x.ai/v1',
        apiKey: 'sk-xai',
        models: ['grok-4'],
      }),
    ],
    models: { default: { sourceId: 'grok', model: 'grok-build' } },
  });
  assert.deepEqual(idMap, { grok: null, x1: null });
  assert.deepEqual(settings.providers, []);
  assert.equal(settings.defaultModel, null);
  assert.deepEqual(credentials, []);
});

test('migrate turns qwen, zhipu, ollama, custom, and off-preset URLs into custom providers', () => {
  const { settings, credentials, idMap } = migrateSettingsV2toV3({
    version: 2,
    sources: [
      apiSource({
        id: 'qw',
        vendor: 'qwen',
        name: '通义千问',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-qw',
        models: ['qwen-plus'],
      }),
      apiSource({
        id: 'zp',
        vendor: 'zhipu',
        name: '智谱',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'sk-zp',
        models: ['glm-4'],
      }),
      apiSource({
        id: 'ol',
        vendor: 'ollama',
        name: '本地 Ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: '',
        models: ['llama3'],
      }),
      apiSource({
        id: 'cu',
        vendor: 'custom',
        name: 'My proxy',
        baseUrl: 'https://proxy.example/v1',
        apiKey: 'sk-cu',
        models: ['local-model'],
      }),
      apiSource({
        id: 'off',
        vendor: 'openai',
        name: 'Local OpenAI',
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: 'sk-off',
        models: ['gpt-4o'],
      }),
    ],
    models: { default: { sourceId: 'zp', model: 'glm-4' } },
  });

  assert.match(idMap.qw, CUSTOM_ID);
  assert.match(idMap.zp, CUSTOM_ID);
  assert.match(idMap.ol, CUSTOM_ID);
  assert.match(idMap.cu, CUSTOM_ID);
  assert.match(idMap.off, CUSTOM_ID);
  assert.equal(new Set(Object.values(idMap)).size, 5);

  const byOld = Object.fromEntries(settings.providers.map((row) => [row.id, row]));
  for (const id of Object.values(idMap)) {
    assert.equal(byOld[id].kind, 'custom');
    assert.equal(byOld[id].api, 'openai-completions');
  }
  assert.equal(byOld[idMap.zp].name, '智谱');
  assert.equal(byOld[idMap.zp].baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(byOld[idMap.ol].baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(byOld[idMap.off].baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(settings.defaultModel.providerId, idMap.zp);
  assert.equal(settings.defaultModel.modelId, 'glm-4');
  assert.equal(credentials.length, 4);
  assert.equal(credentials.some((row) => row.providerId === idMap.ol), false);
});

test('two DeepSeek sources: first builtin, rest custom, idMap points at both', () => {
  const { settings, credentials, idMap } = migrateSettingsV2toV3({
    version: 2,
    sources: [
      apiSource({
        id: 'ds-a',
        vendor: 'deepseek',
        name: 'DeepSeek A',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-a',
        models: ['deepseek-chat'],
      }),
      apiSource({
        id: 'ds-b',
        vendor: 'deepseek',
        name: 'DeepSeek B',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-b',
        models: ['deepseek-reasoner'],
      }),
    ],
    models: { default: { sourceId: 'ds-b', model: 'deepseek-reasoner' } },
  });

  assert.equal(idMap['ds-a'], 'deepseek');
  assert.match(idMap['ds-b'], CUSTOM_ID);
  assert.equal(settings.providers[0].id, 'deepseek');
  assert.equal(settings.providers[0].kind, 'builtin');
  assert.deepEqual(settings.providers[0].enabled, ['deepseek-chat']);
  assert.equal(settings.providers[1].kind, 'custom');
  assert.equal(settings.providers[1].id, idMap['ds-b']);
  assert.equal(settings.providers[1].name, 'DeepSeek B');
  assert.equal(settings.providers[1].baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(settings.providers[1].api, 'openai-completions');
  assert.deepEqual(settings.providers[1].enabled, ['deepseek-reasoner']);
  assert.deepEqual(settings.defaultModel, { providerId: idMap['ds-b'], modelId: 'deepseek-reasoner' });
  assert.equal(credentials.length, 2);
  assert.equal(credentials[0].providerId, 'deepseek');
  assert.equal(credentials[0].credential.key, 'sk-a');
  assert.equal(credentials[1].providerId, idMap['ds-b']);
  assert.equal(credentials[1].credential.key, 'sk-b');
});

test('v2 with no models.default keeps defaultModel null', () => {
  const { settings, idMap } = migrateSettingsV2toV3({
    version: 2,
    sources: [
      apiSource({
        id: 'ds',
        vendor: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-ds',
        models: ['deepseek-flash', 'deepseek-chat'],
      }),
    ],
    models: {},
  });
  assert.equal(idMap.ds, 'deepseek');
  assert.deepEqual(settings.providers[0].enabled, ['deepseek-flash', 'deepseek-chat']);
  assert.equal(settings.defaultModel, null);
});

test('defaultModel is null when the mapped source was discarded', () => {
  const { settings } = migrateSettingsV2toV3({
    version: 2,
    sources: [
      apiSource({ id: 'ok', vendor: 'openai' }),
      apiSource({ id: 'x1', vendor: 'xai', baseUrl: 'https://api.x.ai/v1', apiKey: 'sk-x' }),
    ],
    models: { default: { sourceId: 'x1', model: 'grok-4' } },
  });
  assert.equal(settings.defaultModel, null);
});

test('already-v3 input is returned as-is', () => {
  const v3 = {
    version: 3,
    providers: [{ id: 'openai', kind: 'builtin', enabled: ['gpt-4o'], overrides: {} }],
    defaultModel: { providerId: 'openai', modelId: 'gpt-4o' },
    language: 'zh',
  };
  const once = migrateSettingsV2toV3(v3);
  assert.equal(once.settings, v3);
  assert.deepEqual(once.credentials, []);
  assert.deepEqual(once.idMap, {});
  const twice = migrateSettingsV2toV3(once.settings);
  assert.equal(twice.settings, v3);
  assert.equal(twice.settings.version, 3);
});

test('normalizeProvidersV3 drops illegal items and duplicate ids', () => {
  const custom = 'custom-deadbeef';
  assert.match(custom, CUSTOM_PROVIDER_ID);
  const lastTest = { ok: false, at: '2026-02-02T00:00:00.000Z', error: 'nope' };
  const out = normalizeProvidersV3([
    null,
    'nope',
    { id: 'not-a-provider', kind: 'builtin', enabled: ['x'] },
    { id: 'openai', kind: 'weird', enabled: ['gpt-4o'] },
    {
      id: 'openai',
      kind: 'builtin',
      name: 'strip me',
      baseUrl: 'https://example.invalid',
      api: 'openai-completions',
      enabled: ['gpt-4o', 'gpt-4o', '', 1],
      overrides: {
        'gpt-4o': { contextWindow: 128000, maxTokens: 32000 },
        bad: { contextWindow: 1 },
        also: { maxTokens: CONTEXT_WINDOW_MAX + 1 },
        ok: { maxTokens: CONTEXT_WINDOW_MIN },
      },
      lastTest,
    },
    { id: 'openai', kind: 'builtin', enabled: ['dup'] },
    { id: 'custom-nope', kind: 'custom', api: 'openai-completions', enabled: [] },
    {
      id: custom,
      kind: 'custom',
      name: '  Proxy  ',
      baseUrl: 'https://proxy.example/v1/',
      api: 'openai-responses',
      enabled: ['local'],
    },
    { id: custom, kind: 'custom', api: 'openai-completions', enabled: ['dup'] },
    { id: 'custom-abcdef01', kind: 'custom', api: 'not-an-api', enabled: ['x'] },
  ]);

  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    id: 'openai',
    kind: 'builtin',
    name: 'strip me',
    enabled: ['gpt-4o'],
    overrides: {
      'gpt-4o': { contextWindow: 128000, maxTokens: 32000 },
      ok: { maxTokens: CONTEXT_WINDOW_MIN },
    },
    lastTest,
  });
  assert.deepEqual(out[1], {
    id: custom,
    kind: 'custom',
    name: 'Proxy',
    baseUrl: 'https://proxy.example/v1',
    api: 'openai-responses',
    enabled: ['local'],
    overrides: {},
  });
});
