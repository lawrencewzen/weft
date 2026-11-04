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
 * `model.defaultThinkingLevel` when it is a canonical name, then
 * `clampThinkingLevel`. Otherwise `medium`, then `clampThinkingLevel`.
 * No thinking → null. pi-ai itself ignores this field; callers that configure
 * a turn use this so a weft override actually takes effect.
 */
export function defaultThinkingLevelOf(model) {
  if (!thinkingLevelsOf(model).length) return null;
  const preferred = isThinkingLevelName(model?.defaultThinkingLevel)
    ? model.defaultThinkingLevel
    : 'medium';
  return clampThinkingLevel(model, preferred);
}

/**
 * One calculation for the settings row and the model that is actually called.
 * Model-level override beats custom-provider defaults, which beat the catalog.
 * Does not invent a `thinkingLevelMap`: missing standard levels stay on the
 * provider default (pi-ai sends map strings as-is, so a fallback `'none'`
 * would go out as `reasoning_effort`).
 *
 * `override` is one model's entry (`images`, `thinkingLevel`).
 * `providerDefaults` is the custom provider (`images`, `defaultThinkingLevel`).
 */
export function applyCapabilityOverrides(model, override, providerDefaults) {
  const base = model && typeof model === 'object' ? model : {};
  const images = chosenImages(override, providerDefaults);
  const input = adjustInput(base.input, images);
  const level = chosenThinkingLevel(override, providerDefaults);
  let reasoning = base.reasoning;
  let defaultThinkingLevel = base.defaultThinkingLevel;
  if (level === 'off') {
    defaultThinkingLevel = 'off';
  } else if (level) {
    reasoning = true;
    defaultThinkingLevel = clampThinkingLevel({ ...base, reasoning: true }, level);
  }
  return {
    input,
    reasoning,
    thinkingLevelMap: base.thinkingLevelMap,
    defaultThinkingLevel,
  };
}

function chosenImages(override, providerDefaults) {
  if (typeof override?.images === 'boolean') return override.images;
  if (typeof providerDefaults?.images === 'boolean') return providerDefaults.images;
  return undefined;
}

function chosenThinkingLevel(override, providerDefaults) {
  if (isThinkingLevelName(override?.thinkingLevel)) return override.thinkingLevel;
  if (isThinkingLevelName(providerDefaults?.defaultThinkingLevel)) return providerDefaults.defaultThinkingLevel;
  return undefined;
}

function adjustInput(input, images) {
  if (typeof images !== 'boolean') return input;
  if (!Array.isArray(input)) return images ? ['text', 'image'] : ['text'];
  const hasImage = input.includes('image');
  if (images) return hasImage ? input : [...input, 'image'];
  return hasImage ? input.filter((item) => item !== 'image') : input;
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
