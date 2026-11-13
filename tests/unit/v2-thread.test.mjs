import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compileSchema } from '../../src/v2/validate.ts';
import { toolGroupKey } from '../../src/v2/views/tools.ts';
import {
  AUTO_CONTINUE_PREFIX,
  isAutoContinueText,
  isPromptUserMessage,
} from '../../src/v2/views/continuation.ts';
import {
  formatSubagentReport,
  parseSubagentReport,
  isSubagentReportText,
} from '../../src/v2/views/subagent-report.ts';
import {
  AUTO_CONTINUE_PREFIX as publicPrefix,
  isAutoContinueText as publicIsAuto,
  isPromptUserMessage as publicIsPrompt,
} from '../../src/kernel/continuation-text.mjs';
import { buildThread, findAgentForReport, lastVisibleAssistant } from '../../src/v2/views/thread.ts';
import { ROOT } from './_root.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validateThreadItem = compileSchema(structuredClone(spec.components.schemas.ThreadItem));
const validateToolCall = compileSchema(structuredClone(spec.components.schemas.ToolCall));

function assertValidThread(thread, label) {
  for (const [i, item] of thread.items.entries()) {
    assert.equal(validateThreadItem(item), true, `${label} item ${i} ${item.kind}: ${JSON.stringify(validateThreadItem.errors)}`);
  }
  for (const [i, tool] of thread.tools.entries()) {
    assert.equal(validateToolCall(tool), true, `${label} tool ${i}: ${JSON.stringify(validateToolCall.errors)}`);
  }
}

function tool(id, name, extra = {}) {
  return { id, name, status: extra.status || 'completed', ...extra };
}

function toolMsg(id, t) {
  return { id, role: 'tool', tool: t };
}

const none = () => false;

test('v2 subagent-report helpers format and parse task reports (answered, failed, stopped)', () => {
  const cases = [
    { name: 'a', kind: 'answered', body: 'SCOUT_PONG', expected: '[task a completed, no reply needed] SCOUT_PONG' },
    { name: 'bg', kind: 'failed', body: 'timeout', expected: '[task bg failed: timeout]' },
    { name: 'worker', kind: 'stopped', body: '', expected: '[task worker stopped]' },
    { name: 'code review', kind: 'answered', body: 'looks good', expected: '[task code review completed, no reply needed] looks good' },
    { name: 'scout', kind: 'answered', body: 'line one\nline two\n\nline four', expected: '[task scout completed, no reply needed] line one\nline two\n\nline four' },
    { name: 'code review', kind: 'failed', body: 'no conversation', expected: '[task code review failed: no conversation]' },
    { name: 'bare', kind: 'answered', body: '', expected: '[task bare completed, no reply needed]' },
  ];
  for (const { name, kind, body, expected } of cases) {
    const formatted = formatSubagentReport({ name, kind, body });
    assert.equal(formatted, expected);
    assert.deepEqual(parseSubagentReport(formatted), {
      name,
      kind,
      body: kind === 'stopped' ? '' : body,
    });
    assert.equal(isSubagentReportText(formatted), true);
  }
  assert.equal(isSubagentReportText('[task a failed: x]'), true);
  assert.equal(isSubagentReportText('[task a stopped]'), true);
  assert.equal(isSubagentReportText('[subagent a failed: x]'), false);
  assert.equal(isSubagentReportText('hello'), false);
  assert.equal(parseSubagentReport('please look at this'), null);
});

const LEGACY_AUTO = `${AUTO_CONTINUE_PREFIX} 上一条回复因输出长度上限被截断`;

test('v2 continuation helpers match the kernel implementation', () => {
  assert.equal(AUTO_CONTINUE_PREFIX, publicPrefix);
  const texts = ['hello', `${AUTO_CONTINUE_PREFIX} more`, LEGACY_AUTO, ''];
  for (const text of texts) {
    assert.equal(isAutoContinueText(text), publicIsAuto(text));
  }
  assert.equal(isPromptUserMessage({ role: 'user', text: 'hello' }), true);
  assert.equal(isPromptUserMessage({ role: 'user', text: LEGACY_AUTO }), false);
  assert.equal(isPromptUserMessage({ role: 'user', kind: 'auto-continue', text: 'x' }), false);
  assert.equal(isPromptUserMessage({ role: 'user', kind: 'subagent-report', text: 'anything' }), false);
  assert.equal(isPromptUserMessage({ role: 'user', text: formatSubagentReport({ name: 'a', kind: 'answered', body: 'done' }) }), false);
  assert.equal(isPromptUserMessage({ role: 'user', text: formatSubagentReport({ name: 'a', kind: 'failed', body: 'err' }) }), false);
  assert.equal(isPromptUserMessage({ role: 'user', text: formatSubagentReport({ name: 'a', kind: 'stopped' }) }), false);
  assert.equal(isPromptUserMessage({ role: 'assistant', text: 'hello' }), false);
  assert.equal(isPromptUserMessage(null), false);
});

