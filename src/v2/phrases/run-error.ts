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
