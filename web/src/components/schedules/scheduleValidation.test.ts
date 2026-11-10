import { describe, expect, it } from 'vitest';
import { formDataToPayload, validateScheduleForm, type ScheduleFormData } from './scheduleValidation';

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
