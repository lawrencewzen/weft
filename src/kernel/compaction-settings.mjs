// Compaction thresholds for Pi Durable.
//
// Official (pi-durable 1.5.0):
// - HarnessOptions.settings may be a function, read at each use
//   (dist/harness/harness.js currentSettings; types.d.ts HarnessSettings).
// - compactionPolicy(settings, model) overlays modelOverrides["provider/modelId"]
//   onto the harness-wide policy, field by field (dist/harness/compaction.js).
// - Generation reads that policy at each prepare and again when classifying an
//   overflow. It does not copy the policy onto the checkpoint.
// - thresholdCompaction (dist/harness/generation.js): no automatic compaction
//   when contextWindow <= 0. Blocking starts above contextWindow - reserveTokens.
//   Background starts backgroundTokens below that, and only when backgroundTokens > 0.
//   backgroundTokens 0 means no background compaction (the p=90 case).
// - The context window is the model object's contextWindow at that prepare,
//   which Weft's provider overlay has already replaced with the user override
//   when one is set (src/kernel/models.mjs applyModelOverrides).
// - A model switch is the next prepare's agent.model. A percent change is the
//   next settings() read. Neither needs a new Harness.
//
// This module only builds the settings object. It does not decide when to compact.

import { DEFAULT_TRIGGER_PERCENT } from '../core/settings.mjs';

/**
 * reserve / background / keepRecent for one effective window W and trigger p.
 * p=90 → backgroundTokens 0, which is the official "no background compaction".
 */
export function compactionBudget(window, percent = DEFAULT_TRIGGER_PERCENT) {
  const w = Math.floor(Number(window));
  const p = Math.floor(Number(percent));
  return {
    reserveTokens: Math.floor((w * 10) / 100),
    backgroundTokens: Math.floor((w * (90 - p)) / 100),
    keepRecentTokens: Math.min(20000, Math.floor((w * 20) / 100)),
  };
}

/**
 * modelOverrides for every registered model whose contextWindow is a positive
 * integer. A window of 0 or missing is left unset: official thresholdCompaction
 * already skips automatic compaction when contextWindow <= 0, and inventing a
 * fallback window here would not match the window the generation actually uses.
 */
export function compactionOverrides(models, percent = DEFAULT_TRIGGER_PERCENT) {
  const modelOverrides = {};
  const list = typeof models?.getAllModels === 'function' ? models.getAllModels() : [];
  for (const model of list) {
    const window = model?.contextWindow;
    const provider = typeof model?.provider === 'string' ? model.provider : '';
    const id = typeof model?.id === 'string' ? model.id : '';
    if (!provider || !id || !Number.isInteger(window) || window <= 0) continue;
    modelOverrides[`${provider}/${id}`] = compactionBudget(window, percent);
  }
  return { enabled: true, modelOverrides };
}

/** Synchronous snapshot. settings() runs on the Session line, so it must not scan providers. */
export function createCompactionControl(models) {
  let percent = DEFAULT_TRIGGER_PERCENT;
  let current = { enabled: true, modelOverrides: {} };

  function rebuild() {
    current = compactionOverrides(models, percent);
  }

  return {
    current() {
      return current;
    },
    percent() {
      return percent;
    },
    setPercent(next) {
      percent = next;
      rebuild();
    },
    rebuild,
  };
}
