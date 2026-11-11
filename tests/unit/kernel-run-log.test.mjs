import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunLog } from '../../src/kernel/run-log.mjs';

function capture() {
  const lines = [];
  const mk = (level) => (tag, message, ...extras) => lines.push({ level, tag, message, extras });
  return { lines, log: { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') } };
}

const fields = (row) => Object.assign({}, ...row.extras.filter((e) => e && !(e instanceof Error)));

function assistant(id, extra = {}) {
  return {
    id,
    kind: 'pi.assistant',
    model: [{
      role: 'assistant',
      provider: 'faux',
      model: 'faux-1',
      timestamp: 1000,
      stopReason: 'stop',
      usage: { input: 120, output: 34, cacheRead: 0, cacheWrite: 0, totalTokens: 154, cost: { total: 0 } },
      content: [{ type: 'text', text: 'SECRET ANSWER TEXT' }],
      ...extra,
    }],
  };
}

test('model call end: cid, provider, model, ms, tokens, stopReason; no message text', () => {
  const { lines, log } = capture();
  const runLog = createRunLog({ log, now: () => 1750 });
  runLog.observe('c1', { entries: [assistant(7)] }, [{ event: 'message.done', data: { messageId: '7', text: 'SECRET ANSWER TEXT' } }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'info');
  assert.deepEqual(fields(lines[0]), {
    cid: 'c1', provider: 'faux', model: 'faux-1', ms: 750, inputTokens: 120, outputTokens: 34, stopReason: 'stop',
  });
  assert.equal(JSON.stringify(lines).includes('SECRET'), false);
});

test('a failed model call is an error with the provider error; user messages are not model calls', () => {
  const { lines, log } = capture();
  const runLog = createRunLog({ log, now: () => 2000 });
  const entry = assistant(8, { stopReason: 'error', errorMessage: '429 rate limited' });
  runLog.observe('c1', { entries: [entry] }, [
    { event: 'message.done', data: { messageId: '8' } },
    { event: 'message.done', data: { messageId: '9', role: 'user', text: 'PROMPT' } },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'error');
  assert.match(lines[0].message, /429 rate limited/);
});

test('retry is a warning with the attempt number', () => {
  const { lines, log } = capture();
  createRunLog({ log }).observe('c1', {}, [{ event: 'retry', data: { attempt: 3, delayMs: 8000, reason: 'timeout' } }]);
  assert.equal(lines[0].level, 'warn');
  assert.equal(fields(lines[0]).attempt, 3);
});

test('tools: failures warn, slow calls info, fast successes are silent, no arguments or output', () => {
  const { lines, log } = capture();
  let t = 0;
  const runLog = createRunLog({ log, now: () => t });
  const run = (id, name, ms, status) => {
    t = 0;
    runLog.observe('c1', {}, [{ event: 'tool.start', data: { tool: { id, name, input: { command: 'rm SECRET' } } } }]);
    t = ms;
    runLog.observe('c1', {}, [{ event: 'tool.end', data: { tool: { id, name, status, output: 'SECRET OUT' } } }]);
  };
  run('a', 'bash', 50, 'completed');
  run('b', 'bash', 50, 'error');
  run('c', 'read', 12_000, 'completed');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].level, 'warn');
  assert.deepEqual(fields(lines[0]), { cid: 'c1', tool: 'bash', ms: 50, error: true });
  assert.equal(lines[1].level, 'info');
  assert.equal(fields(lines[1]).ms, 12_000);
  assert.equal(JSON.stringify(lines).includes('SECRET'), false);
});

test('compaction start, finish and failure', () => {
  const { lines, log } = capture();
  let t = 100;
  const runLog = createRunLog({ log, now: () => t });
  const view = (live) => ({ docs: { 'pi.live': live } });
  runLog.observe('c1', view({ compactions: [] }), [], { snapshot: true });
  runLog.observe('c1', view({ compactions: [{ taskId: 'k1', trigger: 'auto', blocking: false }] }), []);
  t = 600;
  runLog.observe('c1', view({ compactions: [] }), []);
  runLog.observe('c1', view({ compactions: [{ taskId: 'k2', trigger: 'manual' }] }), []);
  runLog.observe('c1', view({ compactions: [], compactionFailure: { taskId: 'k2', trigger: 'manual', error: 'model down' } }), []);
  assert.deepEqual(lines.map((l) => [l.level, l.message]), [
    ['info', 'compaction started'],
    ['info', 'compaction finished'],
    ['info', 'compaction started'],
    ['error', 'compaction failed'],
  ]);
  assert.equal(fields(lines[1]).ms, 500);
});

test('observe never throws', () => {
  const log = { debug() { throw new Error('x'); }, info() { throw new Error('x'); }, warn() { throw new Error('x'); }, error() { throw new Error('x'); } };
  assert.doesNotThrow(() => createRunLog({ log }).observe('c', { entries: [assistant(1)] }, [{ event: 'retry', data: {} }]));
});
