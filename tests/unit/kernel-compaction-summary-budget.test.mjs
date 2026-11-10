// T130: the summarizer request is sized from reserveTokens (pi-durable
// compaction.js: maxTokens = min(floor(0.8 * reserve), model.maxTokens || inf)),
// and a 'length' stop fails the compaction. A custom endpoint model has
// maxTokens 0, so only the reserve limits it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { openKernel, registerFaux } from '../../src/kernel/index.mjs';
import { kernelSettings } from '../../src/kernel/conversations.mjs';
import { createCompactionControl, compactionBudget } from '../../src/kernel/compaction-settings.mjs';
import { compactionView } from '../../src/v2/views/compaction.ts';
import { runStateView } from '../../src/v2/views/run.ts';
import { withHarnessLock } from './_harness-lock.mjs';

// Pi's formula, copied from compaction.js so the test pins what Pi will request.
function summaryMaxTokens(reserveTokens, modelMaxTokens) {
  return Math.min(
    Math.floor(0.8 * reserveTokens),
    modelMaxTokens > 0 ? modelMaxTokens : Number.POSITIVE_INFINITY,
  );
}

const SUMMARY_NEEDS = 15_000;

test('128k window, no max output: summary limit is at least 25000 tokens', () => {
  const { reserveTokens } = compactionBudget(128_000, 80);
  assert.ok(summaryMaxTokens(reserveTokens, 0) >= 25_000);
  assert.equal(summaryMaxTokens(reserveTokens, 0), 25_600);
});

test('a long conversation on a 128k custom model compacts instead of failing on length', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'weft-compact-budget-'));
    const models = createModels();
    const faux = registerFaux(models, {
      tokenSize: { min: 200000, max: 200000 },
      models: [{ id: 'glm-128k', name: 'glm-128k', contextWindow: 128_000, maxTokens: 0 }],
    });
    const control = createCompactionControl(models);
    control.setPercent(80);
    const kernel = await openKernel({
      dataDir: dir,
      models,
      registry: createRegistry(),
      settings: () => ({
        ...kernelSettings({ WEFT_RETRY_MAX: '1', WEFT_RETRY_BASE_MS: '1' }),
        compaction: control.current(),
      }),
    });
    const ctx = kernel.context;
    try {
      const seen = [];
      const summarizer = (_context, options) => {
        seen.push(options?.maxTokens);
        // The summary this conversation needs is bigger than ~10k tokens.
        return options?.maxTokens < SUMMARY_NEEDS
          ? fauxAssistantMessage('partial', { stopReason: 'length' })
          : fauxAssistantMessage('FULL_SUMMARY');
      };
      const conv = await kernel.harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'glm-128k' } },
      }, ctx);
      const watch = await conv.watch(ctx);
      const box = { live: watch.value?.docs?.['pi.live'] || {} };
      watch.start((call) => {
        if (call?.kind === 'value') box.live = call.value?.docs?.['pi.live'] || {};
      });
      faux.setResponses([fauxAssistantMessage('ack')]);
      await conv.submit({ type: 'input', content: `OLD_MARKER ${'O'.repeat(4 * 118_000)}` }, ctx);
      await conv.waitForIdle(ctx);
      faux.setResponses([summarizer, summarizer, fauxAssistantMessage('DONE')]);
      const submitted = await conv.submit({ type: 'input', content: 'R'.repeat(4 * 20_000 + 200) }, ctx);
      await conv.waitForIdle(ctx);
      const record = await submitted.status(ctx);
      assert.ok(seen.length > 0, 'summarizer was not called');
      assert.ok(seen[0] >= 25_000, `summary maxTokens ${seen[0]}`);
      assert.notEqual(record.reason, 'model_error', record.detail);
      const after = await conv.context(ctx);
      assert.equal(after.entries.some((entry) => entry.kind === 'pi.compaction'), true);
      assert.equal(compactionView(box.live, 'zh').state, 'idle');
      await watch.stop();
    } finally {
      await kernel.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('length failure text is a plain sentence in zh and en; other reasons are unchanged', () => {
  const raw = 'Summarization hit the token limit; the summary is incomplete';
  const zh = '压缩失败：摘要超出长度上限。可在 设置 › 模型 中调大最大输出，或降低思考强度后重试。';
  const en = "Compaction failed: the summary hit the length limit. Raise the model's max output in Settings › Models, or lower the thinking level, then retry.";
  for (const text of [raw, `Compaction failed: ${raw}`]) {
    assert.equal(compactionView({ compactionFailure: { trigger: 'threshold', error: text } }, 'zh').error, zh);
    assert.equal(compactionView({ compactionFailure: { trigger: 'threshold', error: text } }, 'en').error, en);
  }
  const run = runStateView({
    status: 'failed',
    lang: 'zh',
    llmError: { code: 'E_LLM', message: `Compaction failed: ${raw}` },
  });
  assert.equal(run.error.message, zh);
  assert.equal(
    compactionView({ compactionFailure: { error: 'Summarization failed: boom' } }, 'en').error,
    'Compaction failed: Summarization failed: boom',
  );
});
