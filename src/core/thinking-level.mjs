import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';

/** Canonical pi-ai thinking levels, low to high. */
export const THINKING_LEVEL_NAMES = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export function isThinkingLevelName(value) {
  return typeof value === 'string' && THINKING_LEVEL_NAMES.includes(value);
}

/**
 * Levels the UI may offer. Non-reasoning models have none (not `["off"]`).
 * Order matches `getSupportedThinkingLevels`.
 */
export function thinkingLevelsOf(model) {
  if (!model?.reasoning) return [];
  return getSupportedThinkingLevels(model);
}

/**
 * Every reasoning model defaults to `medium`, then `clampThinkingLevel`.
 * No thinking → null.
 */
export function defaultThinkingLevelOf(model) {
  if (!thinkingLevelsOf(model).length) return null;
  return clampThinkingLevel(model, 'medium');
}

/**
 * Custom `/models` `effort.supported_levels` → a pi-ai `thinkingLevelMap`.
 * Always includes `off`. Unknown names are dropped. Missing / non-array → null
 * (the model does not support thinking).
 */
export function thinkingLevelMapFromSupportedLevels(levels) {
  if (!Array.isArray(levels)) return null;
  const allowed = new Set();
  allowed.add('off');
  for (const item of levels) {
    if (isThinkingLevelName(item)) allowed.add(item);
  }
  const map = {};
  for (const name of THINKING_LEVEL_NAMES) {
    map[name] = allowed.has(name) ? name : null;
  }
  return map;
}

/**
 * Effective level for a conversation: stored name clamped to the model,
 * or the model default when nothing is stored.
 */
export function effectiveThinkingLevel(model, stored) {
  const levels = thinkingLevelsOf(model);
  if (!levels.length) return null;
  if (isThinkingLevelName(stored)) return clampThinkingLevel(model, stored);
  return defaultThinkingLevelOf(model);
}

export function thinkingFieldsOf(model) {
  return {
    thinkingLevels: thinkingLevelsOf(model),
    defaultThinkingLevel: defaultThinkingLevelOf(model),
  };
}

/**
 * Value to pass to `configure({ thinkingLevel })`.
 * `undefined` means omit (model does not support thinking).
 */
export function configureThinkingLevel(model, stored) {
  const level = effectiveThinkingLevel(model, stored);
  return level == null ? undefined : level;
}

/** PATCH body: missing → not present; null clears; other values must be a canonical name. */
export function parseThinkingLevelPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { present: false };
  if (!Object.prototype.hasOwnProperty.call(input, 'thinkingLevel')) return { present: false };
  const value = input.thinkingLevel;
  if (value === null) return { present: true, ok: true, value: null };
  if (!isThinkingLevelName(value)) {
    return { present: true, ok: false, error: 'invalid thinkingLevel' };
  }
  return { present: true, ok: true, value };
}
