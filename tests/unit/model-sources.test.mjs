import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';

const sources = await load('src/core/model-sources.mjs');
const settings = await load('src/core/settings.mjs');

const {
  migrateLegacySettings,
  vendorPreset,
  vendorForBaseUrl,
  normalizeHttpUrl,
  isValidContextWindow,
  VENDOR_PRESETS,
  CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_MAX,
  SETTINGS_VERSION,
} = sources;

const fixedId = () => 'srcfixed1';

test('vendor presets and URL helpers stay available for v3 migration', () => {
  assert.equal(SETTINGS_VERSION, 2);
  assert.equal(vendorPreset('deepseek').baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(vendorPreset('zhipu').name, '智谱');
  assert.equal(normalizeHttpUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(vendorForBaseUrl('https://api.deepseek.com/v1/').id, 'deepseek');
  assert.equal(isValidContextWindow(CONTEXT_WINDOW_MIN), true);
  assert.equal(isValidContextWindow(CONTEXT_WINDOW_MAX), true);
  assert.equal(isValidContextWindow(12), false);
  assert.equal(VENDOR_PRESETS.some((item) => item.id === 'custom'), true);
});

test('default and untouched preset rows do not become API sources', () => {
  const untouched = migrateLegacySettings({
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    models: { default: 'gpt-4o-leftover' },
  }, { createId: fixedId });
  assert.equal(untouched.version, 2);
  assert.deepEqual(untouched.sources, []);
  assert.deepEqual(untouched.models, {});
  assert.equal(untouched.provider, 'openai');
  assert.equal(untouched.baseUrl, '');
  assert.equal(untouched.apiKey, '');

  const presetOnly = migrateLegacySettings({
    provider: 'deepseek',
    baseUrl: '',
    apiKey: '',
    models: { coder: 'deepseek-chat' },
  }, { createId: fixedId });
  assert.deepEqual(presetOnly.sources, []);
  assert.deepEqual(presetOnly.models, {});

  const presetUrl = migrateLegacySettings({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1/',
    apiKey: '',
    models: { default: 'gpt-4o' },
  }, { createId: fixedId });
  assert.deepEqual(presetUrl.sources, []);
  assert.deepEqual(presetUrl.models, {});
});

test('a real key, Ollama URL, or non-preset URL becomes one API source', () => {
  const keyed = migrateLegacySettings({
    provider: 'openai',
    baseUrl: '',
    apiKey: 'sk-legacy-secret-value',
    models: { default: 'gpt-4o', coder: 'gpt-4o' },
    language: 'en',
  }, { createId: fixedId });
  assert.equal(keyed.sources.length, 1);
  assert.equal(keyed.sources[0].id, 'srcfixed1');
  assert.equal(keyed.sources[0].baseUrl, 'https://api.openai.com/v1');
  assert.equal(keyed.sources[0].apiKey, 'sk-legacy-secret-value');
  assert.deepEqual(keyed.sources[0].models, ['gpt-4o']);
  assert.deepEqual(keyed.models, {
    default: { sourceId: 'srcfixed1', model: 'gpt-4o' },
  });
  assert.equal(keyed.apiKey, '');
  assert.equal(keyed.baseUrl, '');
  assert.equal(keyed.provider, 'openai');
  assert.equal(keyed.language, 'en');

  const ollama = migrateLegacySettings({
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    models: { default: 'llama3.2' },
  }, { createId: fixedId });
  assert.equal(ollama.sources.length, 1);
  assert.equal(ollama.sources[0].vendor, 'ollama');
  assert.equal(ollama.sources[0].apiKey, '');
  assert.equal(ollama.models.default.sourceId, 'srcfixed1');

  const customUrl = migrateLegacySettings({
    provider: 'openai',
    baseUrl: 'https://proxy.example/v1',
    apiKey: '',
    models: { tester: 'gpt-4o' },
  }, { createId: fixedId });
  assert.equal(customUrl.sources.length, 1);
  assert.equal(customUrl.sources[0].baseUrl, 'https://proxy.example/v1');
  assert.equal(customUrl.models.tester, undefined);
  assert.equal(customUrl.models.default, undefined);
});

test('legacy grok sign-in is ignored, leftover grok field is dropped, and version 2 is left alone', () => {
  const grokOnly = migrateLegacySettings({
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    grok: { signedIn: true },
    models: { default: 'grok-4' },
  }, { createId: fixedId });
  assert.equal(grokOnly.sources.length, 0);
  assert.deepEqual(grokOnly.models, {});
  assert.equal(grokOnly.grok, undefined);

  const both = migrateLegacySettings({
    provider: 'openai',
    apiKey: 'sk-legacy-secret-value',
    grok: { signedIn: true },
    models: { coder: 'gpt-4o' },
  }, { createId: fixedId });
  assert.deepEqual(both.sources.map((source) => source.id), ['srcfixed1']);
  assert.equal(both.models.coder, undefined);
  assert.equal(both.models.default, undefined);
  assert.equal(both.apiKey, '');
  assert.equal(both.grok, undefined);

  const current = {
    version: 2,
    apiKey: 'leave-this-row',
    sources: [{ id: 'abc', kind: 'api', vendor: 'custom', name: 'C', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', models: ['m'] }],
    models: { default: { sourceId: 'abc', model: 'm' } },
  };
  const again = migrateLegacySettings(current, { createId: () => 'nope' });
  assert.equal(again.version, 2);
  assert.equal(again.apiKey, 'leave-this-row');
  assert.equal(again.sources.length, 1);
  assert.equal(again.sources[0].id, 'abc');
  assert.deepEqual(again.models, current.models);
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
