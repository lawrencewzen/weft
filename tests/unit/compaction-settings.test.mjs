import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import * as settings from '../../src/core/settings.mjs';
import { createKernelModels } from '../../src/kernel/models.mjs';
import {
  compactionBudget,
  compactionOverrides,
  createCompactionControl,
  effectiveTriggers,
  selectableModelKeys,
} from '../../src/kernel/compaction-settings.mjs';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import { buildThread } from '../../src/v2/views/thread.ts';
import { runStateView } from '../../src/v2/views/run.ts';
import { compactionView } from '../../src/v2/views/compaction.ts';

const WINDOWS = [8_000, 32_000, 128_000, 200_000, 1_000_000];
const PERCENTS = [60, 80, 90];

// reserve = max(10% of W, min(32000, 25% of W)); blocking at W - reserve;
// background = max(5% of W, (W - reserve) - W*p%), so it always starts at
// W*p% or 5 points of W before the blocking line, whichever is earlier.
test('budgets for 8k, 32k, 128k, 200k and 1M at 60, 80 and 90', () => {
  const expected = {
    // reserve 2000 (25% of 8k beats 800), blocking at 75%
    '8000:60': { reserveTokens: 2000, backgroundTokens: 1200, keepRecentTokens: 1600 },
    '8000:80': { reserveTokens: 2000, backgroundTokens: 400, keepRecentTokens: 1600 },
    '8000:90': { reserveTokens: 2000, backgroundTokens: 400, keepRecentTokens: 1600 },
    // reserve 8000, blocking at 75%
    '32000:60': { reserveTokens: 8000, backgroundTokens: 4800, keepRecentTokens: 6400 },
    '32000:80': { reserveTokens: 8000, backgroundTokens: 1600, keepRecentTokens: 6400 },
    '32000:90': { reserveTokens: 8000, backgroundTokens: 1600, keepRecentTokens: 6400 },
    // reserve 32000, blocking at 75%, background from 70% at the latest
    '128000:60': { reserveTokens: 32000, backgroundTokens: 19200, keepRecentTokens: 20000 },
    '128000:80': { reserveTokens: 32000, backgroundTokens: 6400, keepRecentTokens: 20000 },
    '128000:90': { reserveTokens: 32000, backgroundTokens: 6400, keepRecentTokens: 20000 },
    // reserve 32000, blocking at 84%, background from 79% at the latest
    '200000:60': { reserveTokens: 32000, backgroundTokens: 48000, keepRecentTokens: 20000 },
    '200000:80': { reserveTokens: 32000, backgroundTokens: 10000, keepRecentTokens: 20000 },
    '200000:90': { reserveTokens: 32000, backgroundTokens: 10000, keepRecentTokens: 20000 },
    // the old 10% reserve still wins on a large window
    '1000000:60': { reserveTokens: 100000, backgroundTokens: 300000, keepRecentTokens: 20000 },
    '1000000:80': { reserveTokens: 100000, backgroundTokens: 100000, keepRecentTokens: 20000 },
    '1000000:90': { reserveTokens: 100000, backgroundTokens: 50000, keepRecentTokens: 20000 },
  };
  for (const window of WINDOWS) {
    for (const percent of PERCENTS) {
      assert.deepEqual(
        compactionBudget(window, percent),
        expected[`${window}:${percent}`],
        `${window} p=${percent}`,
      );
    }
  }
});

test('background always exists and starts at W*p% or 5 points before the blocking line, whichever is earlier', () => {
  for (const window of WINDOWS) {
    for (const percent of [60, 65, 70, 75, 80, 85, 90]) {
      const { reserveTokens, backgroundTokens } = compactionBudget(window, percent);
      const blocking = window - reserveTokens;
      const start = blocking - backgroundTokens;
      const wanted = Math.floor((window * percent) / 100);
      const latest = blocking - Math.floor(window * 0.05);
      assert.ok(backgroundTokens > 0, `${window} p=${percent}`);
      assert.equal(start, Math.min(wanted, latest), `${window} p=${percent}`);
      assert.ok(start <= latest, `${window} p=${percent}`);
    }
  }
});

