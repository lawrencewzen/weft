import { describe, expect, it } from 'vitest';
// The server's rule math must agree with what this UI previews and validates.
// @ts-expect-error plain JS module without types
import { nextRunTime, ruleProblems } from '../../../../src/core/schedule-time.mjs';
import { computeNextRunPreview, formatScheduleTimeToast } from './formatRule';
import { validateScheduleForm, type ScheduleFormData } from './scheduleValidation';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const WEEKDAY_ZH = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

type Rule = { kind: string; at?: number; time?: string; days?: number[]; everyMinutes?: number };

function formData(rule: Rule): ScheduleFormData {
  return {
    name: 'n',
    message: 'm',
    targetKind: 'conversation',
    conversationId: 'c',
    conversationTitle: 't',
    workspaceId: '',
    workspaceName: '',
    model: null,
    ruleKind: rule.kind as ScheduleFormData['ruleKind'],
    onceAt: rule.at ?? 0,
    dailyTime: rule.time ?? '09:00',
    weeklyDays: rule.days ?? [],
    weeklyTime: rule.time ?? '09:00',
    intervalValue: rule.everyMinutes ?? 5,
    intervalUnit: 'minutes',
  };
}

describe('server schedule math matches the UI', () => {
  it('next run agrees with the preview text', () => {
    const cases: Array<[Rule, number]> = [
      [{ kind: 'once', at: local(2026, 3, 12, 15, 45) }, local(2026, 3, 10, 8, 0)],
      [{ kind: 'daily', time: '09:00' }, local(2026, 3, 10, 8, 0)],
      [{ kind: 'daily', time: '09:00' }, local(2026, 3, 10, 9, 30)],
      [{ kind: 'daily', time: '00:05' }, local(2026, 1, 31, 23, 59)],
      [{ kind: 'weekly', days: [1, 3, 5], time: '07:30' }, local(2026, 3, 8, 10, 0)],
      [{ kind: 'weekly', days: [2], time: '18:00' }, local(2026, 3, 3, 18, 0)],
      [{ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, local(2026, 1, 30, 10, 0)],
      [{ kind: 'weekly', days: [6, 7], time: '10:00' }, local(2026, 12, 31, 10, 0)],
    ];
    for (const [rule, now] of cases) {
      const next = nextRunTime(rule, now) as number;
      expect(next, JSON.stringify(rule)).toBeTruthy();
      const toast = formatScheduleTimeToast(next, 'zh', now);
      const day = new Date(next).getDay() || 7;
      const expected = rule.kind === 'weekly' ? `下次运行：${toast} (${WEEKDAY_ZH[day]})` : `下次运行：${toast}`;
      expect(computeNextRunPreview(formData(rule), 'zh', now), JSON.stringify(rule)).toBe(expected);
    }
    const now = local(2026, 3, 10, 8, 0);
    const next = nextRunTime({ kind: 'interval', everyMinutes: 45 }, now) as number;
    const d = new Date(next);
    const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(computeNextRunPreview(formData({ kind: 'interval', everyMinutes: 45 }), 'zh', now)).toContain(clock);
  });

  it('validation agrees', () => {
    const web = (patch: Partial<ScheduleFormData>) => validateScheduleForm({ ...formData({ kind: 'interval', everyMinutes: 5 }), ...patch }, 'en');
    expect(web({ intervalValue: 4 }).valid).toBe(false);
    expect(web({ intervalValue: 5 }).valid).toBe(true);
    expect(web({ ruleKind: 'weekly', weeklyDays: [] }).valid).toBe(false);
    expect(ruleProblems({ kind: 'interval', everyMinutes: 4 }).length).toBe(1);
    expect(ruleProblems({ kind: 'interval', everyMinutes: 5 }).length).toBe(0);
    expect(ruleProblems({ kind: 'weekly', days: [], time: '09:00' }).length).toBe(1);
  });
});
