import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from '../../src/core/model-sources.mjs';
import {
  CUSTOM_PROVIDER_ID,
  normalizeProvidersV3,
} from '../../src/core/provider-config.mjs';

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

test('normalizeProvidersV3 drops legacy provider defaultModel', () => {
  const custom = 'custom-deadbeef';
  const out = normalizeProvidersV3([
    {
      id: 'openai',
      kind: 'builtin',
      enabled: ['gpt-4o'],
      overrides: {},
      defaultModel: 'gpt-4o',
    },
    {
      id: custom,
      kind: 'custom',
      name: 'Proxy',
      baseUrl: 'https://proxy.example/v1',
      api: 'openai-completions',
      enabled: ['local'],
      defaultModel: 'local',
      images: true,
      defaultThinkingLevel: 'low',
    },
    {
      id: 'custom-abcdef01',
      kind: 'custom',
      name: 'Weird',
      baseUrl: 'https://proxy.example/v1',
      api: 'openai-completions',
      enabled: [],
      defaultModel: { modelId: 'nope' },
    },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out.every((item) => !Object.prototype.hasOwnProperty.call(item, 'defaultModel')), true);
  assert.equal(out[1].images, true);
  assert.equal(out[1].defaultThinkingLevel, 'low');
});
