import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compileSchema } from '../../src/v2/validate.ts';
import { phrase } from '../../src/v2/phrases/index.ts';
import { toolGroupSummaryView } from '../../src/v2/views/tools.ts';
import {
  conversationStatus,
  DEFAULT_STALL_AFTER_MS,
  isRunStalled,
  normalizeRunStatus,
  resolveStallAfterMs,
  runStateView,
  stalledSinceOf,
} from '../../src/v2/views/run.ts';
import { activeToolSummary } from '../../src/v2/views/tools.ts';
import { ROOT } from './_root.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validateRunState = compileSchema(structuredClone(spec.components.schemas.RunState));

function assertRun(view, label) {
  assert.equal(validateRunState(view), true, `${label}: ${JSON.stringify(validateRunState.errors)}`);
}

test('present() statuses normalize to RunState and ConversationView buckets', () => {
  const cases = [
    ['idle', 'idle', 'idle'],
    ['done', 'idle', 'idle'],
    ['running', 'running', 'running'],
    ['recovering', 'running', 'running'],
    ['resuming', 'running', 'running'],
    ['paused', 'waiting', 'waiting'],
    ['waiting', 'waiting', 'waiting'],
    ['error', 'failed', 'failed'],
    ['failed', 'failed', 'failed'],
    ['stopped', 'stopped', 'idle'],
    ['', 'idle', 'idle'],
  ];
  for (const [raw, run, conv] of cases) {
    assert.equal(normalizeRunStatus(raw), run, raw);
    assert.equal(conversationStatus(raw), conv, raw);
  }
});

test('pendingText is null unless running', () => {
  for (const status of ['idle', 'done', 'waiting', 'paused', 'failed', 'stopped']) {
    const view = runStateView({ status, lang: 'zh' });
    assertRun(view, status);
    assert.equal(view.pendingText, null);
    assert.equal(view.canStop, false);
  }
});

test('pendingText: thinking when no running tool', () => {
  const view = runStateView({
    status: 'running',
    lang: 'zh',
    messages: [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 't1', role: 'tool', tool: { id: 'r1', name: 'read', status: 'completed', path: 'a.js' } },
    ],
  });
  assertRun(view, 'thinking');
  assert.equal(view.pendingText, phrase('zh', 'pending_thinking'));
  assert.equal(view.canStop, true);
  assert.equal(view.status, 'running');
});

test('pendingText uses the running tool-group summary', () => {
  const tools = [
    { id: 'r1', name: 'read', status: 'completed', path: 'a.js' },
    { id: 'r2', name: 'read', status: 'running', path: 'b.js' },
  ];
  const messages = tools.map((tool, i) => ({ id: `t${i}`, role: 'tool', tool }));
  const view = runStateView({ status: 'running', lang: 'zh', messages });
  assertRun(view, 'running-tool');
  const summary = toolGroupSummaryView(tools, 'zh');
  assert.equal(summary.running, true);
  assert.equal(view.pendingText, summary.text);
  const en = runStateView({ status: 'running', lang: 'en', messages });
  assertRun(en, 'running-tool-en');
  assert.equal(en.pendingText, toolGroupSummaryView(tools, 'en').text);
  assert.notEqual(view.pendingText, en.pendingText);
});

test('pendingText appends live sub-agent count', () => {
  const view = runStateView({
    status: 'running',
    lang: 'zh',
    messages: [],
    subagents: [
      { id: 'c:agent:0', name: 'Agent', status: 'running' },
      { id: 'c:sub:1', name: 'scout', status: 'running' },
      { id: 'c:sub:2', name: 'review', status: 'running' },
      { id: 'c:sub:3', name: 'done', status: 'done' },
    ],
  });
  assertRun(view, 'subagents');
  assert.equal(
    view.pendingText,
    `${phrase('zh', 'pending_thinking')} ${phrase('zh', 'pending_subagents', { n: 2 })}`,
  );
});

test('no workspace locks send; running can still stop', () => {
  const idle = runStateView({ status: 'idle', hasWorkspace: false });
  assertRun(idle, 'no-ws-idle');
  assert.equal(idle.canSend, false);
  assert.equal(idle.canStop, false);
  assert.equal(idle.lockedReason, 'no_workspace');

  const running = runStateView({ status: 'running', hasWorkspace: false, lang: 'en' });
  assertRun(running, 'no-ws-running');
  assert.equal(running.canSend, false);
  assert.equal(running.canStop, true);
  assert.equal(running.lockedReason, 'no_workspace');
  assert.equal(running.pendingText, phrase('en', 'pending_thinking'));
});

