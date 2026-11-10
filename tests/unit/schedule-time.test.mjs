import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanRule,
  nextRunTime,
  ruleProblems,
} from '../../src/core/schedule-time.mjs';

process.env.TZ = 'Asia/Shanghai';

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const stamp = (ts) => {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

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

test('cleanRule keeps only the stored fields and sorts weekdays', () => {
  assert.deepEqual(
    cleanRule({ kind: 'weekly', days: [5, 1, 5], time: '09:00', extra: 1 }),
    { kind: 'weekly', days: [1, 5], time: '09:00' },
  );
});