test('each ThreadItem kind is produced and contract-valid', async () => {
  const answered = formatSubagentReport({ name: 'scout', kind: 'answered', body: 'done' });
  const thread = await buildThread([
    { id: 'u1', role: 'user', text: 'see `src/a.ts`' },
    { id: 'a1', role: 'assistant', text: 'ok `src/a.ts:12`', model: 'grok-build' },
    toolMsg('t1', tool('c1', 'read', { path: 'src/a.ts' })),
    { id: 'r1', role: 'user', text: answered },
    { id: 'n1', role: 'note', text: 'parent pinged the child' },
    { id: 'c1', role: 'assistant', kind: 'correction', text: 'handoff' },
    { id: 'ac1', role: 'user', kind: 'auto-continue', text: LEGACY_AUTO },
  ], {
    lang: 'zh',
    workspacePath: '/ws',
    exists: (rel) => rel === 'src/a.ts',
    subagents: [{ id: 'conv:sub:9', name: 'scout', status: 'done' }],
  });
  assertValidThread(thread, 'all-kinds');
  assert.deepEqual(thread.items.map((item) => item.kind), [
    'user', 'assistant', 'tool_group', 'subagent_report', 'system_note', 'system_note',
  ]);
  assert.equal(thread.items.some((item) => item.id === 'ac1'), false);
  assert.equal(thread.items[0].pathRefs[0].path, 'src/a.ts');
  assert.equal(thread.items[0].entryId, 'u1');
  assert.equal(thread.items[1].model, 'grok-build');
  assert.equal(thread.items[1].entryId, 'a1');
  assert.equal(thread.items[1].streaming, false);
  assert.equal(thread.items[1].truncated, false);
  assert.equal(thread.items[1].pathRefs[0].line, 12);
  assert.equal(thread.items[2].id, toolGroupKey([tool('c1', 'read', { path: 'src/a.ts' })]));
  assert.deepEqual(thread.items[2].toolIds, ['c1']);
  assert.equal(thread.items[2].live, false);
  assert.equal(thread.items[3].subagentId, 'conv:sub:9');
  assert.equal(thread.items[3].reportKind, 'answered');
  assert.equal(thread.items[3].name, 'scout');
  assert.equal(thread.items[4].noteKind, 'note');
  assert.equal(thread.items[5].noteKind, 'correction');
  assert.equal(thread.tools.length, 1);
  assert.equal(thread.tools[0].id, 'c1');
});

test('consecutive tools form one group; a normal message splits them', async () => {
  const a = tool('r1', 'read', { path: 'a.js' });
  const b = tool('r2', 'read', { path: 'b.js' });
  const c = tool('r3', 'ls', { path: 'src' });
  const together = await buildThread([
    { id: 'u1', role: 'user', text: 'go' },
    toolMsg('t1', a),
    toolMsg('t2', b),
    { id: 'a1', role: 'assistant', text: 'mid' },
    toolMsg('t3', c),
  ], { exists: none });
  assertValidThread(together, 'split-groups');
  const groups = together.items.filter((item) => item.kind === 'tool_group');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].toolIds, ['r1', 'r2']);
  assert.deepEqual(groups[1].toolIds, ['r3']);
  assert.equal(groups[0].id, toolGroupKey([a, b]));
  assert.equal(groups[1].id, toolGroupKey([c]));
  assert.equal(together.tools.length, 3);

  const one = await buildThread([
    toolMsg('t1', a),
    toolMsg('t2', b),
    toolMsg('t3', c),
  ], { exists: none });
  assertValidThread(one, 'one-group');
  assert.equal(one.items.length, 1);
  assert.equal(one.items[0].kind, 'tool_group');
  assert.deepEqual(one.items[0].toolIds, ['r1', 'r2', 'r3']);
});

