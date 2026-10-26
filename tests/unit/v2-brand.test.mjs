import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createBrandIcons, loadBrandData } from '../../src/v2/views/brand.ts';
import { createBrandIcons as createPublicBrandIcons } from '../../public/brand-icons.js';
import { ROOT } from './_root.mjs';

const data = loadBrandData();
const icons = createBrandIcons(data);
const publicIcons = createPublicBrandIcons(JSON.parse(readFileSync(path.join(ROOT, 'public', 'brand-data.json'), 'utf8')));

function brandId(modelId) {
  return icons.brandForModel(modelId)?.id ?? null;
}

test('v2 brand table is the same public/brand-data.json', () => {
  assert.equal(data.source.package, '@lobehub/icons');
  assert.ok(data.providers.deepseek);
  assert.equal(data.providers.custom, undefined);
});

test('brandForModel matches public/brand-icons.js', () => {
  const samples = [
    'gpt-5', 'o3-mini', 'claude-sonnet-4', 'deepseek-flash', 'deepseek-v4-pro',
    'grok-build', 'grok-4', 'gemini-2.5-pro', 'qwen3-coder', 'kimi-k2',
    'glm-4.6', 'openrouter/anthropic/claude-sonnet-4', 'DeepSeek-Flash',
    'my-local-model', '', null,
  ];
  for (const sample of samples) {
    assert.equal(
      icons.brandForModel(sample)?.id ?? null,
      publicIcons.brandForModel(sample)?.id ?? null,
      String(sample),
    );
  }
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

test('brandForProvider covers Weft presets and matches public', () => {
  for (const id of ['deepseek', 'xai', 'openai', 'anthropic', 'gemini', 'qwen', 'moonshot', 'zhipu', 'openrouter', 'ollama', 'custom', 'grok']) {
    assert.equal(
      icons.brandForProvider(id)?.id ?? null,
      publicIcons.brandForProvider(id)?.id ?? null,
      id,
    );
  }
  assert.equal(icons.brandForProvider('custom'), null);
  assert.equal(icons.brandForProvider('grok')?.id, 'Grok');
});

test('displayName matches public/brand-icons.js when the leaf does not already start with the brand', () => {
  for (const id of ['deepseek-flash', 'gpt-4o', 'grok-build', 'unknown-local', '']) {
    assert.equal(icons.displayName(id), publicIcons.displayName(id), id);
  }
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
  // public/brand-icons.js still prefixes Qwen onto qwen3-coder; v2 drops the duplicate.
  assert.equal(publicIcons.displayName('qwen/qwen3-coder'), 'Qwen Qwen3 Coder');
  assert.equal(icons.displayName('qwen/qwen3-coder'), 'Qwen3 Coder');
  assert.equal(publicIcons.displayName('anthropic/claude-sonnet-4'), 'Claude Sonnet 4');
  assert.equal(publicIcons.displayName('deepseek-chat'), 'DeepSeek Chat');
  assert.equal(publicIcons.displayName('grok-4.6'), 'Grok 4.6');
  assert.equal(publicIcons.displayName('gpt-5'), 'OpenAI GPT 5');
});
