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
//   backgroundTokens 0 means no background compaction; Weft only uses it for
//   windows too small to fit a 5% margin below the blocking line.
// - The context window is the model object's contextWindow at that prepare,
//   which Weft's provider overlay has already replaced with the user override
//   when one is set (src/kernel/models.mjs applyModelOverrides).
// - A model switch is the next prepare's agent.model. A percent change is the
//   next settings() read. Neither needs a new Harness.
//
// This module only builds the settings object. It does not decide when to compact.

import { DEFAULT_TRIGGER_PERCENT } from '../core/settings.mjs';

/**
 * Room kept free below the window. It is also what Pi sizes the summary request
 * from: maxTokens = floor(0.8 * reserveTokens) (compaction.js), and thinking
 * counts against it. 10% of the window is only ~10k summary tokens at 128k,
 * too little for a long, code-heavy conversation, so the reserve is at least
 * min(32000, 25% of W), and never below the old 10%.
 */
export function compactionReserve(window) {
  const w = Math.floor(Number(window));
  return Math.max(Math.floor(w * 0.1), Math.min(32000, Math.floor(w * 0.25)));
}

/**
 * reserve / background / keepRecent for one effective window W and trigger p.
 * Blocking compaction starts at W - reserve. Background compaction starts at
 * W * p%, but never later than 5% of W before the blocking line, so a high p
 * (or a window whose blocking line is below p) still compacts in the
 * background instead of stalling the next reply. backgroundTokens is the
 * distance from the background start up to the blocking line; it is 0 (the
 * official "no background compaction") only when the window is too small for
 * a 5% margin to fit below the blocking line.
 */
export function compactionBudget(window, percent = DEFAULT_TRIGGER_PERCENT) {
  const w = Math.floor(Number(window));
  const p = Math.floor(Number(percent));
  const reserveTokens = compactionReserve(w);
  const blocking = w - reserveTokens;
  const margin = Math.floor(w * 0.05);
  const backgroundTokens = blocking - margin > 0
    ? Math.max(margin, blocking - Math.floor((w * p) / 100))
    : 0;
  return {
    reserveTokens,
    backgroundTokens,
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

/**
 * Models whose real background-compaction start is earlier than p% of their
 * window. Same registered models and same compactionBudget as
 * compactionOverrides; start = blocking line - backgroundTokens (the blocking
 * line itself when background compaction is off). percent is rounded to an
 * integer; a model is listed only when that integer is below p. `selectable`
 * (a Set of "provider/modelId", see selectableModelKeys) limits the list to
 * models the user can pick; without it every registered model is considered.
 */
export function effectiveTriggers(models, percent = DEFAULT_TRIGGER_PERCENT, selectable = null) {
  const p = Math.floor(Number(percent));
  const out = [];
  const list = typeof models?.getAllModels === 'function' ? models.getAllModels() : [];
  for (const model of list) {
    const window = model?.contextWindow;
    const provider = typeof model?.provider === 'string' ? model.provider : '';
    const id = typeof model?.id === 'string' ? model.id : '';
    if (!provider || !id || !Number.isInteger(window) || window <= 0) continue;
    if (selectable && !selectable.has(`${provider}/${id}`)) continue;
    const budget = compactionBudget(window, p);
    const start = window - budget.reserveTokens - budget.backgroundTokens;
    const startPercent = Math.round((start * 100) / window);
    if (startPercent >= p) continue;
    const name = typeof model.name === 'string' && model.name.trim() ? model.name : id;
    out.push({ providerId: provider, modelId: id, name, percent: startPercent });
  }
  return out;
}

/**
 * "provider/modelId" of every model the composer's model picker lists: the
 * enabled models of the configured providers (providerService.listProviders()).
 */
export function selectableModelKeys(providers) {
  const keys = new Set();
  for (const provider of Array.isArray(providers) ? providers : []) {
    for (const model of Array.isArray(provider?.models) ? provider.models : []) {
      if (model?.enabled === true && typeof model.id === 'string' && model.id.trim()) {
        keys.add(`${provider.id}/${model.id}`);
      }
    }
  }
  return keys;
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

/**
 * A manual compaction that finished without placing a summary (nothing old enough
 * to compact). Stored as a write-submission entry with no model contribution, so
 * it follows the conversation history and never reaches the model.
 */
export const COMPACTION_SKIPPED_KIND = 'weft.compaction-skipped';
