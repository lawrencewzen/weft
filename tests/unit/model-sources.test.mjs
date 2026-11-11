import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';

const sources = await load('src/core/model-sources.mjs');
const settings = await load('src/core/settings.mjs');

const {
  vendorPreset,
  vendorForBaseUrl,
  normalizeHttpUrl,
  isValidContextWindow,
  VENDOR_PRESETS,
  CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_MAX,
} = sources;

test('vendor presets and URL helpers stay available for v3 migration', () => {
  assert.equal(vendorPreset('deepseek').baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(vendorPreset('zhipu').name, '智谱');
  assert.equal(normalizeHttpUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(vendorForBaseUrl('https://api.deepseek.com/v1/').id, 'deepseek');
  assert.equal(isValidContextWindow(CONTEXT_WINDOW_MIN), true);
  assert.equal(isValidContextWindow(CONTEXT_WINDOW_MAX), true);
  assert.equal(isValidContextWindow(12), false);
  assert.equal(VENDOR_PRESETS.some((item) => item.id === 'custom'), true);
});

test('settings do not persist a grok blob', () => {
  const next = settings.mergeSettings({ provider: 'openai', apiKey: 'sk-real' }, {
    grok: { signedIn: true, accessToken: 'should-not-stick' },
    language: 'en',
  });
  assert.equal(next.grok, undefined);
  assert.equal(next.apiKey, 'sk-real');
  assert.equal(next.language, 'en');
  const pub = settings.publicSettings(next);
  assert.equal(JSON.stringify(pub).includes('sk-real'), false);
});

test('normalizeSettings v3 keeps providers/defaultModel and drops sources/apiKey', () => {
  const stored = settings.normalizeSettings({
    version: 3,
    providers: [{
      id: 'deepseek',
      kind: 'builtin',
      enabled: ['deepseek-chat'],
      overrides: { 'deepseek-chat': { contextWindow: 256000 } },
    }],
    defaultModel: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    sources: [{ id: 'old', apiKey: 'sk-live-secret-9999' }],
    models: { default: { sourceId: 'old', model: 'x' } },
    apiKey: 'sk-live-secret-9999',
    language: 'en',
  });
  assert.equal(stored.version, 3);
  assert.equal(stored.providers[0].id, 'deepseek');
  assert.deepEqual(stored.defaultModel, { providerId: 'deepseek', modelId: 'deepseek-chat' });
  assert.equal(stored.sources, undefined);
  assert.equal(stored.models, undefined);
  assert.equal(stored.apiKey, undefined);

  const pub = settings.publicSettings(stored);
  assert.equal(pub.version, 3);
  assert.equal(pub.apiKey, undefined);
  assert.equal(pub.sources, undefined);
  assert.equal(JSON.stringify(pub).includes('sk-live-secret-9999'), false);

  const merged = settings.mergeSettings(stored, { language: 'zh', providers: [], apiKey: 'sk-should-not-stick' });
  assert.equal(merged.version, 3);
  assert.equal(merged.language, 'zh');
  assert.equal(merged.apiKey, undefined);
  assert.equal(JSON.stringify(merged).includes('sk-should-not-stick'), false);
});
