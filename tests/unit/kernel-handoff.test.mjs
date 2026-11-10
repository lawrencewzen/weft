import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMapContext,
  createViewProjector,
  messagesFromEntries,
  projectViewUpdate,
} from '../../src/kernel/events.mjs';
import { HANDOFF_REQUEST_KIND, HANDOFF_TOOL_DESCRIPTION } from '../../src/kernel/handoff.mjs';
import { CHILD_HIDDEN_TOOLS, createSubagentHost } from '../../src/kernel/subagents.mjs';
import { workspaceTools } from '../../src/kernel/tools.mjs';
import { phrase } from '../../src/v2/phrases/index.ts';
import { runStateView } from '../../src/v2/views/run.ts';
import { buildThread } from '../../src/v2/views/thread.ts';
import { compileSchema } from '../../src/v2/validate.ts';
import { ROOT } from './_root.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validateThreadItem = compileSchema(structuredClone(spec.components.schemas.ThreadItem));
const validateToolCall = compileSchema(structuredClone(spec.components.schemas.ToolCall));
const validateRun = compileSchema(structuredClone(spec.components.schemas.RunState));

function handoffTool() {
  return workspaceTools().find((tool) => tool.name === 'handoff');
}

test('handoff tool returns control.handoff and refuses an empty note', async () => {
  const tool = handoffTool();
  assert.ok(tool);
  assert.equal(tool.replay, 'unsafe');
  assert.match(HANDOFF_TOOL_DESCRIPTION, /compaction/);
  assert.match(HANDOFF_TOOL_DESCRIPTION, /压缩/);
  assert.match(tool.description, /新上下文/);

  const note = '当前任务：迁移 packages/core。下一步：跑验证。';
  const result = await tool.execute({ text: `  ${note}  `, description: '交接' }, {}, {});
  assert.equal(result.isError, undefined);
  assert.equal(result.control.handoff, note);
  assert.equal(result.output[0].text.length > 0, true);

  const empty = await tool.execute({ text: '   ' }, {}, {});
  assert.equal(empty.isError, true);
  assert.equal(empty.control, undefined);
});

test('pi.reset maps to a stable handoff divider and the request stays hidden', async () => {
  const prompt = '开启新上下文。交接说明要侧重这些内容：packages/server 的配置';
  const note = '迁移进度。重点：packages/server 的配置。';
  const entries = [
    {
      id: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: '开始迁移' }],
    },
    {
      id: 2,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: '先列出模块' }], stopReason: 'stop' }],
    },
    {
      id: 3,
      kind: HANDOFF_REQUEST_KIND,
      model: [{ role: 'user', content: prompt }],
      data: { instructions: 'packages/server 的配置' },
    },
    {
      id: 4,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-h', name: 'handoff', arguments: { text: note } }],
        stopReason: 'toolUse',
      }],
    },
    {
      id: 5,
      kind: 'pi.tool-result',
      model: [{
        role: 'toolResult',
        toolCallId: 'call-h',
        toolName: 'handoff',
        content: [{ type: 'text', text: 'Handed off to a new context.' }],
        isError: false,
      }],
    },
    {
      id: 9,
      kind: 'pi.reset',
      head: 'self',
      model: [{ role: 'user', content: note }],
    },
    {
      id: 10,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: '继续验证配置' }], stopReason: 'stop' }],
    },
  ];
  const { messages } = messagesFromEntries(entries);
  assert.equal(JSON.stringify(messages).includes(prompt), false);
  assert.deepEqual(messages.map((message) => ({
    id: message.id,
    role: message.role,
    kind: message.kind || '',
    text: message.text || '',
  })), [
    { id: '1', role: 'user', kind: '', text: '开始迁移' },
    { id: '2', role: 'assistant', kind: '', text: '先列出模块' },
    { id: '5', role: 'tool', kind: '', text: 'Handed off to a new context.' },
    { id: '9', role: 'note', kind: 'handoff', text: note },
    { id: '10', role: 'assistant', kind: '', text: '继续验证配置' },
  ]);

  const thread = await buildThread(messages, { lang: 'zh' });
  const divider = thread.items.find((item) => item.kind === 'system_note' && item.noteKind === 'handoff');
  assert.ok(divider);
  assert.equal(divider.id, '9');
  assert.equal(divider.text, phrase('zh', 'handoff_new_context'));
  assert.equal(divider.detail, note);
  const handoffCall = thread.tools.find((tool) => tool.kind === 'handoff');
  assert.ok(handoffCall);
  assert.equal(handoffCall.id, 'call-h');
  const dividerAt = thread.items.findIndex((item) => item.id === '9');
  const replyAt = thread.items.findIndex((item) => item.kind === 'assistant' && item.text === '继续验证配置');
  assert.equal(replyAt > dividerAt, true);
  assert.equal(thread.items.some((item) => item.kind === 'user' && String(item.text).includes('开启新上下文')), false);
  for (const item of thread.items) {
    assert.equal(validateThreadItem(item), true, JSON.stringify(validateThreadItem.errors));
  }
  for (const tool of thread.tools) {
    assert.equal(validateToolCall(tool), true, JSON.stringify(validateToolCall.errors));
  }

  const en = await buildThread(messages, { lang: 'en' });
  const enDivider = en.items.find((item) => item.noteKind === 'handoff');
  assert.equal(enDivider.text, phrase('en', 'handoff_new_context'));
  assert.equal(enDivider.detail, note);

  const projector = createViewProjector();
  const ctx = createMapContext();
  projectViewUpdate(projector, { entries: entries.slice(0, 5), docs: {} }, ctx);
  const next = projectViewUpdate(projector, { entries, docs: {} }, ctx);
  assert.equal(next.events.some((event) => event.event === 'handoff' && event.data.entryId === '9'), true);
  assert.equal(next.events.some((event) => (
    event.event === 'message.done' && String(event.data?.text || '').includes(note)
  )), false);
});

test('a child agent tool list drops handoff', async () => {
  assert.equal(CHILD_HIDDEN_TOOLS.has('handoff'), true);
  assert.equal(CHILD_HIDDEN_TOOLS.has('read'), false);
  const host = createSubagentHost({
    store: {},
    harness: {},
    context: {},
    readTranscript: async () => ({ messages: [], entries: [] }),
  });
  const prepared = await host.prepareChild({
    cwd: '/tmp/ws',
    tools: [
      { name: 'read' },
      { name: 'handoff' },
      { name: 'bash' },
      { name: 'delegate' },
      { name: 'ask_user_question' },
      { name: 'skill' },
    ],
  });
  assert.deepEqual(prepared.change.tools.map((tool) => tool.name), ['read', 'bash']);
});

test('RunState.handoff is running only while a handoff submission is in flight', () => {
  const running = runStateView({ status: 'running', lang: 'zh', handoffRunning: true, hasWorkspace: true });
  assert.equal(validateRun(running), true, JSON.stringify(validateRun.errors));
  assert.deepEqual(running.handoff, { state: 'running' });
  assert.equal(running.pendingText, phrase('zh', 'pending_handoff'));

  const idle = runStateView({ status: 'idle', lang: 'zh', handoffRunning: true });
  assert.equal(idle.handoff, null);
  assert.equal(idle.pendingText, null);

  const thinking = runStateView({ status: 'running', lang: 'en', hasWorkspace: true });
  assert.equal(thinking.handoff, null);
  assert.equal(thinking.pendingText, phrase('en', 'pending_thinking'));
});
