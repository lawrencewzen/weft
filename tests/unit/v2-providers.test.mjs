import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROK_SOURCE_ID } from '../../src/core/model-sources.mjs';
import { validateResponse } from '../../src/v2/validate.ts';
import {
  accessForVendor,
  defaultModelView,
  grokSessionView,
  lastTestFrom,
  probeResultView,
  providerAccess,
  providerStatusFromReason,
  providerView,
  providersSnapshot,
  sourceBlockReason,
  vendorViews,
} from '../../src/v2/views/providers.ts';

function source(partial) {
  return {
    id: 'abcd1234',
    kind: 'api',
    vendor: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-secret-key-value',
    models: ['gpt-4o'],
    ...partial,
  };
}

test('access: Grok is account, ollama local, custom custom_endpoint, others api_key', () => {
  assert.equal(providerAccess({ id: GROK_SOURCE_ID, kind: 'grok', vendor: 'grok' }), 'account');
  assert.equal(providerAccess({ id: 'a', kind: 'api', vendor: 'ollama' }), 'local');
  assert.equal(providerAccess({ id: 'a', kind: 'api', vendor: 'custom' }), 'custom_endpoint');
  assert.equal(providerAccess({ id: 'a', kind: 'api', vendor: 'openai' }), 'api_key');
  assert.equal(providerAccess({ id: 'a', kind: 'api', vendor: 'deepseek' }), 'api_key');
  assert.equal(accessForVendor('ollama'), 'local');
  assert.equal(accessForVendor('custom'), 'custom_endpoint');
  assert.equal(accessForVendor('xai'), 'api_key');
});

test('vendorViews lists 11 presets with brand ids and never includes agent access', () => {
  const vendors = vendorViews();
  assert.equal(vendors.length, 11);
  assert.deepEqual(vendors.map((item) => item.id), [
    'deepseek', 'xai', 'openai', 'anthropic', 'gemini', 'qwen', 'moonshot', 'zhipu', 'openrouter', 'ollama', 'custom',
  ]);
  assert.equal(vendors.find((item) => item.id === 'ollama').access, 'local');
  assert.equal(vendors.find((item) => item.id === 'custom').access, 'custom_endpoint');
  assert.equal(vendors.find((item) => item.id === 'custom').brand, null);
  assert.equal(vendors.find((item) => item.id === 'openai').brand, 'OpenAI');
  assert.equal(vendors.find((item) => item.id === 'ollama').needsKey, false);
  assert.equal(vendors.find((item) => item.id === 'openai').needsKey, true);
  assert.equal(vendors.every((item) => item.access !== 'agent'), true);
});

test('providerView masks the key, sets brand, and maps status + zh/en statusText', () => {
  const ok = providerView(source({ lastTest: { ok: true, at: '2026-01-01T00:00:00.000Z' } }), {
    lang: 'zh',
    grokSignedIn: false,
    defaultProviderId: 'abcd1234',
  });
  assert.equal(ok.access, 'api_key');
  assert.equal(ok.runtime, 'model');
  assert.equal(ok.vendor, 'OpenAI');
  assert.equal(ok.hasKey, true);
  assert.equal(ok.keyMasked, '••••alue');
  assert.equal(JSON.stringify(ok).includes('sk-secret-key-value'), false);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.statusText, '');
  assert.equal(ok.isDefault, true);
  assert.equal(ok.lastTestedAt, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(ok.models[0].id, 'gpt-4o');
  assert.equal(ok.models[0].brand, 'OpenAI');
  assert.equal(ok.models[0].contextWindowCustom, false);
  assert.equal(typeof ok.models[0].images, 'boolean');

  const noKey = providerView(source({ apiKey: '' }), { lang: 'zh' });
  assert.equal(sourceBlockReason(source({ apiKey: '' })), 'no_key');
  assert.equal(noKey.status, 'needs_auth');
  assert.equal(noKey.statusText, '缺 Key');
  assert.equal(noKey.keyMasked, null);
  assert.equal(noKey.hasKey, false);
  const noKeyEn = providerView(source({ apiKey: '' }), { lang: 'en' });
  assert.equal(noKeyEn.statusText, 'Missing key');

  const grok = providerView({
    id: GROK_SOURCE_ID,
    kind: 'grok',
    vendor: 'grok',
    name: 'Grok 订阅',
    baseUrl: '',
    apiKey: '',
    models: ['grok-build'],
  }, { lang: 'zh', grokSignedIn: false });
  assert.equal(grok.access, 'account');
  assert.equal(grok.vendor, 'Grok');
  assert.equal(grok.status, 'needs_auth');
  assert.equal(grok.statusText, '未登录');
  const grokEn = providerView({
    id: GROK_SOURCE_ID, kind: 'grok', vendor: 'grok', name: 'Grok', baseUrl: '', apiKey: '', models: ['grok-build'],
  }, { lang: 'en', grokSignedIn: false });
  assert.equal(grokEn.statusText, 'Not signed in');

  const grokIn = providerView({
    id: GROK_SOURCE_ID, kind: 'grok', vendor: 'grok', name: 'Grok', baseUrl: '', apiKey: '', models: ['grok-build'],
  }, { lang: 'zh', grokSignedIn: true });
  assert.equal(grokIn.status, 'untested');
  assert.equal(grokIn.statusText, '');

  const offline = providerView(source({
    lastTest: { ok: false, at: '2026-01-01T00:00:00.000Z', error: 'fetch failed', code: 'network' },
  }), { lang: 'zh' });
  assert.equal(offline.status, 'unreachable');
  assert.equal(offline.statusText, '连不上');
  const ollamaNet = providerView(source({
    vendor: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    lastTest: { ok: false, at: '2026-01-01T00:00:00.000Z', error: 'fetch failed', code: 'network' },
  }), { lang: 'zh' });
  assert.equal(ollamaNet.access, 'local');
  assert.equal(ollamaNet.status, 'unreachable');
  assert.equal(ollamaNet.statusText, 'Ollama 没启动');
  const ollamaEn = providerView(source({
    vendor: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '',
    lastTest: { ok: false, at: '2026-01-01T00:00:00.000Z', error: 'fetch failed', code: 'network' },
  }), { lang: 'en' });
  assert.equal(ollamaEn.statusText, 'Ollama is not running');

  const authFail = providerView(source({
    lastTest: { ok: false, at: '2026-01-01T00:00:00.000Z', error: 'HTTP 401', code: 'auth', status: 401 },
  }), { lang: 'en' });
  assert.equal(authFail.status, 'needs_auth');
  assert.equal(authFail.statusText, 'Authentication failed');

  assert.equal(providerStatusFromReason(source(), ''), 'untested');
});

