import { describe, expect, it } from 'vitest';
import {
  computeDefaultOnceAt,
  formDataToPayload,
  isOnceTimeInFuture,
  validateScheduleForm,
  type ScheduleFormData,
} from './scheduleValidation';

const validBaseData: ScheduleFormData = {
  name: '检查 CI',
  message: '运行 CI 自检',
  targetKind: 'new',
  conversationId: '',
  conversationTitle: '',
  workspaceId: 'w1',
  workspaceName: 'weft',
  model: null,
  ruleKind: 'weekly',
  onceAt: Date.now() + 86400000,
  dailyTime: '09:00',
  weeklyDays: [1, 2, 3, 4, 5],
  weeklyTime: '09:00',
  intervalValue: 30,
  intervalUnit: 'minutes',
};

describe('validateScheduleForm', () => {
  it('validates a valid form without errors', () => {
    const res = validateScheduleForm(validBaseData, 'zh');
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual({});
  });

  it('reports error when name or message is empty', () => {
    const res = validateScheduleForm({ ...validBaseData, name: '  ', message: '' }, 'zh');
    expect(res.valid).toBe(false);
    expect(res.errors.name).toBe('任务名称不能为空');
    expect(res.errors.message).toBe('消息内容不能为空');
  });

  it('reports error when conversation target has no conversationId', () => {
    const res = validateScheduleForm({ ...validBaseData, targetKind: 'conversation', conversationId: '' }, 'zh');
    expect(res.valid).toBe(false);
    expect(res.errors.conversationId).toBe('请选择目标对话');
  });

  it('reports error when interval is less than 5 minutes', () => {
    const res1 = validateScheduleForm({
      ...validBaseData,
      ruleKind: 'interval',
      intervalValue: 4,
      intervalUnit: 'minutes',
    }, 'zh');
    expect(res1.valid).toBe(false);
    expect(res1.errors.interval).toBe('间隔不能少于 5 分钟');

    const res2 = validateScheduleForm({
      ...validBaseData,
      ruleKind: 'interval',
      intervalValue: 4,
      intervalUnit: 'minutes',
    }, 'en');
    expect(res2.valid).toBe(false);
    expect(res2.errors.interval).toBe('Interval must be at least 5 minutes');

    const res3 = validateScheduleForm({
      ...validBaseData,
      ruleKind: 'interval',
      intervalValue: 5,
      intervalUnit: 'minutes',
    }, 'zh');
    expect(res3.valid).toBe(true);
    expect(res3.errors.interval).toBeUndefined();
  });

  it('reports error when weekly has no days selected', () => {
    const res = validateScheduleForm({ ...validBaseData, ruleKind: 'weekly', weeklyDays: [] }, 'zh');
    expect(res.valid).toBe(false);
    expect(res.errors.weeklyDays).toBe('每周请至少选择一天');
  });

  it('validates once rule with future, past, and invalid timestamps', () => {
    const now = new Date(2026, 10, 12, 21, 28, 30).getTime();
    // In future
    const futureRes = validateScheduleForm(
      { ...validBaseData, ruleKind: 'once', onceAt: new Date(2026, 10, 12, 21, 30, 0).getTime() },
      'zh',
      now,
    );
    expect(futureRes.valid).toBe(true);
    expect(futureRes.errors.onceAt).toBeUndefined();

    // In past (same minute :00 already passed)
    const pastResZh = validateScheduleForm(
      { ...validBaseData, ruleKind: 'once', onceAt: new Date(2026, 10, 12, 21, 28, 0).getTime() },
      'zh',
      now,
    );
    expect(pastResZh.valid).toBe(false);
    expect(pastResZh.errors.onceAt).toBe('这个时间已经过去了');

    const pastResEn = validateScheduleForm(
      { ...validBaseData, ruleKind: 'once', onceAt: new Date(2026, 10, 12, 21, 28, 0).getTime() },
      'en',
      now,
    );
    expect(pastResEn.valid).toBe(false);
    expect(pastResEn.errors.onceAt).toBe('That time has already passed');

    // Missing or invalid timestamp
    const invalidRes = validateScheduleForm(
      { ...validBaseData, ruleKind: 'once', onceAt: NaN },
      'zh',
      now,
    );
    expect(invalidRes.valid).toBe(false);
    expect(invalidRes.errors.onceAt).toBe('请选择执行日期和时间');
  });
});

