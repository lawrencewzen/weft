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
} from '../../src/kernel/compaction-settings.mjs';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import { buildThread } from '../../src/v2/views/thread.ts';
import { runStateView } from '../../src/v2/views/run.ts';
import { compactionView } from '../../src/v2/views/compaction.ts';

const WINDOWS = [32_000, 128_000, 1_000_000];
const PERCENTS = [60, 80, 90];

test('budgets for 32k, 128k and 1M at 60, 80 and 90', () => {
  const expected = {
    '32000:60': { reserveTokens: 3200, backgroundTokens: 9600, keepRecentTokens: 6400 },
    '32000:80': { reserveTokens: 3200, backgroundTokens: 3200, keepRecentTokens: 6400 },
    '32000:90': { reserveTokens: 3200, backgroundTokens: 0, keepRecentTokens: 6400 },
    '128000:60': { reserveTokens: 12800, backgroundTokens: 38400, keepRecentTokens: 20000 },
    '128000:80': { reserveTokens: 12800, backgroundTokens: 12800, keepRecentTokens: 20000 },
    '128000:90': { reserveTokens: 12800, backgroundTokens: 0, keepRecentTokens: 20000 },
    '1000000:60': { reserveTokens: 100000, backgroundTokens: 300000, keepRecentTokens: 20000 },
    '1000000:80': { reserveTokens: 100000, backgroundTokens: 100000, keepRecentTokens: 20000 },
    '1000000:90': { reserveTokens: 100000, backgroundTokens: 0, keepRecentTokens: 20000 },
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
    compaction: { triggerPercent: 80 },
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
  const en = await buildThread(messages, { lang: 'en' });
  assert.equal(en.items[1].text, 'Earlier context was compacted');
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
