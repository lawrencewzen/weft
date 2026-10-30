import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrandIcons, loadBrandData } from '../../src/v2/views/brand.ts';

const data = loadBrandData();
const icons = createBrandIcons(data);

function brandId(modelId) {
  return icons.brandForModel(modelId)?.id ?? null;
}

test('v2 brand table comes from src/v2/views/brand-data.json', () => {
  assert.equal(data.source.package, '@lobehub/icons');
  assert.ok(data.providers.deepseek);
  assert.equal(data.providers.custom, undefined);
});

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