describe('computeDefaultOnceAt', () => {
  const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0) =>
    new Date(y, mo - 1, d, h, mi, s, ms).getTime();

  it('rounds to nearest next 5 minutes and at least 1 minute later', () => {
    // 21:28:00 -> 21:30:00 (2 min away >= 1 min)
    expect(computeDefaultOnceAt(local(2026, 11, 12, 21, 28, 0))).toBe(local(2026, 11, 12, 21, 30, 0));

    // 21:29:30 -> 21:35:00 (21:30 is only 30s away, so next 5-min mark is 21:35)
    expect(computeDefaultOnceAt(local(2026, 11, 12, 21, 29, 30))).toBe(local(2026, 11, 12, 21, 35, 0));

    // 21:29:00 -> 21:30:00 (exactly 1 minute away)
    expect(computeDefaultOnceAt(local(2026, 11, 12, 21, 29, 0))).toBe(local(2026, 11, 12, 21, 30, 0));

    // 21:29:01 -> 21:35:00 (59s away, so jumps to 21:35)
    expect(computeDefaultOnceAt(local(2026, 11, 12, 21, 29, 1))).toBe(local(2026, 11, 12, 21, 35, 0));

    // 21:25:00 -> 21:30:00 (exact on 5-min mark, needs >= 1 min, so advances to next 5-min mark)
    expect(computeDefaultOnceAt(local(2026, 11, 12, 21, 25, 0))).toBe(local(2026, 11, 12, 21, 30, 0));

    // 21:24:00 -> 21:25:00 (exactly 1 min away)
    expect(computeDefaultOnceAt(local(2026, 11, 12, 21, 24, 0))).toBe(local(2026, 11, 12, 21, 25, 0));

    // 21:24:01 -> 21:30:00 (59s away)
    expect(computeDefaultOnceAt(local(2026, 11, 12, 21, 24, 1))).toBe(local(2026, 11, 12, 21, 30, 0));
  });

  it('rolls over date when crossing midnight', () => {
    // 23:56:00 -> tomorrow 00:00:00
    expect(computeDefaultOnceAt(local(2026, 11, 12, 23, 56, 0))).toBe(local(2026, 11, 13, 0, 0, 0));

    // 23:59:00 -> tomorrow 00:00:00 (exactly 1 min away)
    expect(computeDefaultOnceAt(local(2026, 11, 12, 23, 59, 0))).toBe(local(2026, 11, 13, 0, 0, 0));

    // 23:59:30 -> tomorrow 00:05:00 (30s to 00:00 is < 1 min)
    expect(computeDefaultOnceAt(local(2026, 11, 12, 23, 59, 30))).toBe(local(2026, 11, 13, 0, 5, 0));

    // 00:00:00 -> today 00:05:00
    expect(computeDefaultOnceAt(local(2026, 11, 13, 0, 0, 0))).toBe(local(2026, 11, 13, 0, 5, 0));
  });
});

describe('isOnceTimeInFuture', () => {
  const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0) =>
    new Date(y, mo - 1, d, h, mi, s, ms).getTime();

  it('checks current minute boundary', () => {
    const now212800 = local(2026, 11, 12, 21, 28, 0);
    const target212800 = local(2026, 11, 12, 21, 28, 0);
    // Exact same minute :00 is NOT in future (<= now)
    expect(isOnceTimeInFuture(target212800, now212800)).toBe(false);

    // Current minute when :00 has passed (21:28:30 vs 21:28:00)
    const now212830 = local(2026, 11, 12, 21, 28, 30);
    expect(isOnceTimeInFuture(target212800, now212830)).toBe(false);

    // Next minute is in future (21:28:30 vs 21:29:00)
    const target212900 = local(2026, 11, 12, 21, 29, 0);
    expect(isOnceTimeInFuture(target212900, now212830)).toBe(true);

    // 1 ms before :00 is in future
    const now212759 = local(2026, 11, 12, 21, 27, 59, 999);
    expect(isOnceTimeInFuture(target212800, now212759)).toBe(true);

    // Earlier minute is in past
    const target212700 = local(2026, 11, 12, 21, 27, 0);
    expect(isOnceTimeInFuture(target212700, now212800)).toBe(false);
  });

  it('checks across midnight boundary', () => {
    const now235930 = local(2026, 11, 12, 23, 59, 30);
    const targetToday2359 = local(2026, 11, 12, 23, 59, 0);
    const targetTomorrow0000 = local(2026, 11, 13, 0, 0, 0);

    // Today 23:59:00 has already passed at 23:59:30
    expect(isOnceTimeInFuture(targetToday2359, now235930)).toBe(false);

    // Tomorrow 00:00:00 is in future
    expect(isOnceTimeInFuture(targetTomorrow0000, now235930)).toBe(true);

    // Exact midnight is NOT in future
    const nowMidnight = local(2026, 11, 13, 0, 0, 0);
    expect(isOnceTimeInFuture(targetTomorrow0000, nowMidnight)).toBe(false);

    // After midnight, yesterday 23:59:00 is past
    const nowAfterMidnight = local(2026, 11, 13, 0, 0, 1);
    expect(isOnceTimeInFuture(targetToday2359, nowAfterMidnight)).toBe(false);

    // Tomorrow 00:05:00 is in future
    const targetTomorrow0005 = local(2026, 11, 13, 0, 5, 0);
    expect(isOnceTimeInFuture(targetTomorrow0005, nowAfterMidnight)).toBe(true);
  });

  it('handles invalid inputs', () => {
    expect(isOnceTimeInFuture(NaN)).toBe(false);
    expect(isOnceTimeInFuture(0)).toBe(false);
    expect(isOnceTimeInFuture(-1000)).toBe(false);
  });
});

describe('formDataToPayload', () => {
  it('converts conversation target and interval rule to payload', () => {
    const payload = formDataToPayload({
      ...validBaseData,
      targetKind: 'conversation',
      conversationId: 'c1',
      conversationTitle: '主对话',
      ruleKind: 'interval',
      intervalValue: 2,
      intervalUnit: 'hours',
    });
    expect(payload.name).toBe('检查 CI');
    expect(payload.target).toEqual({
      kind: 'conversation',
      conversationId: 'c1',
      title: '主对话',
    });
    expect(payload.rule).toEqual({
      kind: 'interval',
      everyMinutes: 120,
    });
  });

  it('converts new chat target and weekly rule to payload', () => {
    const payload = formDataToPayload(validBaseData);
    expect(payload.target).toEqual({
      kind: 'new',
      workspaceId: 'w1',
      workspaceName: 'weft',
      model: null,
    });
    expect(payload.rule).toEqual({
      kind: 'weekly',
      days: [1, 2, 3, 4, 5],
      time: '09:00',
    });
  });
});