test('stored settings default to 80 and reject illegal trigger percents', () => {
  const missing = settings.normalizeSettings({ version: 3, providers: [], language: 'zh' });
  assert.equal(missing.compaction.triggerPercent, 80);
  assert.equal(settings.publicSettings(missing).compaction.triggerPercent, 80);
  const illegal = settings.normalizeSettings({
    version: 3,
    providers: [],
    compaction: { triggerPercent: 50 },
  });
  assert.equal(illegal.compaction.triggerPercent, 80);

  assert.equal(settings.validateCompactionPatch({ language: 'en' }), null);
  assert.equal(settings.validateCompactionPatch({ compaction: { triggerPercent: 80 } }), null);
  assert.equal(settings.validateCompactionPatch({ compaction: { triggerPercent: 60 } }), null);
  assert.equal(settings.validateCompactionPatch({ compaction: { triggerPercent: 90 } }), null);
  for (const triggerPercent of [59, 91, 80.5, '80', true, null]) {
    const error = settings.validateCompactionPatch({ compaction: { triggerPercent } });
    assert.equal(typeof error, 'string', JSON.stringify(triggerPercent));
  }
  assert.equal(typeof settings.validateCompactionPatch({ compaction: null }), 'string');

  const saved = settings.mergeSettings(missing, { compaction: { triggerPercent: 70 } });
  assert.equal(saved.compaction.triggerPercent, 70);
  const kept = settings.mergeSettings(saved, { language: 'en' });
  assert.equal(kept.compaction.triggerPercent, 70);
  assert.equal(settings.compactionSettingsView(kept).compaction.triggerPercent, 70);
});

test('closeAction defaults to ask and only stores ask, tray or quit', () => {
  const missing = settings.normalizeSettings({ version: 3, providers: [], language: 'zh' });
  assert.equal(missing.closeAction, 'ask');
  assert.equal(settings.readCloseAction({}), 'ask');
  assert.equal(settings.readCloseAction({ closeAction: 'nope' }), 'ask');
  assert.equal(settings.publicSettings(missing).closeAction, 'ask');
  assert.deepEqual(settings.compactionSettingsView(missing), {
    compaction: { triggerPercent: 80, effective: [] },
    closeAction: 'ask',
  });

  assert.equal(settings.validateCloseActionPatch({}), null);
  assert.equal(settings.validateCloseActionPatch({ language: 'en' }), null);
  assert.equal(settings.validateCloseActionPatch({ compaction: { triggerPercent: 80 } }), null);
  for (const closeAction of ['ask', 'tray', 'quit']) {
    assert.equal(settings.validateCloseActionPatch({ closeAction }), null, closeAction);
  }
  for (const closeAction of ['minimize', '', 'ASK', 'tray ', null, 1, true, false]) {
    const error = settings.validateCloseActionPatch({ closeAction });
    assert.equal(typeof error, 'string', JSON.stringify(closeAction));
    assert.match(error, /closeAction/);
  }

  const saved = settings.mergeSettings(missing, { closeAction: 'tray' });
  assert.equal(saved.closeAction, 'tray');
  assert.equal(saved.compaction.triggerPercent, 80);
  const kept = settings.mergeSettings(saved, { compaction: { triggerPercent: 70 } });
  assert.equal(kept.closeAction, 'tray');
  assert.equal(kept.compaction.triggerPercent, 70);
  const quit = settings.mergeSettings(kept, { closeAction: 'quit' });
  assert.equal(quit.closeAction, 'quit');
  assert.equal(quit.compaction.triggerPercent, 70);
  assert.equal(settings.compactionSettingsView(quit).closeAction, 'quit');
  const still = settings.mergeSettings(quit, { closeAction: 'nope' });
  assert.equal(still.closeAction, 'quit');
  const corrupt = settings.normalizeSettings({ version: 3, providers: [], closeAction: 'minimize' });
  assert.equal(corrupt.closeAction, 'ask');
  const ask = settings.mergeSettings(still, { closeAction: 'ask' });
  assert.equal(ask.closeAction, 'ask');
  assert.equal(ask.compaction.triggerPercent, 70);
});

