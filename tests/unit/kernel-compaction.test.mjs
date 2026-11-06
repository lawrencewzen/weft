// Real Harness compaction. Thresholds come from compaction-settings, which is
// what openConversationKernel puts in the settings function. Pi reads that
// function at each prepare (generation.js) and resolves modelOverrides there.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { openKernel, registerFaux } from '../../src/kernel/index.mjs';
import { kernelSettings } from '../../src/kernel/conversations.mjs';
import { createCompactionControl, compactionBudget } from '../../src/kernel/compaction-settings.mjs';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import { buildThread } from '../../src/v2/views/thread.ts';
import { compactionView } from '../../src/v2/views/compaction.ts';
import { runStateView } from '../../src/v2/views/run.ts';
import { withHarnessLock } from './_harness-lock.mjs';

const MODELS = [
  { id: 'small-32k', contextWindow: 32_000 },
  { id: 'mid-128k', contextWindow: 128_000 },
  { id: 'large-1m', contextWindow: 1_000_000 },
];

function sized(window, percent, mode) {
  const budget = compactionBudget(window, percent);
  const blocking = window - budget.reserveTokens;
  const backgroundAt = blocking - budget.backgroundTokens;
  const recent = 'R'.repeat(Math.ceil(budget.keepRecentTokens * 4) + 200);
  const recentTokens = estimateMessageTokens({ role: 'user', content: recent, timestamp: 1 });
  const target = mode === 'blocking'
    ? blocking + 4000
    : backgroundAt + Math.floor(budget.backgroundTokens / 2);
  const oldTokens = Math.max(32, target - recentTokens);
  const old = `OLD_MARKER ${'O'.repeat(Math.ceil(oldTokens * 4))}`;
  return { budget, recent, old };
}

function defer() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function openHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-compact-'));
  const models = createModels();
  const faux = registerFaux(models, {
    tokenSize: { min: 200000, max: 200000 },
    models: MODELS.map((model) => ({
      id: model.id,
      name: model.id,
      contextWindow: model.contextWindow,
      maxTokens: 4096,
    })),
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
  return { dir, faux, control, kernel };
}

async function track(kernel, conv) {
  const watch = await conv.watch(kernel.context);
  const box = { live: watch.value?.docs?.['pi.live'] || {} };
  watch.start((call) => {
    if (call?.kind === 'value') box.live = call.value?.docs?.['pi.live'] || {};
  });
  return { box, watch };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitRows(box, ready, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const rows = Array.isArray(box.live.compactions) ? box.live.compactions : [];
    if (ready(rows, box.live)) return rows;
    await sleep(15);
  }
  return null;
}

test('three windows at 60, 80 and 90 trigger background or blocking on the real Harness', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const opened = await openHarness();
    const { faux, control, kernel } = opened;
    try {
      for (const model of MODELS) {
        for (const percent of [60, 80, 90]) {
          const mode = percent === 90 ? 'blocking' : 'background';
          control.setPercent(percent);
          const spec = sized(model.contextWindow, percent, mode);
          assert.deepEqual(
            control.current().modelOverrides[`faux/${model.id}`],
            spec.budget,
            `${model.id} p=${percent}`,
          );
          const conv = await kernel.harness.createConversation({
            ownership: { kind: 'ownerless' },
            agent: { model: { provider: 'faux', modelId: model.id } },
          }, kernel.context);
          const tracked = await track(kernel, conv);
          faux.setResponses([fauxAssistantMessage('ack')]);
          await conv.submit({ type: 'input', content: spec.old }, kernel.context);
          await conv.waitForIdle(kernel.context);
          const hold = defer();
          const step = async () => {
            await hold.promise;
            return fauxAssistantMessage('SUM');
          };
          faux.setResponses([step, step, step]);
          const pending = conv.submit({ type: 'input', content: spec.recent }, kernel.context);
          const rows = await waitRows(tracked.box, (list) => list.length > 0);
          assert.ok(rows, `${model.id} p=${percent} ${mode} did not start`);
          assert.equal(rows[0].trigger, 'threshold', `${model.id} p=${percent}`);
          assert.equal(rows[0].blocking, mode === 'blocking', `${model.id} p=${percent} ${mode}`);
          hold.resolve();
          await pending;
          await conv.waitForIdle(kernel.context);
          await tracked.watch.stop();
        }
      }

      // p=90 does not background-compact the same usage that p=80 does. The
      // percent lives in the settings function, so the next prepare sees it
      // without reopening the Harness. The model is the 32k one, then we
      // switch to 128k below by creating that conversation on this same Harness.
      control.setPercent(90);
      const quiet = sized(32_000, 80, 'background');
      const quietConv = await kernel.harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'small-32k' } },
      }, kernel.context);
      faux.setResponses([fauxAssistantMessage('ack'), fauxAssistantMessage('still-here')]);
      await quietConv.submit({ type: 'input', content: quiet.old }, kernel.context);
      await quietConv.waitForIdle(kernel.context);
      await quietConv.submit({ type: 'input', content: quiet.recent }, kernel.context);
      await quietConv.waitForIdle(kernel.context);
      const quietView = await quietConv.context(kernel.context);
      assert.equal(quietView.entries.some((entry) => entry.kind === 'pi.compaction'), false);
      control.setPercent(80);
      const hold = defer();
      faux.setResponses([async () => {
        await hold.promise;
        return fauxAssistantMessage('NOW');
      }, async () => {
        await hold.promise;
        return fauxAssistantMessage('NOW');
      }]);
      const tracked = await track(kernel, quietConv);
      const pending = quietConv.submit({ type: 'input', content: 'ping' }, kernel.context);
      const rows = await waitRows(tracked.box, (list) => list.length > 0);
      assert.ok(rows, 'new percent did not apply on the next prepare');
      assert.equal(rows[0].trigger, 'threshold');
      assert.equal(rows[0].blocking, false);
      hold.resolve();
      await pending;
      await quietConv.waitForIdle(kernel.context);
      await tracked.watch.stop();
    } finally {
      await kernel.close();
      await rm(opened.dir, { recursive: true, force: true });
    }
  });
});

