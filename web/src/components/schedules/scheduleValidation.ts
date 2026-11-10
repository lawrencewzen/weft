import type { Lang } from '../../data/lang';
import type { ScheduleRule, ScheduleTarget } from '../../data/store';

export type ScheduleFormData = {
  name: string;
  message: string;
  targetKind: 'conversation' | 'new';
  conversationId: string;
  conversationTitle: string;
  workspaceId: string;
  workspaceName: string;
  model: { providerId: string; modelId: string } | null;
  ruleKind: 'once' | 'daily' | 'weekly' | 'interval';
  onceAt: number;
  dailyTime: string;
  weeklyDays: number[];
  weeklyTime: string;
  intervalValue: number;
  intervalUnit: 'minutes' | 'hours';
};

export type ScheduleFormErrors = {
  name?: string;
  message?: string;
  conversationId?: string;
  workspaceId?: string;
  onceAt?: string;
  dailyTime?: string;
  weeklyDays?: string;
  weeklyTime?: string;
  interval?: string;
};

export function validateScheduleForm(
  data: ScheduleFormData,
  lang: Lang = 'zh',
): { valid: boolean; errors: ScheduleFormErrors } {
  const errors: ScheduleFormErrors = {};

  if (!data.name.trim()) {
    errors.name = lang === 'en' ? 'Task name is required' : '任务名称不能为空';
  }

  if (!data.message.trim()) {
    errors.message = lang === 'en' ? 'Message content is required' : '消息内容不能为空';
  }

  if (data.targetKind === 'conversation') {
    if (!data.conversationId) {
      errors.conversationId = lang === 'en' ? 'Please select a conversation' : '请选择目标对话';
    }
  } else if (data.targetKind === 'new') {
    if (!data.workspaceId) {
      errors.workspaceId = lang === 'en' ? 'Please select a workspace' : '请选择工作区';
    }
  }

  if (data.ruleKind === 'once') {
    if (!data.onceAt || isNaN(data.onceAt)) {
      errors.onceAt = lang === 'en' ? 'Please select date and time' : '请选择执行日期和时间';
    }
  } else if (data.ruleKind === 'daily') {
    if (!data.dailyTime || !/^\d{2}:\d{2}$/.test(data.dailyTime)) {
      errors.dailyTime = lang === 'en' ? 'Please enter a valid time' : '请输入有效的时间（HH:MM）';
    }
  } else if (data.ruleKind === 'weekly') {
    if (!data.weeklyDays || data.weeklyDays.length === 0) {
      errors.weeklyDays = lang === 'en' ? 'Please select at least one day' : '每周请至少选择一天';
    }
    if (!data.weeklyTime || !/^\d{2}:\d{2}$/.test(data.weeklyTime)) {
      errors.weeklyTime = lang === 'en' ? 'Please enter a valid time' : '请输入有效的时间（HH:MM）';
    }
  } else if (data.ruleKind === 'interval') {
    const totalMinutes = data.intervalUnit === 'hours'
      ? data.intervalValue * 60
      : data.intervalValue;
    if (isNaN(totalMinutes) || totalMinutes < 5) {
      errors.interval = lang === 'en' ? 'Interval must be at least 5 minutes' : '间隔不能少于 5 分钟';
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function formDataToPayload(data: ScheduleFormData, enabled = true): {
  name: string;
  message: string;
  target: ScheduleTarget;
  rule: ScheduleRule;
  enabled: boolean;
} {
  let target: ScheduleTarget;
  if (data.targetKind === 'conversation') {
    target = {
      kind: 'conversation',
      conversationId: data.conversationId,
      title: data.conversationTitle,
    };
  } else {
    target = {
      kind: 'new',
      workspaceId: data.workspaceId,
      workspaceName: data.workspaceName,
      model: data.model,
    };
  }

  let rule: ScheduleRule;
  if (data.ruleKind === 'once') {
    rule = { kind: 'once', at: data.onceAt };
  } else if (data.ruleKind === 'daily') {
    rule = { kind: 'daily', time: data.dailyTime };
  } else if (data.ruleKind === 'weekly') {
    rule = { kind: 'weekly', days: [...data.weeklyDays].sort((a, b) => a - b), time: data.weeklyTime };
  } else {
    const totalMinutes = data.intervalUnit === 'hours' ? data.intervalValue * 60 : data.intervalValue;
    rule = { kind: 'interval', everyMinutes: totalMinutes };
  }

  return {
    name: data.name.trim(),
    message: data.message.trim(),
    target,
    rule,
    enabled,
  };
}
