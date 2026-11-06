// Human text for a failed run. The kernel has no request language, so it uses zh;
// the v2 view rebuilds the same sentence for the snapshot's lang.
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

/** Empty string when this reason has no dedicated sentence. */
export function runErrorMessage(lang: Lang, reason: unknown, detail = ''): string {
  const key = String(reason || '');
  if (key === 'no_model') return 'err_no_model';
  if (key === 'interrupted') return phrase(lang, 'run_err_interrupted');
  if (key === 'restart_limit') return phrase(lang, 'run_err_restart_limit');
  if (key === 'faulted') return phrase(lang, 'run_err_faulted');
  if (key === 'model_error') return phrase(lang, 'run_err_model', { detail: String(detail ?? '') });
  return '';
}
