import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { createBrandIcons, loadBrandData } from '../../src/v2/views/brand.ts';
import { providerView } from '../../src/v2/views/providers.ts';

const require = createRequire(import.meta.url);

const data = loadBrandData();
const icons = createBrandIcons(data);

function brandId(modelId) {
  return icons.brandForModel(modelId)?.id ?? null;
}

test('brandForModel recognizes common model ids', () => {
  assert.equal(brandId('gpt-5'), 'OpenAI');
  assert.equal(brandId('claude-sonnet-4'), 'Claude');
  assert.equal(brandId('deepseek-flash'), 'DeepSeek');
  assert.equal(brandId('grok-build'), 'Grok');
  assert.equal(brandId('my-local-model'), null);
  assert.equal(brandId(''), null);
  assert.equal(brandId(null), null);
});

test('displayName does not repeat the brand when the leaf already starts with it', () => {
  const expected = {
    'qwen/qwen3-coder': 'Qwen3 Coder',
    'qwen3-coder': 'Qwen3 Coder',
    'anthropic/claude-sonnet-4': 'Claude Sonnet 4',
    'claude-sonnet-4': 'Claude Sonnet 4',
    'deepseek-chat': 'DeepSeek Chat',
    'grok-4.6': 'Grok 4.6',
    'gpt-5': 'OpenAI GPT 5',
  };
  for (const [id, name] of Object.entries(expected)) {
    assert.equal(icons.displayName(id), name, id);
  }
  // The duplicate Qwen prefix is dropped: qwen/qwen3-coder reads as "Qwen3 Coder".
  assert.equal(icons.displayName('qwen/qwen3-coder'), 'Qwen3 Coder');
});

test('any glm substring is ChatGLM, ahead of the ZAI and GLMV rules', () => {
  const ids = [
    'GLM4.7',
    'glm5',
    'glm_5',
    'GLM-5',
    'zai-glm-4.6',
    'glm-4v',
    'ChatGLM3',
    'my.glm.model',
    // Rule table used to map ^glm-5 / -glm-4 / ^glm-4 to ZAI.
    'glm-5',
    'glm-4.7',
    'glm-5-turbo',
  ];
  const brands = ids.map(brandId);
  assert.deepEqual(brands, ids.map(() => 'ChatGLM'));
  assert.equal(brandId('glm-5'), 'ChatGLM');
  assert.notEqual(brandId('glm-5'), 'ZAI');
  assert.notEqual(brandId('glm-4v'), 'GLMV');

  const record = icons.brandForModel('GLM4.7');
  assert.equal(icons.iconUrl(record), 'vendor/brand-icons/chatglm.svg');
  const iconSrc = path.join(
    path.dirname(require.resolve('@lobehub/icons-static-svg/package.json')),
    'icons',
    'chatglm.svg',
  );
  assert.equal(existsSync(iconSrc), true, iconSrc);
});

test('brand words are recognized and rule-table hits stay on their original brand', () => {
  assert.equal(brandId('deepseek-chat'), 'DeepSeek');
  assert.equal(brandId('Pro/deepseek-ai/DeepSeek-V3'), 'DeepSeek');
  assert.equal(brandId('xx-Doubao-yy'), 'Doubao');
  assert.equal(brandId('DoubaoPro'), 'Doubao');
  // "kimi" is already a rule-table keyword → Moonshot. The Kimi fallback must not override it.
  assert.equal(brandId('MyKimi'), 'Moonshot');
  assert.equal(brandId('kimi-k2'), 'Moonshot');
  assert.equal(brandId('Qwen2.5-Instruct'), 'Qwen');
  assert.equal(brandId('MiniMax-Text-01'), 'Minimax');
  assert.equal(brandId('hunyuan-lite'), 'Hunyuan');
  assert.equal(brandId('ERNIE-Speed'), 'Wenxin');
  assert.equal(brandId('Baichuan2-Turbo'), 'Baichuan');
  assert.equal(brandId('ds-v3'), null);
  assert.equal(brandId('my-internal-model'), null);
  assert.equal(brandId('gpt-5'), 'OpenAI');
  assert.equal(brandId('claude-sonnet'), 'Claude');
  assert.equal(brandId('claude-sonnet-4'), 'Claude');
  assert.equal(brandId('gemini-2.5'), 'Gemini');
  assert.equal(brandId('grok-build'), 'Grok');
});