test('empty assistant is skipped and does not split a tool group', async () => {
  const thread = await buildThread([
    { id: 'u1', role: 'user', text: 'go' },
    toolMsg('t1', tool('r1', 'read', { path: 'a.js' })),
    { id: 'empty', role: 'assistant', text: '   ' },
    { id: 'blank', role: 'assistant', text: '' },
    toolMsg('t2', tool('r2', 'read', { path: 'b.js' })),
    { id: 'a1', role: 'assistant', text: 'done' },
  ], { exists: none });
  assertValidThread(thread, 'skip-empty');
  assert.deepEqual(thread.items.map((item) => item.kind), ['user', 'tool_group', 'assistant']);
  assert.deepEqual(thread.items[1].toolIds, ['r1', 'r2']);
  assert.equal(thread.items.some((item) => item.id === 'empty' || item.id === 'blank'), false);
});

test('only the last visible length reply is truncated', async () => {
  const thread = await buildThread([
    { id: 'a1', role: 'assistant', text: 'first', stopReason: 'length' },
    { id: 'u1', role: 'user', text: 'more' },
    { id: 'a2', role: 'assistant', text: 'second', stopReason: 'length' },
    { id: 'a3', role: 'assistant', text: '   ' },
    { id: 'n1', role: 'note', text: 'aside' },
  ], { exists: none });
  assertValidThread(thread, 'truncated');
  const assistants = thread.items.filter((item) => item.kind === 'assistant');
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].id, 'a1');
  assert.equal(assistants[0].truncated, false);
  assert.equal(assistants[1].id, 'a2');
  assert.equal(assistants[1].truncated, true);
  assert.equal(assistants[1].streaming, false);
  assert.equal(lastVisibleAssistant([
    { id: 'a2', role: 'assistant', text: 'second', stopReason: 'length' },
    { id: 'a3', role: 'assistant', text: '   ' },
  ]).id, 'a2');
});

test('user images copy onto the thread item as metadata without base64', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const thread = await buildThread([
    {
      id: 'u-img',
      role: 'user',
      text: '看图',
      images: [{ mediaType: 'image/png', data: png, name: 'shot.png' }],
    },
    { id: 'u-only', role: 'user', text: '', images: [{ mediaType: 'image/jpeg', data: png }] },
  ], { exists: none, conversationId: 'c1' });
  assertValidThread(thread, 'user-images');
  const dump = JSON.stringify(thread);
  assert.equal(dump.includes(png), false);
  assert.equal(thread.items[0].kind, 'user');
  assert.equal(thread.items[0].images[0].name, 'shot.png');
  assert.equal(thread.items[0].images[0].index, 0);
  assert.equal(thread.items[0].images[0].url, '/api/v2/conversations/c1/messages/u-img/images/0');
  assert.equal(Object.hasOwn(thread.items[0].images[0], 'data'), false);
  assert.equal(thread.items[1].kind, 'user');
  assert.equal(thread.items[1].text, '');
  assert.equal(thread.items[1].images.length, 1);
  assert.equal(thread.items[1].images[0].url, '/api/v2/conversations/c1/messages/u-only/images/0');
});

test('user pastes and files copy onto the thread item without paste bodies', async () => {
  const long = Array.from({ length: 12 }, (_, i) => `keep-${i + 1}`).join('\n');
  const thread = await buildThread([
    {
      id: 'u-attach',
      role: 'user',
      text: '正文',
      pastes: [{ lines: 12, chars: long.length, preview: long.split('\n').slice(0, 8).join('\n') }],
      files: [{ path: '.weft/uploads/stamp/a.txt', name: 'a.txt', bytes: 4 }],
    },
  ], { exists: none, conversationId: 'c1' });
  assertValidThread(thread, 'user-attach');
  assert.equal(thread.items[0].kind, 'user');
  assert.equal(thread.items[0].text, '正文');
  assert.equal(thread.items[0].pastes[0].lines, 12);
  assert.equal(thread.items[0].files[0].path, '.weft/uploads/stamp/a.txt');
  assert.equal(JSON.stringify(thread).includes(long), false);
  assert.equal(JSON.stringify(thread).includes('keep-12'), false);
});

