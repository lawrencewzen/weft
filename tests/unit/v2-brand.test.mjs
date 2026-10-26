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

test('displayName matches public/brand-icons.js', () => {
  for (const id of ['deepseek-flash', 'gpt-4o', 'grok-build', 'unknown-local', '']) {
    assert.equal(icons.displayName(id), publicIcons.displayName(id), id);
  }
});
