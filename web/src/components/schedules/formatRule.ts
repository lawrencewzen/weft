import type { Schedule } from '../../data/api';
import type { Lang } from '../../data/lang';
import type { ScheduleRule, ScheduleTarget } from '../../data/store';
import { t, type I18nKey } from '../../i18n';
import type { ScheduleFormData } from './scheduleValidation';

export function formatTarget(target: ScheduleTarget, lang: Lang): string {
  if (target.kind === 'conversation') {
    return t(lang, 'sched_fmt_to', { title: target.title });
  }
  return t(lang, 'sched_new_chat_each', { workspace: target.workspaceName });
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(d: Date, lang: Lang): string {
  return lang === 'en' ? MONTH_NAMES[d.getMonth()] : String(d.getMonth() + 1);
}

function dayNames(days: number[], lang: Lang, kind: 'long' | 'full'): string[] {
  return days.map((d) => t(lang, `wd_${kind}_${d}` as I18nKey));
}

export function formatRule(rule: ScheduleRule, lang: Lang): string {
  if (rule.kind === 'once') {
    const d = new Date(rule.at);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return t(lang, 'sched_fmt_once', { month: monthLabel(d, lang), date: d.getDate(), time: `${hours}:${minutes}` });
  }

  if (rule.kind === 'daily') {
    return t(lang, 'sched_fmt_daily', { time: rule.time });
  }

  if (rule.kind === 'weekly') {
    const days = [...new Set(rule.days || [])].sort((a, b) => a - b);
    const isWeekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d, i) => days[i] === d);
    if (isWeekdays) return t(lang, 'sched_fmt_weekdays', { time: rule.time });
    const isWeekends = days.length === 2 && days[0] === 6 && days[1] === 7;
    if (isWeekends) return t(lang, 'sched_fmt_weekends', { time: rule.time });
    if (days.length === 7) return t(lang, 'sched_fmt_daily', { time: rule.time });
    const str = dayNames(days, lang, 'long').join(lang === 'en' ? ', ' : '、');
    return t(lang, 'sched_fmt_weekly', { days: str, time: rule.time });
  }

  if (rule.kind === 'interval') {
    if (rule.everyMinutes % 60 === 0) {
      const hours = rule.everyMinutes / 60;
      return t(lang, hours > 1 ? 'sched_fmt_every_hours' : 'sched_fmt_every_hour', { n: hours });
    }
    return t(lang, 'sched_fmt_every_minutes', { n: rule.everyMinutes });
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

  const time = `${hh}:${mm}`;
  if (dayDiff === 0) return t(lang, 'sched_toast_today', { time });
  if (dayDiff === 1) return t(lang, 'sched_toast_tomorrow', { time });
  return t(lang, 'sched_toast_date', { month: monthLabel(d, lang), date: d.getDate(), time });
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

  if (count > 1) {
    return t(lang, 'sched_strip_more', { when: timeLabel, preview, count, more: count - 1 });
  }
  return t(lang, 'sched_strip_one', { when: timeLabel, preview });
}

export function formatNextRunSummary(timestamp: number | null, lang: Lang, now = Date.now()): string {
  if (!timestamp) return '-';
  const timeStr = formatScheduleTimeToast(timestamp, lang, now);
  return t(lang, 'sched_next_short', { when: timeStr });
}

export function computeNextRunPreview(
  data: ScheduleFormData,
  lang: Lang,
  now = Date.now(),
): string {
  if (data.ruleKind === 'once') {
    if (!data.onceAt || isNaN(data.onceAt)) return '';
    const timeStr = formatScheduleTimeToast(data.onceAt, lang, now);
    return t(lang, 'sched_next_run', { when: timeStr });
  }

  if (data.ruleKind === 'daily') {
    if (!data.dailyTime || !/^\d{2}:\d{2}$/.test(data.dailyTime)) return '';
    const [hh, mm] = data.dailyTime.split(':').map(Number);
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    const targetTs = d.getTime() > now ? d.getTime() : d.getTime() + 86400000;
    const timeStr = formatScheduleTimeToast(targetTs, lang, now);
    return t(lang, 'sched_next_run', { when: timeStr });
  }

  if (data.ruleKind === 'weekly') {
    if (!data.weeklyDays?.length || !data.weeklyTime || !/^\d{2}:\d{2}$/.test(data.weeklyTime)) return '';
    const [hh, mm] = data.weeklyTime.split(':').map(Number);
    for (let offset = 0; offset <= 7; offset++) {
      const d = new Date(now + offset * 86400000);
      d.setHours(hh, mm, 0, 0);
      const day = d.getDay() === 0 ? 7 : d.getDay();
      if (data.weeklyDays.includes(day) && d.getTime() > now) {
        const timeStr = formatScheduleTimeToast(d.getTime(), lang, now);
        return t(lang, 'sched_next_run_day', { when: timeStr, day: dayNames([day], lang, 'full')[0] });
      }
    }
    return '';
  }

  if (data.ruleKind === 'interval') {
    const totalMinutes = data.intervalUnit === 'hours' ? data.intervalValue * 60 : data.intervalValue;
    if (isNaN(totalMinutes) || totalMinutes < 5) return '';
    const targetTs = now + totalMinutes * 60000;
    const d = new Date(targetTs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const span = data.intervalUnit === 'hours'
      ? t(lang, data.intervalValue > 1 ? 'sched_in_hours_pl' : 'sched_in_hours', { n: data.intervalValue })
      : t(lang, 'sched_in_minutes', { n: data.intervalValue });
    return t(lang, 'sched_next_in', { span, clock });
  }

  return '';
}
