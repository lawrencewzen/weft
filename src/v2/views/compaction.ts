/** Compaction view from pi.live.compactions and pi.live.compactionFailure. */

import { redactAuthText } from '../../core/redact.mjs';
import type { components } from '../contract.gen.ts';
import { phrase, type Lang } from '../phrases/index.ts';

export type CompactionState = NonNullable<components['schemas']['RunState']['compaction']>;

const TRIGGERS = new Set(['manual', 'threshold', 'overflow']);
const OFFICIAL_PREFIX = /^Compaction failed:\s*/i;

export function compactionTrigger(value: unknown): CompactionState['trigger'] | undefined {
  const trigger = String(value || '');
  if (!TRIGGERS.has(trigger)) return undefined;
  return trigger as NonNullable<CompactionState['trigger']>;
}

/** Official error text, with one leading "Compaction failed:" removed, then redacted. */
export function compactionFailureReason(raw: unknown): string {
  const text = String(raw ?? '').replace(OFFICIAL_PREFIX, '').trim();
  return redactAuthText(text);
}

export function compactionFailureMessage(lang: Lang, raw: unknown): string {
  return phrase(lang, 'compaction_failed', { reason: compactionFailureReason(raw) });
}

type LiveLike = {
  compactions?: Array<{ trigger?: unknown }> | null;
  compactionFailure?: { trigger?: unknown; error?: unknown } | null;
};

/**
 * running while pi.live.compactions lists a task (the last one's trigger).
 * failed from the retained compactionFailure until a later summary clears it.
 * idle otherwise.
 */
export function compactionView(live: LiveLike | null | undefined, lang: Lang = 'zh'): CompactionState {
  const running = Array.isArray(live?.compactions) ? live.compactions : [];
  if (running.length) {
    const latest = running[running.length - 1];
    const trigger = compactionTrigger(latest?.trigger);
    return trigger ? { state: 'running', trigger } : { state: 'running' };
  }
  const failure = live?.compactionFailure;
  if (failure && (failure.error != null || failure.trigger != null)) {
    const trigger = compactionTrigger(failure.trigger);
    const error = compactionFailureMessage(lang, failure.error);
    return trigger ? { state: 'failed', trigger, error } : { state: 'failed', error };
  }
  return { state: 'idle' };
}

/** Blocking compaction failure is a model_error whose detail starts with the official prefix. */
export function isCompactionModelError(message: unknown): boolean {
  return OFFICIAL_PREFIX.test(String(message ?? ''));
}