test('manual compact keeps the summary, notes it, and a second call is another official task', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const opened = await openHarness();
    const { faux, control, kernel } = opened;
    const ctx = kernel.context;
    try {
      control.setPercent(80);
      const spec = sized(32_000, 80, 'background');
      const recent = 'R'.repeat(Math.ceil(spec.budget.keepRecentTokens * 4) + 200);
      const conv = await kernel.harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'small-32k' } },
      }, ctx);
      faux.setResponses([fauxAssistantMessage('ack')]);
      await conv.submit({ type: 'input', content: 'OLD_MARKER please remember this' }, ctx);
      await conv.waitForIdle(ctx);
      faux.setResponses([fauxAssistantMessage('ack2')]);
      await conv.submit({ type: 'input', content: recent }, ctx);
      await conv.waitForIdle(ctx);

      faux.setResponses([fauxAssistantMessage('MANUAL_SUMMARY')]);
      const taskId = await conv.compact('keep the names', ctx);
      const settled = await kernel.harness.waitForTask(taskId, ctx);
      assert.equal(settled.state.outcome.status, 'completed');
      const submissionId = settled.state.outcome.result?.submissionId;
      assert.ok(submissionId != null, 'idle manual compact places the summary through a submission');
      const submission = await kernel.harness.submission(submissionId, ctx);
      await submission.wait(ctx);
      const view = await conv.context(ctx);
      const text = JSON.stringify(view.messages);
      assert.equal(text.includes('OLD_MARKER'), false);
      assert.equal(text.includes('MANUAL_SUMMARY'), true);
      assert.equal(text.includes(recent.slice(0, 40)), true);
      const thread = await buildThread(messagesFromEntries(view.entries).messages, { lang: 'zh' });
      const note = thread.items.find((item) => item.noteKind === 'compaction');
      assert.ok(note, JSON.stringify(thread.items));
      assert.equal(note.text, '已压缩较早的上下文');

      const empty = await kernel.harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'small-32k' } },
      }, ctx);
      const emptyId = await empty.compact(undefined, ctx);
      const emptySettled = await kernel.harness.waitForTask(emptyId, ctx);
      assert.equal(emptySettled.state.outcome.status, 'completed');
      assert.equal(emptySettled.state.outcome.result?.entryId, undefined);
      assert.equal(emptySettled.state.outcome.result?.submissionId, undefined);

      const again = await kernel.harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'small-32k' } },
      }, ctx);
      faux.setResponses([fauxAssistantMessage('ack')]);
      await again.submit({ type: 'input', content: 'OLD_MARKER two' }, ctx);
      await again.waitForIdle(ctx);
      faux.setResponses([fauxAssistantMessage('ack2')]);
      await again.submit({ type: 'input', content: recent }, ctx);
      await again.waitForIdle(ctx);
      const hold = defer();
      const tracked = await track(kernel, again);
      faux.setResponses([
        async () => {
          await hold.promise;
          return fauxAssistantMessage('S1');
        },
        async () => {
          await hold.promise;
          return fauxAssistantMessage('S2');
        },
      ]);
      const first = await again.compact(undefined, ctx);
      const second = await again.compact(undefined, ctx);
      assert.notEqual(String(first), String(second));
      const rows = await waitRows(tracked.box, (list) => list.length >= 2);
      assert.ok(rows, 'second manual compact was not admitted beside the first');
      assert.equal(rows.every((row) => row.trigger === 'manual'), true);
      hold.resolve();
      await kernel.harness.waitForTask(first, ctx);
      await kernel.harness.waitForTask(second, ctx);
      await again.waitForIdle(ctx);
      await tracked.watch.stop();
    } finally {
      await kernel.close();
      await rm(opened.dir, { recursive: true, force: true });
    }
  });
});

