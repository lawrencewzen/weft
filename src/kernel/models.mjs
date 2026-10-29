// Real model sources for the Pi Durable kernel.
// Providers are pi-ai catalogs on the Harness. This module does not schedule
// work, store checkpoints, or fall back to the faux provider.
import { stream as completionsStream, streamSimple as completionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { createProvider } from '@earendil-works/pi-ai/models';
import { contextWindowFromEnv } from '../core/usage.mjs';
import {
  contextWindowForModel,
  effectiveBaseUrl,
  normalizeSources,
  resolveConversationTarget,
  sourceAvailable,
} from '../core/model-sources.mjs';
import {
  catalogFingerprint,
  catalogMaxTokens,
  lookupModelCatalog,
} from './model-catalog.mjs';

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

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

function maxTokensForModel(catalog, contextWindow, env) {
  const explicit = explicitMaxOutputTokens(env);
  const fromCatalog = catalogMaxTokens(catalog);
  const tokens = explicit ?? fromCatalog ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return capMaxTokens(tokens, contextWindow);
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

export function providerIdForSource(source) {
  if (!source) return '';
  return `src-${source.id}`;
}

function chatModel({ provider, id, api, baseUrl, headers, source, env }) {
  const catalog = lookupModelCatalog(id, baseUrl);
  const contextWindow = contextWindowForModel(source, id, env, baseUrl);
  const model = {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    // Catalog reasoning/thinkingLevelMap would inject thinking fields on
    // DeepSeek when no thinking level is selected. Keep the previous request
    // shape; see tests that compare fake-server bodies.
    reasoning: false,
    input: Array.isArray(catalog?.input) && catalog.input.length ? clonePlain(catalog.input) : ['text'],
    cost: catalog?.cost && typeof catalog.cost === 'object' ? clonePlain(catalog.cost) : COST,
    contextWindow: contextWindow ?? contextWindowFromEnv(env),
    maxTokens: maxTokensForModel(catalog, contextWindow, env),
    ...(headers ? { headers } : {}),
  };
  if (catalog?.compat && typeof catalog.compat === 'object' && !Array.isArray(catalog.compat)) {
    model.compat = clonePlain(catalog.compat);
  }
  return model;
}

function modelIds(source, extra) {
  const out = [];
  const list = Array.isArray(source?.models) ? source.models : [];
  for (const item of [...list, extra]) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (!name || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

function withoutAuthorization(base) {
  return (model, context, options) => base(model, context, {
    ...options,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      headers.delete('authorization');
      const fetchImpl = options?.fetch || globalThis.fetch;
      return fetchImpl(input, { ...init, headers });
    },
  });
}

function createOpenAICompatProvider({ id, baseUrl, apiKey, modelList, contextWindows, env }) {
  const key = String(apiKey || '');
  const api = key
    ? { stream: completionsStream, streamSimple: completionsStreamSimple }
    : { stream: withoutAuthorization(completionsStream), streamSimple: withoutAuthorization(completionsStreamSimple) };
  const source = { contextWindows };
  return createProvider({
    id,
    name: 'OpenAI-compatible',
    baseUrl,
    auth: {
      apiKey: {
        name: 'OpenAI-compatible API key',
        async resolve() {
          // A keyless source (Ollama) still has to satisfy pi-ai's apiKey check.
          // The request wrapper removes Authorization so the placeholder is not sent.
          if (!key) return { auth: { apiKey: 'local' }, source: 'kernel-openai-compat' };
          return { auth: { apiKey: key }, source: 'kernel-openai-compat' };
        },
      },
    },
    models: modelList.map((modelId) => chatModel({
      provider: id,
      id: modelId,
      api: 'openai-completions',
      baseUrl,
      source,
      env,
    })),
    api,
  });
}

/**
 * Register one provider per available source. Call again after settings change;
 * updated sources replace their provider and removed sources are dropped.
 * Returns the model ref for this turn, or null when nothing can be called.
 */
export function createKernelModels({ models, getSettings, env = process.env } = {}) {
  if (!models || typeof models.setProvider !== 'function') throw new Error('models is required');
  const apiFingerprints = new Map();

  function dropApi(id) {
    models.deleteProvider(id);
    apiFingerprints.delete(id);
  }

  function installApi(source, extra) {
    const id = providerIdForSource(source);
    const ids = modelIds(source, extra);
    const baseUrl = effectiveBaseUrl(source);
    if (!id || !baseUrl || !ids.length) {
      if (id && apiFingerprints.has(id)) dropApi(id);
      return;
    }
    const fingerprint = JSON.stringify([
      baseUrl,
      source.apiKey || '',
      ids,
      source.contextWindows || null,
      maxOutputTokensFromEnv(env),
      ids.map((modelId) => catalogFingerprint(modelId, baseUrl)),
    ]);
    if (apiFingerprints.get(id) === fingerprint) return;
    models.setProvider(createOpenAICompatProvider({
      id,
      baseUrl,
      apiKey: source.apiKey || '',
      modelList: ids,
      contextWindows: source.contextWindows,
      env,
    }));
    apiFingerprints.set(id, fingerprint);
  }

  function sync(settings, { target }) {
    const sources = normalizeSources(settings?.sources);
    const wanted = new Set();
    for (const source of sources) {
      const extra = target?.source?.id === source.id ? target.model : '';
      if (!sourceAvailable(source)) continue;
      installApi(source, extra);
      const id = providerIdForSource(source);
      if (id) wanted.add(id);
    }
    for (const id of [...apiFingerprints.keys()]) {
      if (!wanted.has(id)) dropApi(id);
    }
  }

  return {
    /** Install every available source before resume, so a restarted child can call its model. */
    async warm() {
      if (typeof getSettings !== 'function') return;
      const settings = await getSettings();
      sync(settings, { target: null });
    },
    async modelFor(conv) {
      if (typeof getSettings !== 'function') return null;
      const settings = await getSettings();
      const target = resolveConversationTarget(settings, conv);
      sync(settings, { target });
      if (!target?.source || !target.model) return null;
      return { provider: providerIdForSource(target.source), modelId: target.model };
    },
  };
}
