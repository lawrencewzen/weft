import { contextUsed } from '../../core/usage.mjs';
import { contextPercents, DEFAULT_CONTEXT_WINDOW } from '../../core/usage-math.mjs';
import type { components } from '../contract.gen.ts';

export type ContextUsage = components['schemas']['ContextUsage'];

export type ContextUsageInput = {
  usage?: unknown;
  window?: unknown;
};

function positiveWindow(window: unknown): number {
  if (typeof window === 'number' && Number.isFinite(window) && window > 0) return window;
  return DEFAULT_CONTEXT_WINDOW;
}

function usageLevel(percent: number): ContextUsage['level'] {
  if (percent >= 95) return 'full';
  if (percent >= 80) return 'warn';
  return 'ok';
}

/**
 * Context chip numbers for a conversation view.
 * `used` / `percent` match `contextUsed` / `contextPercents` in core/usage-math.mjs.
 * Missing usage counts as 0; missing window uses DEFAULT_CONTEXT_WINDOW (128000).
 */
export function contextUsageView({ usage, window }: ContextUsageInput = {}): ContextUsage {
  const usedRaw = contextUsed(usage);
  const used = usedRaw == null ? 0 : usedRaw;
  const resolvedWindow = positiveWindow(window);
  const { usedPct } = contextPercents(used, resolvedWindow);
  return {
    used,
    window: resolvedWindow,
    percent: usedPct,
    level: usageLevel(usedPct),
  };
}