test('keyword table applies only when the rule table misses', () => {
  const local = createBrandIcons({
    brands: [
      { id: 'DeepSeek' },
      { id: 'Qwen' },
      { id: 'Kimi' },
      { id: 'Minimax' },
      { id: 'Doubao' },
      { id: 'Hunyuan' },
      { id: 'Wenxin' },
      { id: 'Baichuan' },
      { id: 'Moonshot' },
    ],
    models: [
      { brand: 'Moonshot', keywords: ['^kimi-k2$'] },
    ],
  });
  const id = (modelId) => local.brandForModel(modelId)?.id ?? null;
  assert.equal(id('kimi-k2'), 'Moonshot');
  assert.equal(id('MyKimi'), 'Kimi');
  assert.equal(id('deepseek-chat'), 'DeepSeek');
  assert.equal(id('Qwen2.5'), 'Qwen');
  assert.equal(id('MiniMax-Text'), 'Minimax');
  assert.equal(id('DoubaoPro'), 'Doubao');
  assert.equal(id('hunyuan-lite'), 'Hunyuan');
  assert.equal(id('ERNIE-Speed'), 'Wenxin');
  assert.equal(id('Baichuan2'), 'Baichuan');
  assert.equal(id('ds-v3'), null);
  assert.equal(id('my-internal-model'), null);
});

function rawModel(id) {
  return {
    id,
    name: id,
    enabled: true,
    contextWindow: 128000,
    maxTokens: 8192,
    images: false,
    reasoning: false,
    overridden: {},
  };
}

function viewOf(kind, id, modelIds, extra = {}) {
  return providerView({
    id,
    kind,
    name: extra.name || id,
    ...(extra.baseUrl ? { baseUrl: extra.baseUrl } : {}),
    ...(kind === 'custom' ? { api: 'openai-completions' } : {}),
    auth: { method: 'api_key', configured: kind === 'custom' },
    models: modelIds.map(rawModel),
  }, 'zh');
}

test('providerView infers a custom brand only when every model brand agrees', () => {
  const deepseek = viewOf('custom', 'custom-aaaa0001', ['deepseek-chat', 'Pro/deepseek-ai/DeepSeek-V3']);
  assert.equal(deepseek.brand, 'DeepSeek');
  assert.deepEqual(deepseek.models.map((model) => model.brand), ['DeepSeek', 'DeepSeek']);

  const glm = viewOf('custom', 'custom-aaaa0002', ['GLM4.7', 'glm-5', 'ChatGLM3']);
  assert.equal(glm.brand, 'ChatGLM');

  assert.equal(viewOf('custom', 'custom-aaaa0003', ['deepseek-chat', 'GLM-5']).brand, null);
  assert.equal(viewOf('custom', 'custom-aaaa0004', ['deepseek-chat', 'my-internal-model']).brand, null);
  assert.equal(viewOf('custom', 'custom-aaaa0005', []).brand, null);
  assert.equal(viewOf('custom', 'custom-aaaa0006', ['ds-v3', 'my-internal-model']).brand, null);
  assert.equal(viewOf('custom', 'custom-glm00001', ['ds-v3'], {
    name: 'GLM gateway',
    baseUrl: 'https://glm.example/v1',
  }).brand, null);

  const builtin = viewOf('builtin', 'deepseek', ['deepseek-chat', 'GLM-5']);
  assert.equal(builtin.brand, 'deepseek');
  assert.deepEqual(builtin.models.map((model) => model.brand), ['DeepSeek', 'ChatGLM']);
  assert.equal(viewOf('builtin', 'zai', ['glm-5']).brand, 'zhipu');
  assert.equal(viewOf('builtin', 'openai', []).brand, 'openai');
  assert.equal(viewOf('builtin', 'anthropic', ['claude-sonnet']).brand, 'anthropic');
});
