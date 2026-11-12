import { t } from '../../i18n';
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

export function isOnceTimeInFuture(onceAt: number, now = Date.now()): boolean {
  return typeof onceAt === 'number' && Number.isFinite(onceAt) && onceAt > now;
}

export function computeDefaultOnceAt(now = Date.now()): number {
  const minTime = now + 60_000;
  const d = new Date(minTime);
  const rem = d.getMinutes() % 5;
  const sec = d.getSeconds();
  const ms = d.getMilliseconds();
  if (rem === 0 && sec === 0 && ms === 0) {
    return d.getTime();
  }
  const addMinutes = 5 - rem;
  d.setMinutes(d.getMinutes() + addMinutes, 0, 0);
  return d.getTime();
}

export function validateScheduleForm(
  data: ScheduleFormData,
  lang: Lang = 'zh',
  now = Date.now(),
): { valid: boolean; errors: ScheduleFormErrors } {
  const errors: ScheduleFormErrors = {};

  if (!data.name.trim()) {
    errors.name = t(lang, 'sched_err_name');
  }

  if (!data.message.trim()) {
    errors.message = t(lang, 'sched_err_message');
  }

  if (data.targetKind === 'conversation') {
    if (!data.conversationId) {
      errors.conversationId = t(lang, 'sched_err_conversation');
    }
  } else if (data.targetKind === 'new') {
    if (!data.workspaceId) {
      errors.workspaceId = t(lang, 'sched_err_workspace');
    }
  }

  if (data.ruleKind === 'once') {
    if (!data.onceAt || isNaN(data.onceAt)) {
      errors.onceAt = t(lang, 'sched_err_once');
    } else if (!isOnceTimeInFuture(data.onceAt, now)) {
      errors.onceAt = t(lang, 'sched_err_once_past');
    }
  } else if (data.ruleKind === 'daily') {
    if (!data.dailyTime || !/^\d{2}:\d{2}$/.test(data.dailyTime)) {
      errors.dailyTime = t(lang, 'sched_err_time');
    }
  } else if (data.ruleKind === 'weekly') {
    if (!data.weeklyDays || data.weeklyDays.length === 0) {
      errors.weeklyDays = t(lang, 'sched_err_days');
    }
    if (!data.weeklyTime || !/^\d{2}:\d{2}$/.test(data.weeklyTime)) {
      errors.weeklyTime = t(lang, 'sched_err_time');
    }
  } else if (data.ruleKind === 'interval') {
    const totalMinutes = data.intervalUnit === 'hours'
      ? data.intervalValue * 60
      : data.intervalValue;
    if (isNaN(totalMinutes) || totalMinutes < 5) {
      errors.interval = t(lang, 'sched_err_interval');
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
