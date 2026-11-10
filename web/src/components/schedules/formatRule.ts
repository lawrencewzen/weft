import type { Schedule } from '../../data/api';
import type { Lang } from '../../data/lang';
import type { ScheduleRule, ScheduleTarget } from '../../data/store';

export function formatTarget(target: ScheduleTarget, lang: Lang): string {
  if (target.kind === 'conversation') {
    return lang === 'en' ? `To: ${target.title}` : `发到：${target.title}`;
  }
  return lang === 'en'
    ? `${target.workspaceName} · New chat each time`
    : `${target.workspaceName} · 每次新开对话`;
}

export function formatRule(rule: ScheduleRule, lang: Lang): string {
  if (rule.kind === 'once') {
    const d = new Date(rule.at);
    const month = d.getMonth() + 1;
    const date = d.getDate();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    if (lang === 'en') {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${monthNames[d.getMonth()]} ${date}, ${hours}:${minutes} once`;
    }
    return `${month}月${date}日 ${hours}:${minutes} 一次`;
  }

  if (rule.kind === 'daily') {
    return lang === 'en' ? `Daily at ${rule.time}` : `每天 ${rule.time}`;
  }

  if (rule.kind === 'weekly') {
    const days = [...new Set(rule.days || [])].sort((a, b) => a - b);
    const isWeekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d, i) => days[i] === d);
    if (isWeekdays) {
      return lang === 'en' ? `Every weekday at ${rule.time}` : `每个工作日 ${rule.time}`;
    }
    const isWeekends = days.length === 2 && days[0] === 6 && days[1] === 7;
    if (isWeekends) {
      return lang === 'en' ? `Every weekend at ${rule.time}` : `每个周末 ${rule.time}`;
    }
    const isAllDays = days.length === 7;
    if (isAllDays) {
      return lang === 'en' ? `Daily at ${rule.time}` : `每天 ${rule.time}`;
    }

    if (lang === 'en') {
      const enDays = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const str = days.map((d) => enDays[d] || String(d)).join(', ');
      return `Every ${str} at ${rule.time}`;
    }
    const zhDays = ['', '一', '二', '三', '四', '五', '六', '日'];
    const str = days.map((d) => zhDays[d] || String(d)).join('、');
    return `每周${str} ${rule.time}`;
  }

  if (rule.kind === 'interval') {
    if (rule.everyMinutes % 60 === 0) {
      const hours = rule.everyMinutes / 60;
      if (lang === 'en') {
        return `Every ${hours} hour${hours > 1 ? 's' : ''}`;
      }
      return `每 ${hours} 小时`;
    }
    return lang === 'en' ? `Every ${rule.everyMinutes} minutes` : `每 ${rule.everyMinutes} 分钟`;
  }

  return '';
}

export function formatScheduleTimeToast(timestamp: number, lang: Lang, now = Date.now()): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());

  const nowDate = new Date(now);
  const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const targetDayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((targetDayStart - todayStart) / 86400000);

  if (lang === 'en') {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (dayDiff === 0) return `today at ${hh}:${mm}`;
    if (dayDiff === 1) return `tomorrow at ${hh}:${mm}`;
    return `${monthNames[d.getMonth()]} ${d.getDate()} at ${hh}:${mm}`;
  }
  if (dayDiff === 0) return `今天 ${hh}:${mm}`;
  if (dayDiff === 1) return `明天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

export function formatConversationScheduleStripText(
  schedules: Schedule[],
  lang: Lang,
  now = Date.now(),
): string {
  if (schedules.length === 0) return '';
  const first = schedules[0];
  const timeLabel = first.rule.kind === 'once'
    ? formatScheduleTimeToast(first.rule.at, lang, now)
    : formatRule(first.rule, lang);
  const preview = first.message.slice(0, 20);
  const count = schedules.length;

  if (lang === 'en') {
    if (count > 1) {
      return `Scheduled: ${timeLabel} send "${preview}" and ${count - 1} more`;
    }
    return `Scheduled: ${timeLabel} send "${preview}"`;
  }
  if (count > 1) {
    return `已定时：${timeLabel} 发送「${preview}」等 ${count} 条`;
  }
  return `已定时：${timeLabel} 发送「${preview}」`;
}
