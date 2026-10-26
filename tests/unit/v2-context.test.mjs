import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compileSchema } from '../../src/v2/validate.ts';
import { ROOT } from './_root.mjs';
import { contextUsageView } from '../../src/v2/views/context.ts';
import {
  contextUsed,
  contextPercents,
  DEFAULT_CONTEXT_WINDOW,
  composerContextChip,
} from '../../src/core/usage-math.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validateContextUsage = compileSchema(structuredClone(spec.components.schemas.ContextUsage));

function assertContextUsage(value) {
  assert.equal(validateContextUsage(value), true, JSON.stringify(validateContextUsage.errors));
}

test('no usage is 0% ok and uses the default window', () => {
  const view = contextUsageView({});
  assertContextUsage(view);
  assert.deepEqual(view, {
    used: 0,
    window: DEFAULT_CONTEXT_WINDOW,
    percent: 0,
    level: 'ok',
  });
  assert.equal(contextUsed(null), null);
  assert.equal(contextPercents(null, DEFAULT_CONTEXT_WINDOW).usedPct, 0);
  const chip = composerContextChip({ usage: null, window: DEFAULT_CONTEXT_WINDOW });
  assert.equal(chip.used, view.used);
  assert.equal(chip.usedPct, view.percent);
  assert.equal(chip.warn, false);
});

test('exactly 80% is warn', () => {
  const window = 128000;
  const used = 102400;
  const view = contextUsageView({ usage: { total: used }, window });
  assertContextUsage(view);
  assert.equal(view.used, used);
  assert.equal(view.window, window);
  assert.equal(view.percent, 80);
  assert.equal(view.level, 'warn');
  assert.equal(contextUsed({ total: used }), used);
  assert.equal(contextPercents(used, window).usedPct, 80);
  assert.equal(composerContextChip({ usage: { total: used }, window }).warn, true);
});

test('95% is full', () => {
  const window = 128000;
  const used = 121600;
  const view = contextUsageView({ usage: { total: used }, window });
  assertContextUsage(view);
  assert.equal(view.used, used);
  assert.equal(view.percent, 95);
  assert.equal(view.level, 'full');
  assert.equal(contextPercents(used, window).usedPct, 95);
});

test('94% stays warn', () => {
  const window = 128000;
  const used = 120320;
  const view = contextUsageView({ usage: { total: used }, window });
  assertContextUsage(view);
  assert.equal(view.percent, 94);
  assert.equal(view.level, 'warn');
});

test('over the window caps percent at 100 and is full', () => {
  const view = contextUsageView({ usage: { total: 300000 }, window: 256000 });
  assertContextUsage(view);
  assert.equal(view.used, 300000);
  assert.equal(view.window, 256000);
  assert.equal(view.percent, 100);
  assert.equal(view.level, 'full');
  assert.equal(contextPercents(300000, 256000).usedPct, 100);
});

test('missing window uses DEFAULT_CONTEXT_WINDOW', () => {
  const used = 1280;
  const view = contextUsageView({ usage: { total: used } });
  assertContextUsage(view);
  assert.equal(view.window, DEFAULT_CONTEXT_WINDOW);
  assert.equal(view.used, used);
  assert.equal(view.percent, contextPercents(used, DEFAULT_CONTEXT_WINDOW).usedPct);
  assert.equal(view.level, 'ok');
});

test('provider usage keys match the old frontend used/percent', () => {
  const usage = { prompt_tokens: 16000, completion_tokens: 400, total_tokens: 16400 };
  const window = 200000;
  const view = contextUsageView({ usage, window });
  assertContextUsage(view);
  assert.equal(view.used, contextUsed(usage));
  assert.equal(view.percent, contextPercents(contextUsed(usage), window).usedPct);
  assert.equal(view.level, 'ok');
  const chip = composerContextChip({ usage, window });
  assert.equal(chip.used, view.used);
  assert.equal(chip.window, view.window);
  assert.equal(chip.usedPct, view.percent);
});
