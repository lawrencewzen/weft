import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanRule,
  nextRunTime,
  ruleProblems,
} from '../../src/core/schedule-time.mjs';
import {
  computeNextRunPreview,
  formatScheduleTimeToast,
} from '../../web/src/components/schedules/formatRule.ts';
import { validateScheduleForm } from '../../web/src/components/schedules/scheduleValidation.ts';

process.env.TZ = 'Asia/Shanghai';

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const stamp = (ts) => {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const WEEKDAY_ZH = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function formData(rule) {
  return {
    name: 'n',
    message: 'm',
    targetKind: 'conversation',
    conversationId: 'c',
    conversationTitle: 't',
    workspaceId: '',
    workspaceName: '',
    model: null,
    ruleKind: rule.kind,
    onceAt: rule.at ?? 0,
    dailyTime: rule.time ?? '09:00',
    weeklyDays: rule.days ?? [],
    weeklyTime: rule.time ?? '09:00',
    intervalValue: rule.everyMinutes ?? 5,
    intervalUnit: 'minutes',
  };
}

test('daily: today when still ahead, else tomorrow, across month and year ends', () => {
  const rule = { kind: 'daily', time: '09:00' };
  assert.equal(stamp(nextRunTime(rule, local(2026, 3, 10, 8, 0))), '2026-03-10 09:00');
  assert.equal(stamp(nextRunTime(rule, local(2026, 3, 10, 9, 0))), '2026-03-11 09:00');
  assert.equal(stamp(nextRunTime(rule, local(2026, 1, 31, 23, 50))), '2026-02-01 09:00');
  assert.equal(stamp(nextRunTime(rule, local(2026, 12, 31, 12, 0))), '2027-01-01 09:00');
  assert.equal(stamp(nextRunTime({ kind: 'daily', time: '00:30' }, local(2026, 2, 28, 23, 50))), '2026-03-01 00:30');
});

test('weekly: next chosen day, across the week boundary and month ends', () => {
  const mondayOnly = { kind: 'weekly', days: [1], time: '09:00' };
  // Sunday 2026-03-08 10:00 -> Monday 2026-03-09
  assert.equal(stamp(nextRunTime(mondayOnly, local(2026, 3, 8, 10, 0))), '2026-03-09 09:00');
  // Monday after the time -> next Monday
  assert.equal(stamp(nextRunTime(mondayOnly, local(2026, 3, 9, 9, 0))), '2026-03-16 09:00');
  const monWed = { kind: 'weekly', days: [3, 1], time: '08:00' };
  // Saturday 2026-01-31 -> Monday 2026-02-02
  assert.equal(stamp(nextRunTime(monWed, local(2026, 1, 31, 12, 0))), '2026-02-02 08:00');
  assert.equal(stamp(nextRunTime(monWed, local(2026, 2, 2, 8, 30))), '2026-02-04 08:00');
  // Sunday only, from Monday of the next month
  assert.equal(stamp(nextRunTime({ kind: 'weekly', days: [7], time: '23:59' }, local(2026, 3, 30, 0, 0))), '2026-04-05 23:59');
});

test('interval: from now, and anchored so a catch-up does not shift the cadence', () => {
  const rule = { kind: 'interval', everyMinutes: 30 };
  const from = local(2026, 3, 10, 11, 10);
  assert.equal(nextRunTime(rule, from), from + 30 * 60_000);
  const anchor = local(2026, 3, 10, 9, 0);
  assert.equal(stamp(nextRunTime(rule, from, { anchor })), '2026-03-10 11:30');
  assert.equal(stamp(nextRunTime(rule, local(2026, 3, 10, 11, 30), { anchor })), '2026-03-10 12:00');
  assert.equal(stamp(nextRunTime(rule, local(2026, 3, 13, 11, 31), { anchor })), '2026-03-13 12:00');
});

test('once: its time while ahead, then nothing', () => {
  const at = local(2026, 3, 10, 9, 0);
  assert.equal(nextRunTime({ kind: 'once', at }, at - 1), at);
  assert.equal(nextRunTime({ kind: 'once', at }, at), null);
});

test('daily across a daylight saving change keeps the wall clock time', () => {
  const before = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const rule = { kind: 'daily', time: '09:00' };
    const next = nextRunTime(rule, new Date(2026, 2, 7, 10, 0).getTime());
    const d = new Date(next);
    assert.deepEqual([d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2, 8, 9, 0]);
    const week = nextRunTime({ kind: 'weekly', days: [7], time: '09:00' }, new Date(2026, 2, 1, 10, 0).getTime());
    const w = new Date(week);
    assert.deepEqual([w.getMonth(), w.getDate(), w.getHours()], [2, 8, 9]);
  } finally {
    process.env.TZ = before;
  }
});

