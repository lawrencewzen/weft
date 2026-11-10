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
