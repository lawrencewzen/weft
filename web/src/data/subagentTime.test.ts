import { describe, expect, it } from 'vitest';
import {
  formatMmSs,
  progressLabel,
  stripActionMarks,
  subagentActionText,
  subagentTimeText,
  subagentTreeTimeText,
  subagentTreeVisual,
} from './subagentTime';
import type { Subagent } from './store';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

function agent(extra: Partial<Subagent>): Subagent {
  return {
    id: 'c:sub:a',
    parentConversationId: 'c',
    title: '写登录单测',
    name: '测试',
    mode: 'foreground',
    status: 'running',
    startedAt: NOW - 5_000,
    lastActivityAt: NOW - 2_000,
    endedAt: null,
    currentAction: null,
    progress: null,
    ...extra,
  };
}

describe('subagent time text', () => {
  it('shows zero-padded mm:ss from startedAt while running', () => {
    expect(formatMmSs(5_000)).toBe('00:05');
    expect(formatMmSs(65_000)).toBe('01:05');
    expect(subagentTimeText(agent({ status: 'running', startedAt: NOW - 5_000 }), 'zh', NOW)).toBe('00:05');
    expect(subagentTreeTimeText(agent({ status: 'running', startedAt: NOW - 5_000 }), 'zh', NOW)).toBe('00:05');
  });

  it('shows idle mm:ss when stuck', () => {
    const stuck = agent({
      status: 'stuck',
      startedAt: NOW - 90_000,
      lastActivityAt: NOW - 65_000,
    });
    expect(subagentTimeText(stuck, 'zh', NOW)).toBe('无动作 01:05');
    expect(subagentTimeText(stuck, 'en', NOW)).toBe('idle 01:05');
    expect(subagentTreeTimeText(stuck, 'zh', NOW)).toBe('静默 01:05');
    expect(subagentTreeTimeText(stuck, 'en', NOW)).toBe('silent 01:05');
  });

  it('shows terminal labels; tree hides 完成', () => {
    expect(subagentTimeText(agent({ status: 'done' }), 'zh', NOW)).toBe('完成');
    expect(subagentTimeText(agent({ status: 'done' }), 'en', NOW)).toBe('Done');
    expect(subagentTreeTimeText(agent({ status: 'done' }), 'zh', NOW)).toBe('');
    expect(subagentTimeText(agent({ status: 'stopped' }), 'zh', NOW)).toBe('已停止');
    expect(subagentTimeText(agent({ status: 'failed' }), 'zh', NOW)).toBe('失败');
    expect(subagentTreeTimeText(agent({ status: 'failed' }), 'zh', NOW)).toBe('失败');
  });

  it('maps tree visuals: waiting uses the running spinner, failed keeps the x', () => {
    expect(subagentTreeVisual('running')).toBe('running');
    expect(subagentTreeVisual('waiting')).toBe('running');
    expect(subagentTreeVisual('stuck')).toBe('stuck');
    expect(subagentTreeVisual('done')).toBe('done');
    expect(subagentTreeVisual('stopped')).toBe('stopped');
    expect(subagentTreeVisual('failed')).toBe('failed');
  });

  it('joins currentAction and progress while running', () => {
    expect(progressLabel({ step: 2, total: 5 })).toBe('2/5');
    expect(progressLabel({ step: 3, total: 0 })).toBe('3');
    expect(subagentActionText(agent({
      status: 'running',
      currentAction: '正在读 auth.test.js',
      progress: { step: 2, total: 5 },
    }))).toBe('正在读 auth.test.js · 2/5');
    expect(subagentActionText(agent({ status: 'done', currentAction: 'x', progress: { step: 1, total: 1 } }))).toBe('');
  });

  it('strips backticks from the current action so the tree does not show markup', () => {
    expect(stripActionMarks('正在读取 `web/src/data/store.ts`')).toBe('正在读取 web/src/data/store.ts');
    expect(subagentActionText(agent({
      status: 'running',
      currentAction: '正在读取 `src/workflow/index.ts`',
    }))).toBe('正在读取 src/workflow/index.ts');
  });
});
