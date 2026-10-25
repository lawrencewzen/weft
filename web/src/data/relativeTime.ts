import type { Lang } from './lang';
import { t } from '../i18n';

export function formatRelativeTime(lang: Lang, ts: number | string | null | undefined, now = Date.now()): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const diffSec = Math.max(1, Math.round((now - n) / 1000));
  if (diffSec < 60) return t(lang, 'sec_ago', { n: diffSec });
  if (diffSec < 3600) return t(lang, 'min_ago', { n: Math.max(1, Math.round(diffSec / 60)) });
  if (diffSec < 86400) return t(lang, 'hour_ago', { n: Math.floor(diffSec / 3600) });
  const then = new Date(n);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((today.getTime() - then.getTime()) / 86400000);
  if (days <= 1) return t(lang, 'yesterday');
  if (days < 7) {
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
  if (days < 30) return t(lang, 'day_ago', { n: days });
  return t(lang, 'date_md', { m: then.getMonth() + 1, d: then.getDate() });
}
