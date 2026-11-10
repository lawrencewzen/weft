// Schedule rule math. Pure functions, no timers. All times are the local time zone of
// the machine that runs the server, the same zone the web UI uses (formatRule.ts).

export const MIN_INTERVAL_MINUTES = 5;
export const RULE_KINDS = Object.freeze(['once', 'daily', 'weekly', 'interval']);
const MINUTE_MS = 60_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" to { h, m }, or null. */
export function parseClock(text) {
  const match = TIME_RE.exec(typeof text === 'string' ? text : '');
  if (!match) return null;
  return { h: Number(match[1]), m: Number(match[2]) };
}

/** Distinct weekdays 1 (Monday) to 7 (Sunday), sorted. */
export function normalizeDays(days) {
  return [...new Set(Array.isArray(days) ? days : [])]
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    .sort((a, b) => a - b);
}

/** Field errors of a rule: [{ field, key }]. `key` names the message. Empty when valid. */
export function ruleProblems(rule, { now = Date.now(), requireFuture = true } = {}) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return [{ field: 'rule', key: 'rule_required' }];
  if (rule.kind === 'once') {
    if (typeof rule.at !== 'number' || !Number.isFinite(rule.at) || rule.at <= 0) {
      return [{ field: 'rule.at', key: 'once_invalid' }];
    }
    if (requireFuture && rule.at <= now) return [{ field: 'rule.at', key: 'once_past' }];
    return [];
  }
  if (rule.kind === 'daily') {
    return parseClock(rule.time) ? [] : [{ field: 'rule.time', key: 'time_invalid' }];
  }
  if (rule.kind === 'weekly') {
    const out = [];
    const days = Array.isArray(rule.days) ? rule.days : [];
    if (days.length === 0) out.push({ field: 'rule.days', key: 'days_required' });
    else if (days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      out.push({ field: 'rule.days', key: 'days_invalid' });
    }
    if (!parseClock(rule.time)) out.push({ field: 'rule.time', key: 'time_invalid' });
    return out;
  }
  if (rule.kind === 'interval') {
    const every = rule.everyMinutes;
    if (!Number.isSafeInteger(every) || every < MIN_INTERVAL_MINUTES) {
      return [{ field: 'rule.everyMinutes', key: 'interval_min' }];
    }
    return [];
  }
  return [{ field: 'rule.kind', key: 'rule_kind' }];
}

/** The stored form of a valid rule. */
export function cleanRule(rule) {
  if (rule.kind === 'once') return { kind: 'once', at: rule.at };
  if (rule.kind === 'daily') return { kind: 'daily', time: rule.time };
  if (rule.kind === 'weekly') return { kind: 'weekly', days: normalizeDays(rule.days), time: rule.time };
  return { kind: 'interval', everyMinutes: rule.everyMinutes };
}

function atClock(from, dayOffset, clock) {
  const base = new Date(from);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, clock.h, clock.m, 0, 0).getTime();
}

/**
 * The first run strictly after `from` (epoch ms), or null when the rule has no more runs.
 * `anchor` is the previous planned time of an interval rule, so a catch-up does not shift the cadence.
 */
export function nextRunTime(rule, from, { anchor = null } = {}) {
  if (!rule || typeof rule !== 'object') return null;
  if (rule.kind === 'once') return rule.at > from ? rule.at : null;
  if (rule.kind === 'interval') {
    const step = rule.everyMinutes * MINUTE_MS;
    if (!(step > 0)) return null;
    if (anchor == null || !Number.isFinite(anchor)) return from + step;
    const steps = Math.floor((from - anchor) / step) + 1;
    return anchor + Math.max(1, steps) * step;
  }
  const clock = parseClock(rule.time);
  if (!clock) return null;
  if (rule.kind === 'daily') {
    for (let offset = 0; offset <= 2; offset += 1) {
      const at = atClock(from, offset, clock);
      if (at > from) return at;
    }
    return null;
  }
  if (rule.kind === 'weekly') {
    const days = normalizeDays(rule.days);
    if (days.length === 0) return null;
    for (let offset = 0; offset <= 8; offset += 1) {
      const at = atClock(from, offset, clock);
      const weekday = new Date(at).getDay() || 7;
      if (days.includes(weekday) && at > from) return at;
    }
    return null;
  }
  return null;
}
