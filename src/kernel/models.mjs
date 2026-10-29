// Real model sources for the Pi Durable kernel.
// Providers are pi-ai catalogs on the Harness. This module does not schedule
// work, store checkpoints, or fall back to the faux provider.
//
// Built-in factories come from `@earendil-works/pi-ai/providers/all`.
// That entry loads every bundled catalog (~42 providers), so Node still pays
// the catalog parse cost at import time. We only `setProvider` for ids that
// appear in settings.providers — unused vendors are not registered.
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createProvider } from '@earendil-works/pi-ai/models';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { contextWindowFromEnv } from '../core/usage.mjs';
import { normalizeProvidersV3 } from '../core/provider-config.mjs';
import { normalizeHttpUrl } from '../core/model-sources.mjs';

export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

let builtinList = null;

function allBuiltinProviders() {
  if (!builtinList) builtinList = builtinProviders();
  return builtinList;
}

export function builtinProviderById(id) {
  return allBuiltinProviders().find((item) => item.id === id) || null;
}

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function explicitMaxOutputTokens(env = process.env) {
  const raw = env?.WEFT_MAX_OUTPUT_TOKENS;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Positive integer from `WEFT_MAX_OUTPUT_TOKENS`, otherwise 32768. */
export function maxOutputTokensFromEnv(env = process.env) {
  return explicitMaxOutputTokens(env) ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

function capMaxTokens(tokens, contextWindow) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return tokens;
  return Math.min(tokens, contextWindow);
}

function namedRuntime(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'faux' || text === 'openai') return text;
  return '';
}

/**
 * A scripted model is used only when it is requested: `WEFT_LLM=faux`,
 * `LLM_API=faux`, or `WEFT_FAUX_SCRIPT`. Explicit `openai` forces the real
 * client. Otherwise an API key or base URL selects that client.
 * With none of those, return `none` so the server refuses the turn.
 */
export function selectChatRuntime(explicit, {
  hasApiKey = false,
  hasBaseUrl = false,
  llmApi = '',
  fauxScript = false,
} = {}) {
  const chosen = namedRuntime(explicit);
  if (chosen) return chosen;
  if (namedRuntime(llmApi) === 'faux' || fauxScript) return 'faux';
  if (hasApiKey || hasBaseUrl) return 'openai';
  return 'none';
}

/**
 * Faux is on only when the process asks for it: `WEFT_LLM=faux`,
 * `LLM_API=faux`, or `WEFT_FAUX_SCRIPT`. Anything else stays off.
 */
export function explicitDemo(env = process.env) {
  return selectChatRuntime(env?.WEFT_LLM, {
    llmApi: env?.LLM_API,
    fauxScript: Boolean(String(env?.WEFT_FAUX_SCRIPT || '').trim()),
  }) === 'faux';
}

export function firstPositiveInteger(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function modalitiesOf(item) {
  if (Array.isArray(item?.input_modalities)) return item.input_modalities;
  if (Array.isArray(item?.architecture?.input_modalities)) return item.architecture.input_modalities;
  return [];
}

function hasImageModality(item) {
  return modalitiesOf(item).some((value) => String(value).toLowerCase() === 'image');
}

function hasReasoningField(item) {
  if (!item || typeof item !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(item, 'effort')
    || Object.prototype.hasOwnProperty.call(item, 'reasoning');
}

function rowsFromModelsJson(json) {
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.models)) return json.models;
  if (Array.isArray(json)) return json;
  return [];
}

function chatModelFromFetched(item, { providerId, api, baseUrl }) {
  const rawId = typeof item === 'string' ? item : item?.id;
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id) return null;
  const rec = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
  const name = String(rec.name || rec.display_name || id).trim() || id;
  const contextWindow = firstPositiveInteger(
    rec.context_window,
    rec.context_length,
    rec.max_context_length,
    rec.max_model_len,
    rec.top_provider?.context_length,
  );
  const maxTokens = firstPositiveInteger(
    rec.max_output_tokens,
    rec.max_completion_tokens,
    rec.top_provider?.max_completion_tokens,
  );
  return {
    id,
    name,
    api,
    provider: providerId,
    baseUrl,
    reasoning: hasReasoningField(rec),
    input: hasImageModality(rec) ? ['text', 'image'] : ['text'],
    cost: { ...COST },
    contextWindow: contextWindow ?? 0,
    maxTokens: maxTokens ?? 0,
  };
}

