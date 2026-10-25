import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createBrandIcons } from '../../public/brand-icons.js';
import { startServer, stopServer } from './_server.mjs';
import { ROOT } from './_root.mjs';

const data = JSON.parse(readFileSync(path.join(ROOT, 'public', 'brand-data.json'), 'utf8'));
const icons = createBrandIcons(data);

function brandId(modelId) {
  return icons.brandForModel(modelId)?.id ?? null;
}

test('brand-data.json matches the LobeHub tables', () => {
  assert.equal(data.source.package, '@lobehub/icons');
  assert.equal(data.source.version, '5.23.0');
  assert.match(data.source.license, /MIT/i);
  assert.equal(data.brands.length, 340);
  // @lobehub/icons@5.23.0 es/features/modelConfig.js ships 103 modelMappings.
  assert.equal(data.models.length, 103);
  assert.ok(data.providers.deepseek);
  assert.equal(data.providers.custom, undefined);
});

test('postinstall copies every static SVG', () => {
  const dir = path.join(ROOT, 'public', 'vendor', 'brand-icons');
  const svgs = readdirSync(dir).filter((name) => name.endsWith('.svg'));
  assert.equal(svgs.length, 950);
  assert.ok(svgs.includes('deepseek.svg'));
  assert.ok(svgs.includes('deepseek-color.svg'));
});

test('brandForModel recognizes common model ids', () => {
  assert.equal(brandId('gpt-5'), 'OpenAI');
  assert.equal(brandId('o3-mini'), 'OpenAI');
  assert.equal(brandId('claude-sonnet-4'), 'Claude');
  assert.equal(brandId('deepseek-flash'), 'DeepSeek');
  assert.equal(brandId('deepseek-v4-pro'), 'DeepSeek');
  assert.equal(brandId('grok-build'), 'Grok');
  assert.equal(brandId('grok-4'), 'Grok');
  assert.equal(brandId('gemini-2.5-pro'), 'Gemini');
  assert.equal(brandId('qwen3-coder'), 'Qwen');
  assert.equal(brandId('kimi-k2'), 'Moonshot');
  assert.equal(brandId('glm-4.6'), 'ZAI');
  assert.equal(brandId('openrouter/anthropic/claude-sonnet-4'), 'Claude');
});

test('brandForModel is case-insensitive and returns null when unknown', () => {
  assert.equal(brandId('DeepSeek-Flash'), 'DeepSeek');
  assert.equal(brandId('my-local-model'), null);
  assert.equal(brandId(''), null);
  assert.equal(brandId(null), null);
});

test('brandForProvider covers Weft presets', () => {
  assert.equal(icons.brandForProvider('deepseek')?.id, 'DeepSeek');
  assert.equal(icons.brandForProvider('xai')?.id, 'XAI');
  assert.equal(icons.brandForProvider('openai')?.id, 'OpenAI');
  assert.equal(icons.brandForProvider('anthropic')?.id, 'Anthropic');
  assert.equal(icons.brandForProvider('gemini')?.id, 'Gemini');
  assert.equal(icons.brandForProvider('qwen')?.id, 'Qwen');
  assert.equal(icons.brandForProvider('moonshot')?.id, 'Moonshot');
  assert.equal(icons.brandForProvider('zhipu')?.id, 'Zhipu');
  assert.equal(icons.brandForProvider('openrouter')?.id, 'OpenRouter');
  assert.equal(icons.brandForProvider('ollama')?.id, 'Ollama');
  assert.equal(icons.brandForProvider('custom'), null);
});

test('iconUrl prefers color and falls back to mono', () => {
  const deepseek = icons.brandForModel('deepseek-flash');
  const grok = icons.brandForModel('grok-4');
  assert.ok(deepseek.variants.includes('color'));
  assert.equal(icons.iconUrl(deepseek), 'vendor/brand-icons/deepseek.svg');
  assert.equal(icons.iconUrl(deepseek, { color: true }), 'vendor/brand-icons/deepseek-color.svg');
  assert.ok(!grok.variants.includes('color'));
  assert.equal(icons.iconUrl(grok, { color: true }), 'vendor/brand-icons/grok.svg');
  assert.equal(icons.iconUrl('DeepSeek', { color: true }), 'vendor/brand-icons/deepseek-color.svg');
});

test('displayName uses the brand title when recognized', () => {
  assert.equal(icons.displayName('deepseek-flash'), 'DeepSeek Flash');
  assert.equal(icons.displayName('my-local-model'), 'my-local-model');
});

test('brand icons are served as static SVG', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.base}/vendor/brand-icons/deepseek.svg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/);
    const body = await res.text();
    assert.match(body, /<svg/i);
  } finally {
    await stopServer(srv);
  }
});
