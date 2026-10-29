import { randomBytes } from 'node:crypto';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  isValidContextWindow,
  normalizeHttpUrl,
  vendorPreset,
} from './model-sources.mjs';

export const SETTINGS_VERSION_V3 = 3;
export const CUSTOM_PROVIDER_ID = /^custom-[0-9a-f]{8}$/;
export const CUSTOM_PROVIDER_APIS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]);

const CUSTOM_API = new Set(CUSTOM_PROVIDER_APIS);
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DROPPED_VENDORS = new Set(['xai', 'grok']);

/** Old vendor id → first-occurrence pi-ai builtin provider id. Others stay custom. */
const VENDOR_TO_BUILTIN = {
  deepseek: 'deepseek',
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  moonshot: 'moonshotai-cn',
  openrouter: 'openrouter',
};

const STRIP_ON_MIGRATE = new Set([
  'version',
  'sources',
  'models',
  'apiKey',
  'provider',
  'baseUrl',
  'providers',
  'defaultModel',
]);

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
    if (!Object.keys(entry).length) continue;
    out[modelId] = entry;
  }
  return out;
}

function overridesFromContextWindows(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawId, raw] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(rawId)) continue;
    const modelId = String(rawId).trim();
    if (!modelId || BLOCKED_KEYS.has(modelId) || Object.prototype.hasOwnProperty.call(out, modelId)) continue;
    if (!isValidContextWindow(raw)) continue;
    out[modelId] = { contextWindow: raw };
  }
  return out;
}

function uniqueCustomId(used) {
  for (let i = 0; i < 16; i += 1) {
    const id = createCustomProviderId();
    if (!used.has(id)) return id;
  }
  throw new Error('could not allocate a custom provider id');
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
    if (lastTest) provider.lastTest = lastTest;
    out.push(provider);
  }
  return out;
}

function apiKeyFrom(source) {
  const key = typeof source?.apiKey === 'string' ? source.apiKey.trim() : '';
  return key || '';
}

function matchesPresetUrl(vendor, baseUrl) {
  const url = normalizeHttpUrl(baseUrl);
  const preset = normalizeHttpUrl(vendorPreset(vendor)?.baseUrl);
  if (!preset) return false;
  return !url || url === preset;
}

function defaultModelFrom(models, idMap) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return null;
  const value = models.default;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
  const modelId = typeof value.model === 'string' ? value.model.trim().slice(0, 200) : '';
  if (!sourceId || !modelId) return null;
  if (!Object.prototype.hasOwnProperty.call(idMap, sourceId)) return null;
  const providerId = idMap[sourceId];
  if (!providerId) return null;
  return { providerId, modelId };
}

function keepRest(input) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (STRIP_ON_MIGRATE.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Pure v2 → v3 settings migration. Already-v3 input is returned as-is.
 * Credentials are extracted for a later store write (T59-4); this function
 * does not touch sqlite.
 */
export function migrateSettingsV2toV3(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (input.version === SETTINGS_VERSION_V3) {
    return { settings: raw, credentials: [], idMap: {} };
  }

  const sources = Array.isArray(input.sources) ? input.sources : [];
  const usedBuiltins = new Set();
  const usedIds = new Set();
  const providers = [];
  const credentials = [];
  const idMap = {};

  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const oldId = String(source.id || '').trim();
    if (!oldId) continue;

    const kind = source.kind === 'grok' || oldId === 'grok' ? 'grok' : 'api';
    const vendor = String(source.vendor || '').trim().toLowerCase();
    if (kind === 'grok' || DROPPED_VENDORS.has(vendor)) {
      idMap[oldId] = null;
      continue;
    }

    const enabled = enabledFrom(source.models);
    const overrides = overridesFromContextWindows(source.contextWindows);
    const lastTest = copyLastTest(source.lastTest);
    const key = apiKeyFrom(source);
    const builtinId = VENDOR_TO_BUILTIN[vendor];
    const asBuiltin = Boolean(builtinId) && matchesPresetUrl(vendor, source.baseUrl) && !usedBuiltins.has(builtinId);

    let provider;
    if (asBuiltin) {
      usedBuiltins.add(builtinId);
      usedIds.add(builtinId);
      provider = { id: builtinId, kind: 'builtin', enabled, overrides };
      if (lastTest) provider.lastTest = lastTest;
    } else {
      const id = uniqueCustomId(usedIds);
      usedIds.add(id);
      provider = {
        id,
        kind: 'custom',
        name: cleanName(source.name, vendorPreset(vendor)?.name || '自定义 API'),
        baseUrl: normalizeHttpUrl(source.baseUrl),
        api: 'openai-completions',
        enabled,
        overrides,
      };
      if (lastTest) provider.lastTest = lastTest;
    }

    idMap[oldId] = provider.id;
    providers.push(provider);
    if (key) credentials.push({ providerId: provider.id, credential: { type: 'api_key', key } });
  }

  const settings = {
    ...keepRest(input),
    version: SETTINGS_VERSION_V3,
    providers: normalizeProvidersV3(providers),
    defaultModel: defaultModelFrom(input.models, idMap),
  };
  return { settings, credentials, idMap };
}