test('running marks only the last tool group live', async () => {
  const first = tool('r1', 'read', { path: 'a.js' });
  const last = tool('w1', 'write', { path: 'b.js', status: 'running' });
  const thread = await buildThread([
    toolMsg('t1', first),
    { id: 'a1', role: 'assistant', text: 'mid' },
    toolMsg('t2', last),
  ], { exists: none, running: true });
  assertValidThread(thread, 'live-tail');
  const groups = thread.items.filter((item) => item.kind === 'tool_group');
  assert.equal(groups[0].live, false);
  assert.equal(groups[1].live, true);
  const idle = await buildThread([
    toolMsg('t2', last),
  ], { exists: none, running: false });
  assert.equal(idle.items[0].live, false);
});

test('subagent report finds the child by name, or null when missing, and handles stopped', async () => {
  const answered = formatSubagentReport({ name: 'scout', kind: 'answered', body: 'ok' });
  const failed = formatSubagentReport({ name: 'missing', kind: 'failed', body: 'timeout' });
  const stopped = formatSubagentReport({ name: 'scout', kind: 'stopped' });
  const tagged = { id: 'r4', role: 'user', kind: 'subagent-report', text: 'raw body' };
  const agents = [
    { id: 'conv:agent:0', name: 'scout', status: 'done' },
    { id: 'conv:sub:9', name: 'scout', status: 'done' },
  ];
  const thread = await buildThread([
    { id: 'r1', role: 'user', text: answered },
    { id: 'r2', role: 'user', text: failed },
    { id: 'r3', role: 'user', text: stopped },
    tagged,
  ], { exists: none, subagents: agents });
  assertValidThread(thread, 'reports');
  assert.equal(thread.items[0].subagentId, 'conv:sub:9');
  assert.equal(thread.items[0].reportKind, 'answered');
  assert.equal(thread.items[1].subagentId, null);
  assert.equal(thread.items[1].reportKind, 'failed');
  assert.equal(thread.items[1].name, 'missing');
  assert.equal(thread.items[2].subagentId, 'conv:sub:9');
  assert.equal(thread.items[2].reportKind, 'stopped');
  assert.equal(thread.items[2].name, 'scout');
  assert.equal(thread.items[3].kind, 'subagent_report');
  assert.equal(thread.items[3].subagentId, null);
  assert.equal(thread.items[3].name, '');
  assert.equal(thread.items[3].body, 'raw body');
  assert.equal(findAgentForReport('scout', agents)?.id, 'conv:sub:9');
  assert.equal(findAgentForReport('scout', [{ id: 'conv:agent:0', name: 'scout' }]), null);
});

test('legacy auto-continue messages are omitted; correction and note stay', async () => {
  const thread = await buildThread([
    { id: 'ac', role: 'user', text: LEGACY_AUTO },
    { id: 'cor', role: 'assistant', kind: 'correction', text: 'switched model' },
    { id: 'note', role: 'note', text: '  pinged scout  ' },
    { id: 'empty-note', role: 'note', text: '  ' },
  ], { lang: 'en', exists: none });
  assertValidThread(thread, 'system-notes');
  assert.equal(thread.items.length, 2);
  assert.equal(thread.items.some((item) => item.id === 'ac'), false);
  assert.equal(thread.items.some((item) => item.text === LEGACY_AUTO), false);
  assert.equal(thread.items[0].noteKind, 'correction');
  assert.equal(thread.items[0].text, 'switched model');
  assert.equal(thread.items[1].noteKind, 'note');
  assert.equal(thread.items[1].text, 'pinged scout');
});

test('fork entryId is the harness id, and streaming or live placeholders are null', async () => {
  const thread = await buildThread([
    { id: '12', entryId: '12', role: 'user', text: 'hello' },
    { id: '13', entryId: '13', role: 'assistant', text: 'world' },
    { id: '14', entryId: '14', role: 'assistant', text: 'partial', streaming: true },
    { id: 'live-2', role: 'assistant', text: 'live tail' },
    { id: 'live:9', role: 'user', text: 'optimistic' },
  ], { exists: none });
  assertValidThread(thread, 'fork-entry');
  assert.equal(thread.items[0].kind, 'user');
  assert.equal(thread.items[0].entryId, '12');
  assert.equal(thread.items[1].kind, 'assistant');
  assert.equal(thread.items[1].entryId, '13');
  assert.equal(thread.items[1].streaming, false);
  assert.equal(thread.items[2].streaming, true);
  assert.equal(thread.items[2].entryId, null);
  assert.equal(thread.items[3].entryId, null);
  assert.equal(thread.items[4].entryId, null);
});