test('contextWindowCustom is true only for user overrides', () => {
  const view = providerView(source({
    models: ['gpt-4o', 'other'],
    contextWindows: { 'gpt-4o': 256000 },
  }), { lang: 'zh' });
  const gpt = view.models.find((item) => item.id === 'gpt-4o');
  const other = view.models.find((item) => item.id === 'other');
  assert.equal(gpt.contextWindow, 256000);
  assert.equal(gpt.contextWindowCustom, true);
  assert.equal(other.contextWindowCustom, false);
});

test('providersSnapshot defaultModel follows settings.models.default then first usable source', () => {
  const settings = {
    sources: [source({ id: 'aaaa1111', models: ['gpt-4o'] })],
    models: { default: { sourceId: 'aaaa1111', model: 'gpt-4o' } },
  };
  const snap = providersSnapshot({ settings, grokSignedIn: false, lang: 'zh' });
  assert.deepEqual(snap.defaultModel, { providerId: 'aaaa1111', modelId: 'gpt-4o' });
  assert.equal(snap.providers[0].isDefault, true);
  const checked = validateResponse('/api/v2/providers', 'GET', 200, snap);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));

  assert.deepEqual(defaultModelView({ sources: [], models: {} }), null);
});

test('probeResultView and lastTestFrom never copy a raw key into the payload', () => {
  const secret = 'sk-live-secret-9999';
  const failure = lastTestFrom({ ok: false, error: `rejected ${secret}`, code: 'auth', status: 401 });
  assert.equal(JSON.stringify(failure).includes(secret), false);
  const view = probeResultView({ ok: false, error: 'HTTP 401', code: 'auth', status: 401 }, { lang: 'zh' });
  assert.equal(view.ok, false);
  assert.equal(view.status, 'needs_auth');
  assert.equal(view.models.length, 0);
  assert.equal(view.statusText.includes('鉴权失败'), true);
  const ok = probeResultView({ ok: true, models: ['a', 'b'] }, { lang: 'en' });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.models, ['a', 'b']);
});

test('grokSessionView converts ISO expiry to ms and drops secrets', () => {
  const session = grokSessionView({
    signedIn: true,
    account: 'ada@example.com',
    email: 'ada@example.com',
    expiresAt: '2099-01-01T00:00:00.000Z',
    authMode: 'oidc',
    source: 'grok-auth-json',
    pending: null,
    key: 'access-token-secret',
  });
  assert.equal(session.signedIn, true);
  assert.equal(session.expiresAt, Date.parse('2099-01-01T00:00:00.000Z'));
  assert.equal(session.pending, null);
  assert.equal(JSON.stringify(session).includes('access-token-secret'), false);
});