test('blocking compaction failure is a failed state and a model_error in the same words; overflow still compacts and retries', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const opened = await openHarness();
    const { faux, control, kernel } = opened;
    const ctx = kernel.context;
    try {
      control.setPercent(90);
      const spec = sized(32_000, 90, 'blocking');
      const conv = await kernel.harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'small-32k' } },
      }, ctx);
      const tracked = await track(kernel, conv);
      faux.setResponses([fauxAssistantMessage('ack')]);
      await conv.submit({ type: 'input', content: spec.old }, ctx);
      await conv.waitForIdle(ctx);
      faux.setResponses([
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'summarizer broke sk-supersecretvalue',
        }),
      ]);
      const submitted = await conv.submit({ type: 'input', content: spec.recent }, ctx);
      await conv.waitForIdle(ctx);
      const record = await submitted.status(ctx);
      assert.equal(record.status, 'unanswered');
      assert.equal(record.reason, 'model_error');
      assert.match(record.detail, /^Compaction failed:/);
      const failed = compactionView(tracked.box.live, 'zh');
      assert.equal(failed.state, 'failed');
      assert.equal(failed.trigger, 'threshold');
      assert.equal(failed.error.includes('supersecret'), false);
      const run = runStateView({
        status: 'failed',
        lang: 'en',
        llmError: { code: 'E_LLM', message: record.detail },
        live: tracked.box.live,
      });
      assert.equal(run.error.message, 'Compaction failed: Summarization failed: summarizer broke sk-***');
      assert.equal(run.compaction.error, run.error.message);
      await tracked.watch.stop();

      control.setPercent(80);
      const recent = 'R'.repeat(Math.ceil(compactionBudget(32_000, 80).keepRecentTokens * 4) + 200);
      const overflow = await kernel.harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'small-32k' } },
      }, ctx);
      faux.setResponses([fauxAssistantMessage('ack')]);
      await overflow.submit({ type: 'input', content: 'OLD_MARKER overflow' }, ctx);
      await overflow.waitForIdle(ctx);
      faux.setResponses([fauxAssistantMessage('ack2')]);
      await overflow.submit({ type: 'input', content: recent }, ctx);
      await overflow.waitForIdle(ctx);
      faux.setResponses([
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'Your input exceeds the context window of this model',
        }),
        fauxAssistantMessage('OVERFLOW_SUMMARY'),
        fauxAssistantMessage('AFTER_OVERFLOW'),
      ]);
      await overflow.submit({ type: 'input', content: 'please continue' }, ctx);
      await overflow.waitForIdle(ctx);
      const after = await overflow.context(ctx);
      const body = JSON.stringify(after.messages);
      assert.equal(body.includes('OLD_MARKER'), false);
      assert.equal(body.includes('OVERFLOW_SUMMARY'), true);
      assert.equal(body.includes('AFTER_OVERFLOW'), true);
      assert.equal(after.entries.some((entry) => entry.kind === 'pi.compaction'), true);
    } finally {
      await kernel.close();
      await rm(opened.dir, { recursive: true, force: true });
    }
  });
});