/** Parse an OpenAI-style `/models` body into pi-ai chat models. */
export function parseFetchedChatModels(json, meta) {
  const out = [];
  const seen = new Set();
  for (const item of rowsFromModelsJson(json)) {
    const model = chatModelFromFetched(item, meta);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

function modelsUrl(baseUrl) {
  const root = normalizeHttpUrl(baseUrl);
  if (!root) return '';
  const url = new URL(root);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function fetchCustomProviderModels(context, {
  id,
  api,
  baseUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = modelsUrl(context?.baseUrl || baseUrl);
  if (!url) return [];
  const headers = { accept: 'application/json' };
  const key = typeof context?.credential?.key === 'string' ? context.credential.key.trim() : '';
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers,
    signal: context?.signal,
  });
  const text = typeof res.text === 'function' ? await res.text() : '';
  if (!res.ok) {
    const err = new Error(`models probe failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch {
    throw new Error('invalid JSON');
  }
  return parseFetchedChatModels(json, { providerId: id, api, baseUrl: normalizeHttpUrl(baseUrl) });
}

function catalogMaxTokens(model) {
  if (Number.isInteger(model?.maxTokens) && model.maxTokens > 0) return model.maxTokens;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Request-time window/maxTokens. Display in provider-service still reads the
 * catalog (or user override) and is not capped here.
 * maxTokens: overrides.maxTokens > WEFT_MAX_OUTPUT_TOKENS > min(catalog, 32768),
 * then capMaxTokens against the effective context window.
 */
function applyModelOverrides(model, overrides, env) {
  const over = overrides && typeof overrides === 'object' ? overrides[model.id] : null;
  const fallbackWindow = contextWindowFromEnv(env);
  let contextWindow = over?.contextWindow;
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    contextWindow = Number.isInteger(model.contextWindow) && model.contextWindow > 0
      ? model.contextWindow
      : fallbackWindow;
  }
  let maxTokens = over?.maxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    const explicitMax = explicitMaxOutputTokens(env);
    maxTokens = explicitMax ?? Math.min(catalogMaxTokens(model), DEFAULT_MAX_OUTPUT_TOKENS);
  }
  maxTokens = capMaxTokens(maxTokens, contextWindow);
  if (model.contextWindow === contextWindow && model.maxTokens === maxTokens) return model;
  const next = clonePlain(model);
  next.contextWindow = contextWindow;
  next.maxTokens = maxTokens;
  return next;
}

function overlayProvider(provider, overrides, env) {
  if (!provider) return provider;
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === 'getModels') {
        return () => target.getModels().map((model) => applyModelOverrides(model, overrides, env));
      }
      if (prop === 'getAllModels') {
        return () => {
          const list = typeof target.getAllModels === 'function' ? target.getAllModels() : target.getModels();
          return list.map((model) => applyModelOverrides(model, overrides, env));
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function apiStreams(api) {
  if (api === 'openai-responses') return openAIResponsesApi();
  if (api === 'anthropic-messages') return anthropicMessagesApi();
  return openAICompletionsApi();
}

function stubChatModel({ providerId, id, api, baseUrl }) {
  return {
    id,
    name: id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: hasReasoningField(null),
    input: ['text'],
    cost: { ...COST },
    contextWindow: 0,
    maxTokens: 0,
  };
}

function customAuth(name) {
  return {
    apiKey: {
      name: `${name} API key`,
      async resolve({ credential } = {}) {
        const key = typeof credential?.key === 'string' ? credential.key.trim() : '';
        if (key) return { auth: { apiKey: key }, source: 'stored credential' };
        return { auth: {} };
      },
    },
  };
}

export function buildCustomProvider(entry, { env, fetchImpl } = {}) {
  const id = entry.id;
  const name = entry.name || '自定义 API';
  const baseUrl = normalizeHttpUrl(entry.baseUrl);
  const api = entry.api || 'openai-completions';
  const enabled = Array.isArray(entry.enabled) ? entry.enabled : [];
  const models = enabled.map((modelId) => stubChatModel({
    providerId: id,
    id: modelId,
    api,
    baseUrl,
  }));
  return overlayProvider(createProvider({
    id,
    name,
    baseUrl,
    auth: customAuth(name),
    models,
    fetchModels: (context) => fetchCustomProviderModels(context, { id, api, baseUrl, fetchImpl }),
    api: apiStreams(api),
  }), entry.overrides || {}, env);
}

export function buildBuiltinProvider(entry, { env } = {}) {
  const base = builtinProviderById(entry.id);
  if (!base) return null;
  return overlayProvider(base, entry.overrides || {}, env);
}

function defaultModelOf(settings) {
  const value = settings?.defaultModel;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

function providerEnabled(entry, modelId) {
  const enabled = Array.isArray(entry?.enabled) ? entry.enabled : [];
  return enabled.includes(modelId);
}

export function resolveKernelTarget(settings, conv) {
  const providers = normalizeProvidersV3(settings?.providers);
  const byId = new Map(providers.map((item) => [item.id, item]));
  const sourceId = typeof conv?.modelSourceId === 'string' ? conv.modelSourceId.trim() : '';
  const modelId = typeof conv?.modelId === 'string' ? conv.modelId.trim() : '';
  if (sourceId && modelId) {
    const entry = byId.get(sourceId);
    if (entry && providerEnabled(entry, modelId)) {
      return { provider: sourceId, modelId };
    }
  }
  const fallback = defaultModelOf(settings);
  if (fallback) {
    const entry = byId.get(fallback.providerId);
    if (entry && providerEnabled(entry, fallback.modelId)) {
      return { provider: fallback.providerId, modelId: fallback.modelId };
    }
  }
  return null;
}

function fingerprintOf(entry, env) {
  return JSON.stringify([
    entry.id,
    entry.kind,
    entry.name || '',
    entry.baseUrl || '',
    entry.api || '',
    entry.enabled || [],
    entry.overrides || {},
    maxOutputTokensFromEnv(env),
    contextWindowFromEnv(env),
  ]);
}

/**
 * Register one provider per settings.providers row. Call again after settings
 * change; updated providers replace their registration and removed ids drop.
 * Returns the model ref for this turn, or null when nothing can be called.
 */
export function createKernelModels({
  models,
  getSettings,
  env = process.env,
  fetchImpl,
} = {}) {
  if (!models || typeof models.setProvider !== 'function') throw new Error('models is required');
  const fingerprints = new Map();

  function drop(id) {
    models.deleteProvider(id);
    fingerprints.delete(id);
  }

  async function install(entry) {
    const id = entry?.id;
    if (!id) return;
    const fingerprint = fingerprintOf(entry, env);
    if (fingerprints.get(id) === fingerprint && models.getProvider(id)) return;
    let provider = null;
    if (entry.kind === 'builtin') provider = buildBuiltinProvider(entry, { env });
    else if (entry.kind === 'custom') provider = buildCustomProvider(entry, { env, fetchImpl });
    if (!provider) {
      drop(id);
      return;
    }
    models.setProvider(provider);
    fingerprints.set(id, fingerprint);
    if (typeof models.refresh === 'function' && entry.kind === 'custom') {
      await models.refresh({ providers: [id], allowNetwork: false });
    }
  }

  async function sync(settings) {
    const providers = normalizeProvidersV3(settings?.providers);
    const wanted = new Set();
    for (const entry of providers) {
      wanted.add(entry.id);
      await install(entry);
    }
    for (const id of [...fingerprints.keys()]) {
      if (!wanted.has(id)) drop(id);
    }
  }

  return {
    /** Install every configured provider before resume, so a restarted child can call its model. */
    async warm() {
      if (typeof getSettings !== 'function') return;
      await sync(await getSettings());
    },
    async modelFor(conv) {
      if (typeof getSettings !== 'function') return null;
      const settings = await getSettings();
      await sync(settings);
      return resolveKernelTarget(settings, conv);
    },
  };
}
