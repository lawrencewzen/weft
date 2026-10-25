import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compileSchema } from '../../src/v2/validate.ts';
import {
  DEFAULT_STUCK_AFTER_MS,
  isSubagentStuck,
  resolveStuckAfterMs,
  subagentSnapshot,
  subagentStatus,
  subagentSummary,
  subagentView,
} from '../../src/v2/views/subagents.ts';
import { ROOT } from './_root.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validateSubagent = compileSchema(structuredClone(spec.components.schemas.Subagent));
const validateSnapshot = compileSchema(structuredClone(spec.components.schemas.SubagentSnapshot));

function assertView(view, label) {
  assert.equal(validateSubagent(view), true, `${label}: ${JSON.stringify(validateSubagent.errors)}`);
}

const NOW = 1_700_000_000_000;

function agent(over = {}) {
  return {
    id: 'c1:sub:9',
    name: '巡查',
    status: 'running',
    mode: 'foreground',
    step: 2,
    totalSteps: 5,
    startedAt: NOW - 10_000,
    lastActivityAt: NOW - 2_000,
    ...over,
  };
}

test('title fallback: title → brief first line → lastText → name', () => {
  assert.equal(subagentSummary(agent({ title: '  写登录单测  ' })), '写登录单测');
  assert.equal(subagentSummary(agent({
    title: '',
    brief: '你在仓库里查看\n第二行不要',
    lastText: '旧的 lastText',
  })), '你在仓库里查看');
  assert.equal(subagentSummary(agent({
    title: '   ',
    brief: '\n\n',
    lastText: '  正在读文件  ',
  })), '正在读文件');
  assert.equal(subagentSummary(agent({
    title: '',
    brief: '',
    lastText: '',
    name: 'worker',
  })), 'worker');
  assert.equal(subagentSummary({ id: 'c1:sub:1' }), '');
});

test('status buckets: error→failed, recovering→running, stuck only when running past threshold', () => {
  assert.equal(subagentStatus(agent({ status: 'error' }), NOW), 'failed');
  assert.equal(subagentStatus(agent({ status: 'recovering' }), NOW), 'running');
  assert.equal(subagentStatus(agent({ status: 'resuming' }), NOW), 'running');
  assert.equal(subagentStatus(agent({ status: 'done' }), NOW), 'done');
  assert.equal(subagentStatus(agent({ status: 'stopped' }), NOW), 'stopped');
  assert.equal(subagentStatus(agent({ status: 'waiting' }), NOW), 'waiting');
  assert.equal(subagentStatus(agent({ status: 'failed' }), NOW), 'failed');

  const running = agent({ status: 'running', lastActivityAt: NOW - 61_000 });
  assert.equal(subagentStatus(running, NOW), 'stuck');
  assert.equal(subagentStatus(agent({ status: 'done', lastActivityAt: NOW - 120_000 }), NOW), 'done');
});

test('stuck boundary: 59s no, 60s no, 61s yes; missing lastActivityAt never stuck', () => {
  const base = { status: 'running' };
  assert.equal(isSubagentStuck(agent({ ...base, lastActivityAt: NOW - 59_000 }), NOW), false);
  assert.equal(isSubagentStuck(agent({ ...base, lastActivityAt: NOW - 60_000 }), NOW), false);
  assert.equal(isSubagentStuck(agent({ ...base, lastActivityAt: NOW - 61_000 }), NOW), true);
  assert.equal(isSubagentStuck(agent({ ...base, lastActivityAt: 0 }), NOW), false);
  assert.equal(isSubagentStuck(agent({ ...base, lastActivityAt: undefined }), NOW), false);
  assert.equal(DEFAULT_STUCK_AFTER_MS, 60_000);
  assert.equal(resolveStuckAfterMs({}), 60_000);
  assert.equal(resolveStuckAfterMs({ WEFT_SUBAGENT_STUCK_MS: '500' }), 500);
  assert.equal(resolveStuckAfterMs({ WEFT_SUBAGENT_STUCK_MS: 'nope' }), 60_000);
});

test('progress, mode, currentAction, timestamps', () => {
  const view = subagentView(agent({
    title: '写登录单测',
    currentAction: '正在读 auth.test.js',
    endedAt: NOW - 1,
  }), { parentConversationId: 'c1', now: NOW });
  assertView(view, 'full');
  assert.equal(view.parentConversationId, 'c1');
  assert.equal(view.title, '写登录单测');
  assert.equal(view.name, '巡查');
  assert.equal(view.mode, 'foreground');
  assert.equal(view.status, 'running');
  assert.deepEqual(view.progress, { step: 2, total: 5 });
  assert.equal(view.currentAction, '正在读 auth.test.js');
  assert.equal(view.startedAt, NOW - 10_000);
  assert.equal(view.lastActivityAt, NOW - 2_000);

  const stuck = subagentView(agent({
    lastActivityAt: NOW - 61_000,
    currentAction: '等待模型',
  }), { now: NOW });
  assertView(stuck, 'stuck');
  assert.equal(stuck.status, 'stuck');
  assert.equal(stuck.currentAction, '等待模型');

  const done = subagentView(agent({
    status: 'done',
    currentAction: '不应出现',
    endedAt: NOW - 100,
    step: 3,
    totalSteps: 3,
  }), { now: NOW });
  assertView(done, 'done');
  assert.equal(done.currentAction, null);
  assert.equal(done.endedAt, NOW - 100);
  assert.deepEqual(done.progress, { step: 3, total: 3 });

  const bare = subagentView({ id: 'c1:sub:2', status: 'waiting' }, { now: NOW });
  assertView(bare, 'bare');
  assert.equal(bare.mode, 'foreground');
  assert.equal(bare.progress, null);
  assert.equal(bare.startedAt, null);
  assert.equal(bare.lastActivityAt, null);
  assert.equal(bare.endedAt, null);
  assert.equal(bare.currentAction, null);
  assert.equal(bare.parentConversationId, 'c1');

  const bg = subagentView(agent({ mode: 'background' }), { now: NOW });
  assert.equal(bg.mode, 'background');
});

test('subagentSnapshot builds thread items from child messages without nested reports', async () => {
  const snap = await subagentSnapshot({
    presented: { id: 'c1', workspacePath: '' },
    agent: agent({ title: '巡查仓库' }),
    messages: [
      { id: 'u1', role: 'user', text: '请查看仓库' },
      { id: 'a1', role: 'assistant', text: '仓库干净' },
    ],
    lang: 'zh',
    now: NOW,
  });
  assert.equal(validateSnapshot(snap), true, JSON.stringify(validateSnapshot.errors));
  assert.equal(snap.subagent.title, '巡查仓库');
  assert.equal(snap.subagent.parentConversationId, 'c1');
  assert.deepEqual(snap.items.map((item) => item.kind), ['user', 'assistant']);
  assert.equal(snap.tools.length, 0);
});
