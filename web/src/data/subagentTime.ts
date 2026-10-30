import type { Lang } from './lang';
import type { Subagent } from './store';
import { t } from '../i18n';

export type SubagentStatus = Subagent['status'];

export function finiteTs(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function formatMmSs(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return `${String(m).padStart(2, '0')}:${ss}`;
}

export function progressLabel(progress: Subagent['progress'] | null | undefined): string {
  if (!progress) return '';
  const step = Number(progress.step);
  const total = Number(progress.total);
  if (Number.isFinite(total) && total > 0) return `${Number.isFinite(step) ? step : 0}/${total}`;
  if (Number.isFinite(step) && step > 0) return String(step);
  return '';
}

/** Pane / header time: done shows 「完成」. */
export function subagentTimeText(agent: Pick<Subagent, 'status' | 'startedAt' | 'lastActivityAt'>, lang: Lang, now = Date.now()): string {
  const st = agent.status || 'waiting';
  if (st === 'done') return t(lang, 'status_done');
  if (st === 'failed') return t(lang, 'status_failed');
  if (st === 'stopped') return t(lang, 'status_stopped');
  if (st === 'stuck') {
    const last = finiteTs(agent.lastActivityAt);
    const clock = last ? formatMmSs(now - last) : '';
    return clock ? t(lang, 'subagent_idle_for', { time: clock }) : '';
  }
  const started = finiteTs(agent.startedAt);
  if (!started) return '';
  return formatMmSs(now - started);
}

export function stripActionMarks(text: string): string {
  return text.replace(/`+/g, '').replace(/\s+/g, ' ').trim();
}

export function subagentActionText(agent: Pick<Subagent, 'status' | 'currentAction' | 'progress'>): string {
  const st = agent.status || 'waiting';
  if (st !== 'running' && st !== 'stuck') return '';
  const action = stripActionMarks(String(agent.currentAction || ''));
  const progress = progressLabel(agent.progress);
  if (action && progress) return `${action} · ${progress}`;
  return action || progress;
}

/** Overview / switcher row: live agents show the current action; others leave the line empty. */
export function subagentOverviewNow(agent: Pick<Subagent, 'status' | 'currentAction' | 'progress'>): string {
  return subagentActionText(agent);
}

export type SubagentDotKind = 'running' | 'stuck' | 'waiting' | 'done' | 'stopped' | 'failed';

export function subagentDotStatus(status: SubagentStatus | string): SubagentDotKind {
  if (status === 'failed') return 'failed';
  if (status === 'done') return 'done';
  if (status === 'stopped') return 'stopped';
  if (status === 'stuck') return 'stuck';
  if (status === 'waiting') return 'waiting';
  return 'running';
}

export function subagentDotLive(status: SubagentStatus | string): boolean {
  return status === 'running' || status === 'stuck';
}