test('failed carries llmError; startedAt is null without a harness timestamp', () => {
  const view = runStateView({
    status: 'failed',
    llmError: { code: 'E_LLM', message: 'model exploded' },
    startedAt: 1_700_000_000_000,
  });
  assertRun(view, 'failed');
  assert.equal(view.status, 'failed');
  assert.deepEqual(view.error, { code: 'E_LLM', message: 'model exploded' });
  assert.equal(view.startedAt, 1_700_000_000_000);
  assert.equal(view.pendingText, null);

  const missing = runStateView({ status: 'error' });
  assertRun(missing, 'error-default');
  assert.equal(missing.status, 'failed');
  assert.deepEqual(missing.error, { code: 'E_LLM', message: '' });
  assert.equal(missing.startedAt, null);

  const withRetry = runStateView({
    status: 'failed',
    llmError: { code: 'E_LLM', message: 'busy', retry: { attempt: 2, delayMs: 400 } },
  });
  assertRun(withRetry, 'retry');
  assert.deepEqual(withRetry.error.retry, { attempt: 2, delayMs: 400 });
});

test('recovering is running so the composer can stop', () => {
  const view = runStateView({ status: 'recovering', hasWorkspace: true, lang: 'zh' });
  assertRun(view, 'recovering');
  assert.equal(view.status, 'running');
  assert.equal(view.canStop, true);
  assert.equal(view.canSend, true);
  assert.equal(view.lockedReason, null);
  assert.equal(view.pendingText, phrase('zh', 'pending_thinking'));
  assert.equal(view.lastActivityAt, null);
  assert.equal(view.stalledSince, null);
  assert.equal(view.activeTool, null);
});

test('stall threshold: default 3 minutes; WEFT_MAIN_STALL_MS overrides; invalid falls back', () => {
  assert.equal(DEFAULT_STALL_AFTER_MS, 180_000);
  assert.equal(resolveStallAfterMs({}), 180_000);
  assert.equal(resolveStallAfterMs({ WEFT_MAIN_STALL_MS: '250' }), 250);
  assert.equal(resolveStallAfterMs({ WEFT_MAIN_STALL_MS: '0' }), 180_000);
  assert.equal(resolveStallAfterMs({ WEFT_MAIN_STALL_MS: '-1' }), 180_000);
  assert.equal(resolveStallAfterMs({ WEFT_MAIN_STALL_MS: 'nope' }), 180_000);
});

test('stalledSince is lastActivityAt only when running past the threshold', () => {
  const last = 1_000_000;
  const threshold = 500;
  assert.equal(isRunStalled(last, last + 499, threshold), false);
  assert.equal(isRunStalled(last, last + 500, threshold), false);
  assert.equal(isRunStalled(last, last + 501, threshold), true);
  assert.equal(stalledSinceOf(true, last, last + 501, threshold), last);
  assert.equal(stalledSinceOf(false, last, last + 501, threshold), null);
  assert.equal(stalledSinceOf(true, null, last + 501, threshold), null);

  const stalled = runStateView({
    status: 'running',
    lastActivityAt: last,
    now: last + 501,
    stallAfterMs: threshold,
  });
  assertRun(stalled, 'stalled');
  assert.equal(stalled.lastActivityAt, last);
  assert.equal(stalled.stalledSince, last);

  const edge = runStateView({
    status: 'running',
    lastActivityAt: last,
    now: last + 500,
    stallAfterMs: threshold,
  });
  assertRun(edge, 'edge');
  assert.equal(edge.stalledSince, null);

  const idle = runStateView({
    status: 'idle',
    lastActivityAt: last,
    now: last + 501,
    stallAfterMs: threshold,
  });
  assertRun(idle, 'idle-stall');
  assert.equal(idle.lastActivityAt, null);
  assert.equal(idle.stalledSince, null);
});

test('activeTool is kept while running and cleared otherwise', () => {
  const tool = { name: 'bash', input: { command: 'npm test' } };
  const active = { name: 'bash', startedAt: 1_000_000, summary: activeToolSummary(tool) };
  assert.equal(active.summary, 'npm test');
  const long = activeToolSummary({
    name: 'bash',
    input: { command: `${'x'.repeat(90)}` },
  });
  assert.equal(long.length, 80);
  assert.equal(long.endsWith('…'), true);

  const running = runStateView({ status: 'running', activeTool: active });
  assertRun(running, 'active-tool');
  assert.deepEqual(running.activeTool, active);

  const idle = runStateView({ status: 'idle', activeTool: active });
  assertRun(idle, 'idle-active-tool');
  assert.equal(idle.activeTool, null);
});
