import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSubagentReport } from '../../src/kernel/subagent-report.mjs';
import { describeForkPoint, forkTitle } from '../../src/kernel/fork.mjs';

test('forkTitle appends (fork) in every language', () => {
  assert.equal(forkTitle('你好助手介绍', 'zh'), '你好助手介绍 (fork)');
  assert.equal(forkTitle('Plan review', 'en'), 'Plan review (fork)');
});

test('forkTitle numbers re-forks instead of stacking suffixes', () => {
  assert.equal(forkTitle('X (fork)', 'zh'), 'X (fork 2)');
  assert.equal(forkTitle('X (fork 2)', 'en'), 'X (fork 3)');
  assert.equal(forkTitle('X (fork 9)', 'en'), 'X (fork 10)');
});

test('forkTitle reads legacy （分叉） suffixes, each one counting once', () => {
  assert.equal(forkTitle('X（分叉）', 'zh'), 'X (fork 2)');
  assert.equal(forkTitle('你好助手介绍（分叉）（分叉）', 'zh'), '你好助手介绍 (fork 3)');
  assert.equal(forkTitle('X（分叉） (fork)', 'zh'), 'X (fork 3)');
  assert.equal(forkTitle('X (fork)（分叉）', 'zh'), 'X (fork 3)');
});

test('forkTitle keeps (fork) text that is not a trailing suffix', () => {
  assert.equal(forkTitle('How (fork) works', 'en'), 'How (fork) works (fork)');
});

test('forkTitle falls back to the default title when empty', () => {
  assert.equal(forkTitle('', 'zh'), 'New conversation (fork)');
  assert.equal(forkTitle(null, 'en'), 'New conversation (fork)');
  assert.equal(forkTitle('  (fork)', 'en'), 'New conversation (fork 2)');
});

const call = (id, name = 'x') => ({ type: 'toolCall', id, name, arguments: {} });
const assistant = (id, content) => ({ id, kind: 'pi.assistant', model: [{ role: 'assistant', content }] });
const result = (id, toolCallId) => ({ id, kind: 'pi.tool-result', model: [{ toolCallId }] });
const user = (id, text) => ({ id, kind: 'pi.user', model: [{ role: 'user', content: text }] });

test('describeForkPoint keeps a cut assistant message together with its tool results', () => {
  const entries = [
    user(1, 'hi'),
    assistant(2, [{ type: 'text', text: 'working' }, call('a'), call('b')]),
    result(3, 'a'),
    user(4, formatSubagentReport({ name: 'scout', kind: 'answered', body: 'ok' })),
    result(5, 'b'),
    assistant(6, [{ type: 'text', text: 'done' }]),
  ];
  assert.equal(describeForkPoint(entries, '2').at, 5);
  assert.equal(describeForkPoint(entries, '6').at, 6);
});

test('describeForkPoint does not pull a visible message in to finish a tool call', () => {
  const entries = [
    user(1, 'hi'),
    assistant(2, [{ type: 'text', text: 'working' }, call('a')]),
    user(3, 'one more thing'),
    result(4, 'a'),
  ];
  assert.equal(describeForkPoint(entries, '2').at, 2);
  const before = describeForkPoint(entries, '3');
  assert.equal(before.kind, 'user');
  assert.equal(before.at, 2);
});
