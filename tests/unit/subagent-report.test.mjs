import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import {
  formatSubagentReport,
  parseSubagentReport,
  isSubagentReportText,
} from '../../src/kernel/subagent-report.mjs';
import {
  formatSubagentReport as formatFromPublic,
  parseSubagentReport as parseFromPublic,
  isSubagentReportText as isReportFromPublic,
} from '../../public/subagent-report.js';
import { isPromptUserMessage } from '../../public/continuation.js';
import { applyMessageDone } from '../../public/stream.js';

test('format and parse round-trip answered, failed, spaced names, and multiline bodies', () => {
  const answered = formatSubagentReport({
    name: 'a',
    kind: 'answered',
    body: 'SCOUT_PONG',
  });
  assert.equal(answered, '[subagent a answered, no reply needed] SCOUT_PONG');
  assert.deepEqual(parseSubagentReport(answered), {
    name: 'a',
    kind: 'answered',
    body: 'SCOUT_PONG',
  });

  const failed = formatSubagentReport({
    name: 'bg',
    kind: 'failed',
    body: 'timeout',
  });
  assert.equal(failed, '[subagent bg failed: timeout]');
  assert.deepEqual(parseSubagentReport(failed), {
    name: 'bg',
    kind: 'failed',
    body: 'timeout',
  });

  const spaced = formatSubagentReport({
    name: 'code review',
    kind: 'answered',
    body: 'looks good',
  });
  assert.equal(spaced, '[subagent code review answered, no reply needed] looks good');
  assert.deepEqual(parseSubagentReport(spaced), {
    name: 'code review',
    kind: 'answered',
    body: 'looks good',
  });

  const multiline = formatSubagentReport({
    name: 'scout',
    kind: 'answered',
    body: 'line one\nline two\n\nline four',
  });
  assert.equal(
    multiline,
    '[subagent scout answered, no reply needed] line one\nline two\n\nline four',
  );
  assert.deepEqual(parseSubagentReport(multiline), {
    name: 'scout',
    kind: 'answered',
    body: 'line one\nline two\n\nline four',
  });

  const failedSpaced = formatSubagentReport({
    name: 'code review',
    kind: 'failed',
    body: 'no conversation',
  });
  assert.deepEqual(parseSubagentReport(failedSpaced), {
    name: 'code review',
    kind: 'failed',
    body: 'no conversation',
  });

  assert.equal(isSubagentReportText(answered), true);
  assert.equal(isSubagentReportText(failed), true);
  assert.equal(isSubagentReportText('hello'), false);
  assert.equal(isSubagentReportText('[auto-continue] more'), false);
  assert.equal(parseSubagentReport('please look at this'), null);
});

test('legacy stored report text still parses', () => {
  assert.deepEqual(
    parseSubagentReport('[subagent a answered, no reply needed] SCOUT_PONG'),
    { name: 'a', kind: 'answered', body: 'SCOUT_PONG' },
  );
  assert.deepEqual(
    parseSubagentReport('[subagent scout failed: cancelled]'),
    { name: 'scout', kind: 'failed', body: 'cancelled' },
  );
});

test('kernel and public modules share the same format helpers', () => {
  const args = { name: 'a', kind: 'answered', body: 'ok' };
  assert.equal(formatSubagentReport(args), formatFromPublic(args));
  assert.deepEqual(
    parseSubagentReport(formatSubagentReport(args)),
    parseFromPublic(formatFromPublic(args)),
  );
  assert.equal(isSubagentReportText('[subagent a failed: x]'), isReportFromPublic('[subagent a failed: x]'));
});

test('isPromptUserMessage is false for subagent reports', () => {
  const answered = formatSubagentReport({ name: 'a', kind: 'answered', body: 'done' });
  const failed = formatSubagentReport({ name: 'a', kind: 'failed', body: 'timeout' });
  assert.equal(isPromptUserMessage({ role: 'user', text: answered }), false);
  assert.equal(isPromptUserMessage({ role: 'user', text: failed }), false);
  assert.equal(isPromptUserMessage({ role: 'user', kind: 'subagent-report', text: 'anything' }), false);
  assert.equal(isPromptUserMessage({ role: 'user', text: 'hello' }), true);
  assert.equal(isPromptUserMessage({ role: 'assistant', text: answered }), false);
});

test('transcript snapshots tag subagent-report kind', () => {
  const answered = formatSubagentReport({ name: 'scout', kind: 'answered', body: 'BG_ANSWER' });
  const failed = formatSubagentReport({ name: 'scout', kind: 'failed', body: 'timeout' });
  const { messages } = messagesFromEntries([
    {
      id: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: 'run' }] }],
    },
    {
      id: 2,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: answered }] }],
    },
    {
      id: 3,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: failed }] }],
    },
  ]);
  assert.equal(Object.hasOwn(messages.find((message) => message.id === '1'), 'kind'), false);
  assert.equal(messages.find((message) => message.id === '2').kind, 'subagent-report');
  assert.equal(messages.find((message) => message.id === '3').kind, 'subagent-report');
});

test('message.done inserts a subagent-report user row for the live thread', () => {
  const report = formatSubagentReport({ name: 'a', kind: 'answered', body: 'SCOUT_PONG' });
  const msgs = [
    { id: '1', role: 'user', text: 'run background' },
    { id: '2', role: 'assistant', text: 'spawned', done: true },
  ];
  applyMessageDone(msgs, {
    messageId: '3',
    role: 'user',
    text: report,
    kind: 'subagent-report',
  });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].kind, 'subagent-report');
  assert.equal(msgs[2].text, report);
  assert.equal(isPromptUserMessage(msgs[2]), false);
});
