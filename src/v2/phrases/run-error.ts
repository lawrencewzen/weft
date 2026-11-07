// Human text for a failed run. The kernel stores code, reason, and detail.
// This module turns those into a sentence for the request language.
import { phrase, type Lang } from './index.ts';

export const CONTINUABLE_REASONS = new Set([
  'model_error',
  'interrupted',
  'restart_limit',
  'faulted',
]);

export function canContinueReason(reason: unknown): boolean {
  return CONTINUABLE_REASONS.has(String(reason || ''));
}

/** Empty string when this reason has no dedicated sentence. Callers then use `run_err_unfinished`. */
export function runErrorMessage(lang: Lang, reason: unknown, detail = ''): string {
  const key = String(reason || '');
  if (key === 'no_model') return 'err_no_model';
  if (key === 'interrupted') return phrase(lang, 'run_err_interrupted');
  if (key === 'restart_limit') return phrase(lang, 'run_err_restart_limit');
  if (key === 'faulted') return phrase(lang, 'run_err_faulted');
  if (key === 'model_error' && /Model stream idle timeout/i.test(String(detail ?? ''))) return phrase(lang, 'run_err_stream_idle');
  if (key === 'model_error') return phrase(lang, 'run_err_model', { detail: String(detail ?? '') });
  return '';
}

export type RetryKind = 'network' | 'timeout' | 'busy' | 'server' | 'other';

/** Coarse class of a raw model error that is being retried. The raw text is never shown. */
export function retryKind(raw: unknown): RetryKind {
  const text = String(raw ?? '');
  if (/timed?\s*out|timeout/i.test(text)) return 'timeout';
  if (/overloaded|server_busy|busy|rate.?limit|too many requests|capacity|high demand|(?<![a-z0-9])429(?![a-z0-9])/i.test(text)) {
    return 'busy';
  }
  if (/(?<![a-z0-9])(?:500|502|503|504|520|524)(?![a-z0-9])|server.?error|internal.?error|unavailable|upstream|provider.?returned/i.test(text)) {
    return 'server';
  }
  if (/fetch failed|network|connection|ECONN|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket|terminated|other side closed|websocket|stream (?:was )?(?:ended|interrupted|disconnected)|ended without|reset before/i.test(text)) {
    return 'network';
  }
  return 'other';
}

/** Sentence for the pending row while the kernel waits to retry. `attempt` is the upcoming try. */
export function retryMessage(lang: Lang, kind: RetryKind, attempt: number, maxAttempts: number): string {
  return phrase(lang, `run_retry_${kind}`, { n: attempt, max: maxAttempts });
}
