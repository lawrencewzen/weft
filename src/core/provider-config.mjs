import { randomBytes } from 'node:crypto';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  isValidContextWindow,
  normalizeHttpUrl,
} from './model-sources.mjs';
import { isThinkingLevelName } from './thinking-level.mjs';

export const SETTINGS_VERSION_V3 = 3;
export const CUSTOM_PROVIDER_ID = /^custom-[0-9a-f]{8}$/;
export const CUSTOM_PROVIDER_APIS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]);

const CUSTOM_API = new Set(CUSTOM_PROVIDER_APIS);
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function createCustomProviderId() {
  return `custom-${randomBytes(4).toString('hex')}`;
}

function builtinIdSet() {
  return new Set(getBuiltinProviders());
}

function cleanName(value, fallback) {
  const name = String(value ?? '').trim().slice(0, 80);
  return name || fallback;
}

function copyLastTest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let at;
  if (typeof value.at === 'number' && Number.isFinite(value.at) && value.at > 0) {
    at = Math.round(value.at);
  } else if (typeof value.at === 'string' && value.at.trim()) {
    at = value.at.trim().slice(0, 40);
  }
  if (at == null || at === '') return undefined;
  const last = { ok: value.ok === true, at };
  if (typeof value.code === 'string' && value.code.trim()) {
    last.code = value.code.trim().slice(0, 40);
  }
  const status = typeof value.status === 'number' ? value.status : Number(value.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) last.status = status;
  if (!last.ok && value.error != null) {
    const error = String(value.error).trim();
    if (error) last.error = error.slice(0, 500);
  }
  return last;
}

function enabledFrom(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim().slice(0, 200);
    if (!name || out.includes(name)) continue;
    if (out.length >= 100) break;
    out.push(name);
  }
  return out;
}

function normalizeOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawId, raw] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(rawId)) continue;
    const modelId = String(rawId).trim();
    if (!modelId || BLOCKED_KEYS.has(modelId) || Object.prototype.hasOwnProperty.call(out, modelId)) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = {};
    if (isValidContextWindow(raw.contextWindow)) entry.contextWindow = raw.contextWindow;
    if (isValidContextWindow(raw.maxTokens)) entry.maxTokens = raw.maxTokens;
    if (typeof raw.images === 'boolean') entry.images = raw.images;
    if (isThinkingLevelName(raw.thinkingLevel)) entry.thinkingLevel = raw.thinkingLevel;
    if (!Object.keys(entry).length) continue;
    out[modelId] = entry;
  }
  return out;
}

/**
 * Validate / clean settings.providers. Illegal items are dropped.
 * builtin ids must be pi-ai provider ids; custom ids are `custom-` + 8 hex.
 */
export function normalizeProvidersV3(raw) {
  if (!Array.isArray(raw)) return [];
  const builtins = builtinIdSet();
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const kind = item.kind === 'custom' ? 'custom' : item.kind === 'builtin' ? 'builtin' : '';
    if (!kind) continue;
    const id = String(item.id || '').trim();
    if (kind === 'builtin') {
      if (!builtins.has(id)) continue;
    } else if (!CUSTOM_PROVIDER_ID.test(id)) {
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const enabled = enabledFrom(item.enabled);
    const overrides = normalizeOverrides(item.overrides);
    const lastTest = copyLastTest(item.lastTest);
    if (kind === 'builtin') {
      const provider = { id, kind, enabled, overrides };
      if (lastTest) provider.lastTest = lastTest;
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 80) : '';
      if (name) provider.name = name;
      out.push(provider);
      continue;
    }

    const api = item.api == null || item.api === ''
      ? 'openai-completions'
      : String(item.api).trim();
    if (!CUSTOM_API.has(api)) continue;
    const provider = {
      id,
      kind,
      name: cleanName(item.name, '自定义 API'),
      baseUrl: normalizeHttpUrl(item.baseUrl),
      api,
      enabled,
      overrides,
    };
    if (typeof item.images === 'boolean') provider.images = item.images;
    if (isThinkingLevelName(item.defaultThinkingLevel)) provider.defaultThinkingLevel = item.defaultThinkingLevel;
    // Legacy per-provider defaultModel is discarded. settings.defaultModel is the only source.
    if (lastTest) provider.lastTest = lastTest;
    out.push(provider);
  }
  return out;
}
