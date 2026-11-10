import { describe, expect, it } from 'vitest';
import type { Schedule } from '../../data/api';
import {
  formatConversationScheduleStripText,
  formatRule,
  formatScheduleTimeToast,
  formatTarget,
} from './formatRule';

describe('formatTarget', () => {
  it('formats conversation target in zh and en', () => {
    expect(formatTarget({ kind: 'conversation', conversationId: 'c1', title: '修复登录' }, 'zh')).toBe('发到：修复登录');
    expect(formatTarget({ kind: 'conversation', conversationId: 'c1', title: 'Fix login' }, 'en')).toBe('To: Fix login');
  });

  it('formats new chat target in zh and en', () => {
    expect(formatTarget({ kind: 'new', workspaceId: 'w1', workspaceName: 'weft', model: null }, 'zh')).toBe('weft · 每次新开对话');
    expect(formatTarget({ kind: 'new', workspaceId: 'w1', workspaceName: 'weft', model: null }, 'en')).toBe('weft · New chat each time');
  });
});

describe('formatRule', () => {
  it('formats once rule', () => {
    // 2026-11-10 14:00:00 local time
    const d = new Date(2026, 10, 10, 14, 0, 0);
    expect(formatRule({ kind: 'once', at: d.getTime() }, 'zh')).toBe('11月10日 14:00 一次');
    expect(formatRule({ kind: 'once', at: d.getTime() }, 'en')).toBe('Nov 10, 14:00 once');
  });

  it('formats daily rule', () => {
    expect(formatRule({ kind: 'daily', time: '09:00' }, 'zh')).toBe('每天 09:00');
    expect(formatRule({ kind: 'daily', time: '09:00' }, 'en')).toBe('Daily at 09:00');
  });

  it('formats weekly weekdays rule', () => {
    expect(formatRule({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, 'zh')).toBe('每个工作日 09:00');
    expect(formatRule({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, 'en')).toBe('Every weekday at 09:00');
  });

  it('formats weekly weekends rule', () => {
    expect(formatRule({ kind: 'weekly', days: [6, 7], time: '10:30' }, 'zh')).toBe('每个周末 10:30');
    expect(formatRule({ kind: 'weekly', days: [6, 7], time: '10:30' }, 'en')).toBe('Every weekend at 10:30');
  });

  it('formats weekly custom days rule', () => {
    expect(formatRule({ kind: 'weekly', days: [1, 3, 5], time: '09:00' }, 'zh')).toBe('每周一、三、五 09:00');
    expect(formatRule({ kind: 'weekly', days: [1, 3, 5], time: '09:00' }, 'en')).toBe('Every Mon, Wed, Fri at 09:00');
  });

  it('formats interval rule with minutes and hours', () => {
    expect(formatRule({ kind: 'interval', everyMinutes: 30 }, 'zh')).toBe('每 30 分钟');
    expect(formatRule({ kind: 'interval', everyMinutes: 30 }, 'en')).toBe('Every 30 minutes');
    expect(formatRule({ kind: 'interval', everyMinutes: 60 }, 'zh')).toBe('每 1 小时');
    expect(formatRule({ kind: 'interval', everyMinutes: 60 }, 'en')).toBe('Every 1 hour');
    expect(formatRule({ kind: 'interval', everyMinutes: 120 }, 'zh')).toBe('每 2 小时');
    expect(formatRule({ kind: 'interval', everyMinutes: 120 }, 'en')).toBe('Every 2 hours');
  });
});

describe('formatScheduleTimeToast', () => {
  it('formats today, tomorrow and later dates in zh and en', () => {
    const base = new Date(2026, 10, 10, 10, 0, 0).getTime();
    const todayTarget = new Date(2026, 10, 10, 15, 30, 0).getTime();
    const tomorrowTarget = new Date(2026, 10, 11, 9, 0, 0).getTime();
    const laterTarget = new Date(2026, 10, 20, 14, 0, 0).getTime();

    expect(formatScheduleTimeToast(todayTarget, 'zh', base)).toBe('今天 15:30');
    expect(formatScheduleTimeToast(todayTarget, 'en', base)).toBe('today at 15:30');

    expect(formatScheduleTimeToast(tomorrowTarget, 'zh', base)).toBe('明天 09:00');
    expect(formatScheduleTimeToast(tomorrowTarget, 'en', base)).toBe('tomorrow at 09:00');

    expect(formatScheduleTimeToast(laterTarget, 'zh', base)).toBe('11月20日 14:00');
    expect(formatScheduleTimeToast(laterTarget, 'en', base)).toBe('Nov 20 at 14:00');
  });
});

describe('formatConversationScheduleStripText', () => {
  const base = new Date(2026, 10, 10, 10, 0, 0).getTime();
  const tomorrowTarget = new Date(2026, 10, 11, 9, 0, 0).getTime();

  it('formats single once task', () => {
    const s1: Schedule = {
      id: 's1',
      name: '检查构建',
      message: '请检查昨天的构建情况',
      target: { kind: 'conversation', conversationId: 'c1', title: '对话' },
      rule: { kind: 'once', at: tomorrowTarget },
      enabled: true,
      createdBy: 'user',
      nextRunAt: tomorrowTarget,
      lastRun: null,
    };
    expect(formatConversationScheduleStripText([s1], 'zh', base)).toBe('已定时：明天 09:00 发送「请检查昨天的构建情况」');
    expect(formatConversationScheduleStripText([s1], 'en', base)).toBe('Scheduled: tomorrow at 09:00 send "请检查昨天的构建情况"');
  });

  it('formats single repeating task with rule summary', () => {
    const s2: Schedule = {
      id: 's2',
      name: '每日巡检',
      message: '开始每日巡检',
      target: { kind: 'conversation', conversationId: 'c1', title: '对话' },
      rule: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' },
      enabled: true,
      createdBy: 'agent',
      nextRunAt: tomorrowTarget,
      lastRun: null,
    };
    expect(formatConversationScheduleStripText([s2], 'zh', base)).toBe('已定时：每个工作日 09:00 发送「开始每日巡检」');
  });

  it('formats multiple tasks with count', () => {
    const s1: Schedule = {
      id: 's1',
      name: '检查构建',
      message: '请检查构建',
      target: { kind: 'conversation', conversationId: 'c1', title: '对话' },
      rule: { kind: 'once', at: tomorrowTarget },
      enabled: true,
      createdBy: 'user',
      nextRunAt: tomorrowTarget,
      lastRun: null,
    };
    const s2: Schedule = {
      id: 's2',
      name: '每日巡检',
      message: '每日巡检',
      target: { kind: 'conversation', conversationId: 'c1', title: '对话' },
      rule: { kind: 'daily', time: '18:00' },
      enabled: true,
      createdBy: 'user',
      nextRunAt: tomorrowTarget,
      lastRun: null,
    };
    expect(formatConversationScheduleStripText([s1, s2], 'zh', base)).toBe('已定时：明天 09:00 发送「请检查构建」等 2 条');
    expect(formatConversationScheduleStripText([s1, s2], 'en', base)).toBe('Scheduled: tomorrow at 09:00 send "请检查构建" and 1 more');
  });
});
