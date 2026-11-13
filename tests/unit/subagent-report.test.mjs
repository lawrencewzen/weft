import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import * as reportModule from '../../src/kernel/subagent-report.mjs';
import * as reportTextModule from '../../src/kernel/subagent-report-text.mjs';
import {
  formatSubagentReport,
  parseSubagentReport,
  isSubagentReportText,
} from '../../src/kernel/subagent-report.mjs';
import {
  formatSubagentReport as formatFromText,
  parseSubagentReport as parseFromText,
  isSubagentReportText as isReportFromText,
} from '../../src/kernel/subagent-report-text.mjs';
import { isPromptUserMessage } from '../../src/kernel/continuation-text.mjs';

test('format and parse round-trip completed, failed, stopped, empty, and multiline bodies', () => {
  const answered = formatSubagentReport({
    name: 'fix-login-test',
    kind: 'answered',
    body: 'SCOUT_PONG',
  });
  assert.equal(answered, '[task fix-login-test completed, no reply needed] SCOUT_PONG');
  assert.deepEqual(parseSubagentReport(answered), {
    name: 'fix-login-test',
    kind: 'answered',
    body: 'SCOUT_PONG',
  });

  const emptyBody = formatSubagentReport({
    name: 'empty-run',
    kind: 'answered',
    body: '',
  });
  assert.equal(emptyBody, '[task empty-run completed, no reply needed]');
  assert.deepEqual(parseSubagentReport(emptyBody), {
    name: 'empty-run',
    kind: 'answered',
    body: '',
  });

  const failed = formatSubagentReport({
    name: 'bg',
    kind: 'failed',
    body: 'timeout',
  });
  assert.equal(failed, '[task bg failed: timeout]');
  assert.deepEqual(parseSubagentReport(failed), {
    name: 'bg',
    kind: 'failed',
    body: 'timeout',
  });

  const stopped = formatSubagentReport({
    name: 'bg',
    kind: 'stopped',
  });
  assert.equal(stopped, '[task bg stopped]');
  assert.deepEqual(parseSubagentReport(stopped), {
    name: 'bg',
    kind: 'stopped',
    body: '',
  });

  const multiline = formatSubagentReport({
    name: 'scout',
    kind: 'answered',
    body: 'line one\nline two\n\nline four',
  });
  assert.equal(
    multiline,
    '[task scout completed, no reply needed] line one\nline two\n\nline four',
  );
  assert.deepEqual(parseSubagentReport(multiline), {
    name: 'scout',
    kind: 'answered',
    body: 'line one\nline two\n\nline four',
  });

  const failedMultiline = formatSubagentReport({
    name: 'scout',
    kind: 'failed',
    body: 'err line 1\nerr line 2',
  });
  assert.deepEqual(parseSubagentReport(failedMultiline), {
    name: 'scout',
    kind: 'failed',
    body: 'err line 1\nerr line 2',
  });

  assert.equal(isSubagentReportText(answered), true);
  assert.equal(isSubagentReportText(emptyBody), true);
  assert.equal(isSubagentReportText(failed), true);
  assert.equal(isSubagentReportText(stopped), true);
  assert.equal(isSubagentReportText('hello'), false);
  assert.equal(isSubagentReportText('[auto-continue] more'), false);
  assert.equal(parseSubagentReport('please look at this'), null);
});

test('legacy [subagent ...] format and parseSubagentOutcome are completely removed', () => {
  assert.equal(Object.hasOwn(reportModule, 'parseSubagentOutcome'), false);
  assert.equal(Object.hasOwn(reportTextModule, 'parseSubagentOutcome'), false);
  assert.equal(parseSubagentReport('[subagent a answered, no reply needed] SCOUT_PONG'), null);
  assert.equal(parseSubagentReport('[subagent scout failed: cancelled]'), null);
});

test('kernel and text modules share the same format helpers', () => {
  const args = { name: 'a', kind: 'answered', body: 'ok' };
  assert.equal(formatSubagentReport(args), formatFromText(args));
  assert.deepEqual(
    parseSubagentReport(formatSubagentReport(args)),
    parseFromText(formatFromText(args)),
  );
  assert.equal(isSubagentReportText('[task a failed: x]'), isReportFromText('[task a failed: x]'));
});

test('isPromptUserMessage is false for task reports', () => {
  const answered = formatSubagentReport({ name: 'a', kind: 'answered', body: 'done' });
  const failed = formatSubagentReport({ name: 'a', kind: 'failed', body: 'timeout' });
  const stopped = formatSubagentReport({ name: 'a', kind: 'stopped' });
  assert.equal(isPromptUserMessage({ role: 'user', text: answered }), false);
  assert.equal(isPromptUserMessage({ role: 'user', text: failed }), false);
  assert.equal(isPromptUserMessage({ role: 'user', text: stopped }), false);
  assert.equal(isPromptUserMessage({ role: 'user', kind: 'subagent-report', text: 'anything' }), false);
  assert.equal(isPromptUserMessage({ role: 'user', text: 'hello' }), true);
  assert.equal(isPromptUserMessage({ role: 'assistant', text: answered }), false);
});

test('transcript snapshots tag subagent-report kind for task reports', () => {
  const answered = formatSubagentReport({ name: 'scout', kind: 'answered', body: 'BG_ANSWER' });
  const failed = formatSubagentReport({ name: 'scout', kind: 'failed', body: 'timeout' });
  const stopped = formatSubagentReport({ name: 'scout', kind: 'stopped' });
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
    {
      id: 4,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: stopped }] }],
    },
  ]);
  assert.equal(Object.hasOwn(messages.find((message) => message.id === '1'), 'kind'), false);
  assert.equal(messages.find((message) => message.id === '2').kind, 'subagent-report');
  assert.equal(messages.find((message) => message.id === '3').kind, 'subagent-report');
  assert.equal(messages.find((message) => message.id === '4').kind, 'subagent-report');
});