test('user window override is the window the budget uses, and a later sync applies without a new control', async () => {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'custom-abcdef01',
    models: [{ id: 'm', name: 'm', contextWindow: 128000, maxTokens: 4096 }],
  });
  let stored = {
    version: 3,
    language: 'zh',
    providers: [{
      id: 'custom-abcdef01',
      kind: 'custom',
      name: 'Override',
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      enabled: ['m'],
      overrides: { m: { contextWindow: 32000 } },
    }],
    compaction: { triggerPercent: 80 },
  };
  const control = createCompactionControl(models);
  const routes = createKernelModels({
    models,
    extraProviders: [faux.provider],
    getSettings: async () => stored,
    onSynced(next) {
      control.setPercent(settings.readTriggerPercent(next));
    },
  });
  await routes.warm();
  assert.equal(models.getModel('custom-abcdef01', 'm').contextWindow, 32000);
  assert.deepEqual(
    control.current().modelOverrides['custom-abcdef01/m'],
    compactionBudget(32000, 80),
  );

  stored = {
    ...stored,
    compaction: { triggerPercent: 60 },
    providers: [{
      ...stored.providers[0],
      overrides: { m: { contextWindow: 1_000_000 } },
    }],
  };
  await routes.warm();
  assert.equal(models.getModel('custom-abcdef01', 'm').contextWindow, 1_000_000);
  assert.deepEqual(
    control.current().modelOverrides['custom-abcdef01/m'],
    compactionBudget(1_000_000, 60),
  );
});

test('a model with no positive context window is omitted', () => {
  const overrides = compactionOverrides({
    getAllModels: () => [
      { provider: 'faux', id: 'known', contextWindow: 32000 },
      { provider: 'faux', id: 'unknown', contextWindow: 0 },
      { provider: 'faux', id: 'missing' },
    ],
  }, 80);
  assert.deepEqual(Object.keys(overrides.modelOverrides), ['faux/known']);
  assert.equal(overrides.enabled, true);
});

test('pi.compaction entries become a compaction note at that position', async () => {
  const { messages } = messagesFromEntries([
    { id: 1, kind: 'pi.user', model: [{ role: 'user', content: [{ type: 'text', text: 'OLD' }] }] },
    { id: 2, kind: 'pi.compaction', model: [{ role: 'user', content: [{ type: 'text', text: 'SECRET SUMMARY' }] }] },
    { id: 3, kind: 'pi.user', model: [{ role: 'user', content: [{ type: 'text', text: 'kept' }] }] },
  ]);
  const zh = await buildThread(messages, { lang: 'zh' });
  assert.deepEqual(zh.items.map((item) => item.kind), ['user', 'system_note', 'user']);
  assert.equal(zh.items[1].noteKind, 'compaction');
  assert.equal(zh.items[1].text, '已压缩较早的上下文');
  assert.equal(zh.items[1].text.includes('SECRET'), false);
  assert.equal(zh.items[1].detail, 'SECRET SUMMARY');
  const en = await buildThread(messages, { lang: 'en' });
  assert.equal(en.items[1].text, 'Earlier context was compacted');
});

test('compaction note detail is the summary body without the model-facing wrapper', async () => {
  const wrapped = 'The conversation history before this point was compacted:\n\n<summary>\n## Goal\nShip it\n</summary>';
  const { messages } = messagesFromEntries([
    { id: 1, kind: 'pi.compaction', model: [{ role: 'user', content: [{ type: 'text', text: wrapped }] }] },
    { id: 2, kind: 'pi.compaction', model: [{ role: 'user', content: [{ type: 'text', text: '   ' }] }] },
  ]);
  const { items } = await buildThread(messages, { lang: 'en' });
  assert.equal(items[0].detail, '## Goal\nShip it');
  assert.equal('detail' in items[1], false);
});

