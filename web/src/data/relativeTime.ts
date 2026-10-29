import type { Lang } from './lang';
import { t } from '../i18n';

export function formatRelativeTime(
  lang: Lang,
  ts: number | string | null | undefined,
  now = Date.now(),
): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const diffSec = Math.max(0, Math.round((now - n) / 1000));
  if (diffSec < 60) return t(lang, 'just_now');
  if (diffSec < 3600) {
    return t(lang, 'time_min', { n: Math.max(1, Math.round(diffSec / 60)) });
  }

  const then = new Date(n);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const thenDay = new Date(n);
  thenDay.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((today.getTime() - thenDay.getTime()) / 86400000);

  if (dayDiff === 0) {
    return t(lang, 'time_hour', { n: Math.max(1, Math.floor(diffSec / 3600)) });
  }
  if (dayDiff === 1) {
    return t(lang, 'yesterday');
  }
  if (dayDiff > 1 && dayDiff < 7) {
    const keys = [
      'weekday_0',
      'weekday_1',
      'weekday_2',
      'weekday_3',
      'weekday_4',
      'weekday_5',
      'weekday_6',
    ] as const;
    return t(lang, keys[then.getDay()]);
  }
  return t(lang, 'date_md', { m: then.getMonth() + 1, d: then.getDate() });
}
