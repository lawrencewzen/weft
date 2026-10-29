import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import {
  configureThinkingLevel,
  defaultThinkingLevelOf,
  effectiveThinkingLevel,
  parseThinkingLevelPatch,
  thinkingFieldsOf,
  thinkingLevelMapFromSupportedLevels,
  thinkingLevelsOf,
} from '../../src/core/thinking-level.mjs';
import { parseFetchedChatModels } from '../../src/kernel/models.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

function catalog(providerId, modelId) {
  const hit = (getBuiltinModels(providerId) || []).find((item) => item.id === modelId);
  assert.ok(hit, `missing catalog model ${providerId}/${modelId}`);
  return hit;
}

test('default thinking level is clampThinkingLevel(model, medium)', () => {
  const table = [
    ['deepseek', 'deepseek-flash', 'high'],
    ['deepseek', 'deepseek-v4-pro', 'high'],
    ['zai', 'glm-5.2', 'high'],
    ['anthropic', 'claude-sonnet-4-6', 'medium'],
    ['openai', 'gpt-5', 'medium'],
    ['moonshotai', 'kimi-k2.6', 'medium'],
    ['openai', 'gpt-4o', null],
  ];
  for (const [providerId, modelId, expected] of table) {
    const model = catalog(providerId, modelId);
    assert.equal(defaultThinkingLevelOf(model), expected, `${providerId}/${modelId}`);
    assert.equal(effectiveThinkingLevel(model, null), expected, `${providerId}/${modelId} stored null`);
  }

  const flash = catalog('deepseek', 'deepseek-flash');
  assert.deepEqual(thinkingLevelsOf(flash), ['off', 'low', 'high', 'max']);
  assert.equal(effectiveThinkingLevel(flash, 'high'), 'high');
  assert.equal(effectiveThinkingLevel(flash, 'medium'), 'high');
  assert.equal(configureThinkingLevel(flash, null), 'high');
  assert.equal(configureThinkingLevel(flash, 'low'), 'low');

  const pro = catalog('deepseek', 'deepseek-v4-pro');
  assert.deepEqual(thinkingLevelsOf(pro), ['off', 'high', 'max']);
  assert.equal(effectiveThinkingLevel(pro, 'low'), 'high');

  const gpt = catalog('openai', 'gpt-4o');
  assert.equal(gpt.reasoning, false);
  assert.deepEqual(thinkingLevelsOf(gpt), []);
  assert.equal(effectiveThinkingLevel(gpt, 'high'), null);
  assert.equal(configureThinkingLevel(gpt, 'high'), undefined);

  const sonnet = catalog('anthropic', 'claude-sonnet-4-6');
  assert.deepEqual(thinkingLevelsOf(sonnet), ['off', 'minimal', 'low', 'medium', 'high', 'max']);
  assert.equal(effectiveThinkingLevel(sonnet, 'xhigh'), 'max');
});

test('defaultThinkingLevel clamps medium to the nearest supported level', () => {
  const forced = {
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      max: 'max',
    },
  };
  assert.deepEqual(thinkingLevelsOf(forced), ['high', 'max']);
  assert.equal(defaultThinkingLevelOf(forced), 'high');
  assert.equal(effectiveThinkingLevel(forced, null), 'high');
  assert.equal(effectiveThinkingLevel(forced, 'off'), 'high');
  assert.deepEqual(thinkingFieldsOf(forced), {
    thinkingLevels: ['high', 'max'],
    defaultThinkingLevel: 'high',
  });
});

test('custom effort.supported_levels maps to off plus known names; missing means no thinking', () => {
  const meta = { providerId: 'custom-1', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1' };
  assert.equal(thinkingLevelMapFromSupportedLevels(undefined), null);
  assert.equal(thinkingLevelMapFromSupportedLevels('high'), null);
  assert.deepEqual(thinkingLevelMapFromSupportedLevels(['low', 'high', 'max', 'ultra']), {
    off: 'off',
    minimal: null,
    low: 'low',
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  });

  const withEffort = parseFetchedChatModels({
    data: [{ id: 'thinker', effort: { supported_levels: ['low', 'high', 'max'] } }],
  }, meta)[0];
  assert.equal(withEffort.reasoning, true);
  assert.deepEqual(thinkingLevelsOf(withEffort), ['off', 'low', 'high', 'max']);
  assert.equal(defaultThinkingLevelOf(withEffort), 'high');
  assert.equal(configureThinkingLevel(withEffort, null), 'high');

  const without = parseFetchedChatModels({
    data: [{ id: 'plain', effort: 'high', reasoning: { effort: 'low' } }],
  }, meta)[0];
  assert.equal(without.reasoning, false);
  assert.equal(without.thinkingLevelMap, undefined);
  assert.deepEqual(thinkingLevelsOf(without), []);
  assert.equal(defaultThinkingLevelOf(without), null);
  assert.equal(configureThinkingLevel(without, 'high'), undefined);
});

test('parseThinkingLevelPatch accepts canonical names and null, rejects the rest', () => {
  assert.deepEqual(parseThinkingLevelPatch({}), { present: false });
  assert.deepEqual(parseThinkingLevelPatch({ thinkingLevel: null }), { present: true, ok: true, value: null });
  assert.deepEqual(parseThinkingLevelPatch({ thinkingLevel: 'high' }), { present: true, ok: true, value: 'high' });
  assert.equal(parseThinkingLevelPatch({ thinkingLevel: 'nope' }).ok, false);
  assert.equal(parseThinkingLevelPatch({ thinkingLevel: '' }).ok, false);
  assert.equal(parseThinkingLevelPatch({ thinkingLevel: 1 }).ok, false);
});

test('sqlite stores thinking_level and old databases gain the column', async () => {
  const dir = await makeTempDir('weft-thinking-sql-');
  try {
    const store = createSqliteStore(dir);
    const conv = await store.createConversation({ title: 't' });
    assert.equal(conv.thinkingLevel, null);
    const updated = await store.updateConversation(conv.id, { thinkingLevel: 'high' });
    assert.equal(updated.thinkingLevel, 'high');
    const got = await store.getConversation(conv.id);
    assert.equal(got.thinkingLevel, 'high');
    const cleared = await store.updateConversation(conv.id, { thinkingLevel: null });
    assert.equal(cleared.thinkingLevel, null);
    store.close();

    const again = createSqliteStore(dir);
    const row = await again.getConversation(conv.id);
    assert.equal(row.thinkingLevel, null);
    again.close();
  } finally {
    await removeTempDir(dir);
  }
});