test('compaction failure and blocking model_error use the same redacted sentence', () => {
  const live = {
    compactionFailure: {
      trigger: 'threshold',
      error: 'Summarization failed: sk-supersecretvalue',
    },
  };
  const failed = compactionView(live, 'zh');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.trigger, 'threshold');
  assert.equal(failed.error, '压缩失败：Summarization failed: sk-***');
  assert.equal(failed.error.includes('supersecret'), false);
  const en = compactionView(live, 'en');
  assert.equal(en.error, 'Compaction failed: Summarization failed: sk-***');

  const run = runStateView({
    status: 'failed',
    lang: 'zh',
    llmError: {
      code: 'E_LLM',
      message: 'Compaction failed: Summarization failed: sk-supersecretvalue',
    },
  });
  assert.equal(run.error.message, failed.error);
  assert.equal(run.compaction.state, 'idle');

  const running = compactionView({
    compactions: [
      { trigger: 'manual', blocking: false },
      { trigger: 'threshold', blocking: true },
    ],
    compactionFailure: live.compactionFailure,
  }, 'en');
  assert.deepEqual(running, { state: 'running', trigger: 'threshold' });
  assert.deepEqual(compactionView(null, 'zh'), { state: 'idle' });
});

test('effective lists only models that start earlier than p, from the same budget', () => {
  const models = {
    getAllModels: () => [
      { provider: 'a', id: 'w128', name: 'W128', contextWindow: 128_000 },
      { provider: 'a', id: 'w200', name: 'W200', contextWindow: 200_000 },
      { provider: 'a', id: 'zero', name: 'Zero', contextWindow: 0 },
      { provider: 'a', id: 'unnamed', contextWindow: 32_000 },
    ],
  };
  const pick = (p) => effectiveTriggers(models, p).map((m) => `${m.modelId}:${m.percent}`);
  // 128k: blocking 96000 (75%), 5% margin -> starts at 70% for any p above that.
  // 200k: blocking 168000 (84%), margin 10000 -> starts at 79%.
  // 32k: blocking 24000 (75%), margin 1600 -> 70%.
  assert.deepEqual(pick(60), []);
  assert.deepEqual(pick(80), ['w128:70', 'w200:79', 'unnamed:70']);
  assert.deepEqual(pick(90), ['w128:70', 'w200:79', 'unnamed:70']);
  assert.equal(effectiveTriggers(models, 80)[2].name, 'unnamed');
  assert.deepEqual(effectiveTriggers(models, 80)[0], {
    providerId: 'a', modelId: 'w128', name: 'W128', percent: 70,
  });
  // The listed percent is exactly where compactionBudget puts the background start.
  for (const p of [60, 70, 80, 90]) {
    for (const item of effectiveTriggers(models, p)) {
      const model = models.getAllModels().find((m) => m.id === item.modelId);
      const b = compactionBudget(model.contextWindow, p);
      const start = model.contextWindow - b.reserveTokens - b.backgroundTokens;
      assert.equal(item.percent, Math.round((start * 100) / model.contextWindow));
      assert.ok(item.percent < p);
    }
  }
});

test('effective lists only models of enabled providers that the picker shows', () => {
  const models = {
    getAllModels: () => [
      { provider: 'on', id: 'm1', name: 'M1', contextWindow: 128_000 },
      { provider: 'on', id: 'hidden', name: 'Hidden', contextWindow: 128_000 },
      { provider: 'off', id: 'm2', name: 'M2', contextWindow: 128_000 },
    ],
  };
  const providers = [
    { id: 'on', models: [{ id: 'm1', enabled: true }, { id: 'hidden', enabled: false }] },
    { id: 'off', models: [{ id: 'm2', enabled: false }] },
  ];
  const list = effectiveTriggers(models, 80, selectableModelKeys(providers));
  assert.deepEqual(list.map((m) => `${m.providerId}/${m.modelId}`), ['on/m1']);
  assert.equal(effectiveTriggers(models, 80).length, 3);
});