test('next run agrees with the web UI preview (formatRule.ts)', () => {
  const cases = [
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
    const next = nextRunTime(rule, now);
    assert.ok(next, JSON.stringify(rule));
    const toast = formatScheduleTimeToast(next, 'zh', now);
    const day = new Date(next).getDay() || 7;
    const expected = rule.kind === 'weekly'
      ? `下次运行：${toast} (${WEEKDAY_ZH[day]})`
      : `下次运行：${toast}`;
    assert.equal(computeNextRunPreview(formData(rule), 'zh', now), expected, JSON.stringify(rule));
  }
  // Interval: the web preview shows now + N minutes.
  const now = local(2026, 3, 10, 8, 0);
  const preview = computeNextRunPreview(formData({ kind: 'interval', everyMinutes: 45 }), 'zh', now);
  assert.match(preview, new RegExp(stamp(nextRunTime({ kind: 'interval', everyMinutes: 45 }, now)).slice(-5)));
});

test('rule problems follow the web validation (scheduleValidation.ts)', () => {
  const now = local(2026, 3, 10, 8, 0);
  const field = (rule) => ruleProblems(rule, { now }).map((item) => item.field);
  assert.deepEqual(field({ kind: 'interval', everyMinutes: 4 }), ['rule.everyMinutes']);
  assert.deepEqual(field({ kind: 'interval', everyMinutes: 5 }), []);
  assert.deepEqual(field({ kind: 'interval', everyMinutes: 5.5 }), ['rule.everyMinutes']);
  assert.deepEqual(field({ kind: 'weekly', days: [], time: '09:00' }), ['rule.days']);
  assert.deepEqual(field({ kind: 'weekly', days: [8], time: '09:00' }), ['rule.days']);
  assert.deepEqual(field({ kind: 'weekly', days: [1], time: '9:00' }), ['rule.time']);
  assert.deepEqual(field({ kind: 'daily', time: '24:00' }), ['rule.time']);
  assert.deepEqual(field({ kind: 'once', at: now }), ['rule.at']);
  assert.deepEqual(field({ kind: 'once', at: now + 1 }), []);
  assert.deepEqual(ruleProblems({ kind: 'once', at: now - 1 }, { now, requireFuture: false }), []);
  assert.deepEqual(field({ kind: 'nope' }), ['rule.kind']);
  assert.deepEqual(field(null), ['rule']);

  const web = (patch) => validateScheduleForm({ ...formData({ kind: 'interval', everyMinutes: 5 }), ...patch }, 'en');
  assert.equal(web({ intervalValue: 4 }).valid, false);
  assert.equal(web({ intervalValue: 5 }).valid, true);
  assert.equal(web({ ruleKind: 'weekly', weeklyDays: [] }).valid, false);
});

test('cleanRule keeps only the stored fields and sorts weekdays', () => {
  assert.deepEqual(
    cleanRule({ kind: 'weekly', days: [5, 1, 5], time: '09:00', extra: 1 }),
    { kind: 'weekly', days: [1, 5], time: '09:00' },
  );
});
