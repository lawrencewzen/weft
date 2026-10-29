import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { contextWindowFromEnv } from './usage.mjs';
import {
  CUSTOM_PROVIDER_ID,
  CUSTOM_PROVIDER_APIS,
  createCustomProviderId,
  normalizeProvidersV3,
} from './provider-config.mjs';
import { isMaskedOrEmptyApiKey } from './settings.mjs';
import { isValidContextWindow, normalizeHttpUrl, vendorForBaseUrl } from './model-sources.mjs';
import { builtinProviderById, resolveKernelTarget } from '../kernel/models.mjs';

const CUSTOM_API = new Set(CUSTOM_PROVIDER_APIS);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function providersOf(settings) {
  return normalizeProvidersV3(settings?.providers);
}

function defaultModelOf(settings) {
  const value = settings?.defaultModel;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

function lastTestStatus(lastTest) {
  if (!lastTest || typeof lastTest !== 'object') {
    return { state: 'untested' };
  }
  const status = {
    state: lastTest.ok === true ? 'ok' : 'error',
    testedAt: typeof lastTest.at === 'string' ? lastTest.at : undefined,
  };
  if (status.state === 'error' && lastTest.error != null) {
    const error = String(lastTest.error).trim();
    if (error) status.error = error;
  }
  return status;
}

function overrideView(overrides, modelId) {
  const entry = overrides && typeof overrides === 'object' ? overrides[modelId] : null;
  if (!entry || typeof entry !== 'object') return {};
  const out = {};
  if (isValidContextWindow(entry.contextWindow)) out.contextWindow = entry.contextWindow;
  if (isValidContextWindow(entry.maxTokens)) out.maxTokens = entry.maxTokens;
  return out;
}

function displayWindow(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function modelRow(model, { enabled, overridden }) {
  const input = Array.isArray(model?.input) ? model.input : [];
  const over = overridden && Object.keys(overridden).length ? overridden : {};
  return {
    id: model.id,
    name: model.name || model.id,
    enabled: enabled === true,
    contextWindow: over.contextWindow ?? displayWindow(model.contextWindow),
    maxTokens: over.maxTokens ?? displayWindow(model.maxTokens),
    images: input.includes('image'),
    reasoning: model.reasoning === true,
    overridden: over,
  };
}

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function envAuthContext(env) {
  return {
    async env(name) {
      const value = env?.[name];
      if (value == null || value === '') return undefined;
      return String(value);
    },
    async fileExists() {
      return false;
    },
  };
}

/**
 * App-facing model service. No HTTP. Kernel registration stays in kernel/models.mjs.
 */
export function createProviderService({
  store,
  credentials,
  modelsStore,
  env = process.env,
  onChange,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!credentials) throw new Error('credentials is required');
  if (!modelsStore) throw new Error('modelsStore is required');

  async function loadSettings() {
    return store.getSettings();
  }

  async function saveSettings(next) {
    const saved = await store.replaceSettings(next);
    try { onChange?.(); } catch { /* display only */ }
    return saved;
  }

  async function authView(entry) {
    const cred = asRecord(await credentials.read(entry.id));
    if (cred?.type === 'api_key') {
      const key = typeof cred.key === 'string' ? cred.key : '';
      const view = { type: 'api_key' };
      if (key) view.keyTail = key.slice(-4);
      return view;
    }
    if (cred?.type === 'oauth') return { type: 'oauth' };

    if (entry.kind === 'builtin') {
      const provider = builtinProviderById(entry.id);
      const resolve = provider?.auth?.apiKey?.resolve;
      if (typeof resolve === 'function') {
        try {
          const resolved = await resolve({
            ctx: envAuthContext(env),
            credential: undefined,
            signal: AbortSignal.timeout(2_000),
          });
          if (resolved?.auth && resolved.source) {
            return { type: 'env', envVar: String(resolved.source) };
          }
        } catch { /* treat as none */ }
      }
    }
    return { type: 'none' };
  }

  async function builtinModels(id) {
    try {
      if (!getBuiltinProviders().includes(id)) return [];
      return getBuiltinModels(id) || [];
    } catch {
      return [];
    }
  }

  async function customModels(id) {
    const stored = asRecord(await modelsStore.read(id));
    const list = Array.isArray(stored?.models) ? stored.models : [];
    return list.filter((item) => item && typeof item === 'object' && typeof item.id === 'string');
  }

  async function modelsFor(entry) {
    const enabled = new Set(Array.isArray(entry.enabled) ? entry.enabled : []);
    const overrides = entry.overrides && typeof entry.overrides === 'object' ? entry.overrides : {};
    const catalog = entry.kind === 'builtin'
      ? await builtinModels(entry.id)
      : await customModels(entry.id);
    return catalog.map((model) => modelRow(model, {
      enabled: enabled.has(model.id),
      overridden: overrideView(overrides, model.id),
    }));
  }

  async function listProviders() {
    const settings = await loadSettings();
    const out = [];
    for (const entry of providersOf(settings)) {
      const auth = await authView(entry);
      const builtin = entry.kind === 'builtin' ? builtinProviderById(entry.id) : null;
      const item = {
        id: entry.id,
        kind: entry.kind,
        name: entry.kind === 'custom'
          ? (entry.name || '自定义 API')
          : (builtin?.name || entry.id),
        auth,
        status: lastTestStatus(entry.lastTest),
        models: await modelsFor(entry),
      };
      if (entry.kind === 'custom') {
        if (entry.api) item.api = entry.api;
        if (entry.baseUrl) item.baseUrl = entry.baseUrl;
      }
      out.push(item);
    }
    return out;
  }

  async function getDefaultModel() {
    const settings = await loadSettings();
    return defaultModelOf(settings);
  }

  async function setDefaultModel(providerId, modelId) {
    const settings = await loadSettings();
    if (modelId == null || modelId === '') {
      return saveSettings({ ...settings, defaultModel: null });
    }
    const id = String(providerId || '').trim();
    const model = String(modelId || '').trim();
    const entry = providersOf(settings).find((item) => item.id === id);
    if (!entry) {
      const err = new Error('unknown provider');
      err.code = 'E_NOT_FOUND';
      throw err;
    }
    return saveSettings({ ...settings, defaultModel: { providerId: id, modelId: model } });
  }

  function mergeOverrides(current, patch) {
    if (patch === null) return {};
    if (patch == null) return current && typeof current === 'object' ? { ...current } : {};
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      const err = new Error('invalid overrides');
      err.code = 'E_BAD_REQUEST';
      throw err;
    }
    const next = { ...(current && typeof current === 'object' ? current : {}) };
    for (const [rawId, raw] of Object.entries(patch)) {
      const modelId = String(rawId).trim();
      if (!modelId) continue;
      if (raw === null) {
        delete next[modelId];
        continue;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        const err = new Error('invalid overrides');
        err.code = 'E_BAD_REQUEST';
        throw err;
      }
      const entry = { ...(next[modelId] || {}) };
      if (Object.prototype.hasOwnProperty.call(raw, 'contextWindow')) {
        if (raw.contextWindow == null) delete entry.contextWindow;
        else if (!isValidContextWindow(raw.contextWindow)) {
          const err = new Error('invalid context window');
          err.code = 'E_BAD_REQUEST';
          throw err;
        } else entry.contextWindow = raw.contextWindow;
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'maxTokens')) {
        if (raw.maxTokens == null) delete entry.maxTokens;
        else if (!isValidContextWindow(raw.maxTokens)) {
          const err = new Error('invalid max tokens');
          err.code = 'E_BAD_REQUEST';
          throw err;
        } else entry.maxTokens = raw.maxTokens;
      }
      if (Object.keys(entry).length) next[modelId] = entry;
      else delete next[modelId];
    }
    return next;
  }

  async function patchProvider(id, patch = {}) {
    const settings = await loadSettings();
    const providers = providersOf(settings);
    const index = providers.findIndex((item) => item.id === id);
    if (index < 0) {
      const err = new Error('not found');
      err.code = 'E_NOT_FOUND';
      throw err;
    }
    const current = { ...providers[index] };
    if (Array.isArray(patch.enabled)) current.enabled = patch.enabled;
    if (Object.prototype.hasOwnProperty.call(patch, 'overrides')) {
      current.overrides = mergeOverrides(current.overrides, patch.overrides);
    }
    if (current.kind === 'custom') {
      if (typeof patch.name === 'string' && patch.name.trim()) {
        current.name = patch.name.trim().slice(0, 80);
      }
      if (patch.baseUrl != null) {
        const url = normalizeHttpUrl(patch.baseUrl);
        if (!url) {
          const err = new Error('base url required');
          err.code = 'E_BAD_REQUEST';
          throw err;
        }
        current.baseUrl = url;
      }
      if (patch.api != null && patch.api !== '') {
        const api = String(patch.api).trim();
        if (!CUSTOM_API.has(api)) {
          const err = new Error('invalid api');
          err.code = 'E_BAD_REQUEST';
          throw err;
        }
        current.api = api;
      }
    }
    const nextProviders = providers.slice();
    nextProviders[index] = current;
    const saved = await saveSettings({ ...settings, providers: nextProviders });

    if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
      const rawKey = patch.apiKey;
      if (isMaskedOrEmptyApiKey(rawKey)) await credentials.delete(id);
      else {
        await credentials.modify(id, async () => ({ type: 'api_key', key: String(rawKey) }));
      }
      try { onChange?.(); } catch { /* display only */ }
    }
    return saved;
  }

  async function removeProvider(id) {
    const settings = await loadSettings();
    const providers = providersOf(settings);
    if (!providers.some((item) => item.id === id)) {
      const err = new Error('not found');
      err.code = 'E_NOT_FOUND';
      throw err;
    }
    const nextProviders = providers.filter((item) => item.id !== id);
    let defaultModel = defaultModelOf(settings);
    if (defaultModel?.providerId === id) defaultModel = null;
    await saveSettings({ ...settings, providers: nextProviders, defaultModel });
    await credentials.delete(id);
    await modelsStore.delete(id);
    try { onChange?.(); } catch { /* display only */ }
  }

  async function resolveTarget(conv) {
    const settings = await loadSettings();
    const hit = resolveKernelTarget(settings, conv);
    if (!hit) return null;
    return { providerId: hit.provider, modelId: hit.modelId };
  }

  async function contextWindowFor(conv) {
    const target = await resolveTarget(conv);
    if (!target) return null;
    const settings = await loadSettings();
    const entry = providersOf(settings).find((item) => item.id === target.providerId);
    if (!entry) return null;
    const over = entry.overrides?.[target.modelId];
    if (isValidContextWindow(over?.contextWindow)) return over.contextWindow;
    if (entry.kind === 'builtin') {
      const catalog = await builtinModels(entry.id);
      const model = catalog.find((item) => item.id === target.modelId);
      if (displayWindow(model?.contextWindow)) return model.contextWindow;
    } else {
      const catalog = await customModels(entry.id);
      const model = catalog.find((item) => item.id === target.modelId);
      if (displayWindow(model?.contextWindow)) return model.contextWindow;
    }
    return contextWindowFromEnv(env);
  }

  async function hasAvailableModel() {
    const settings = await loadSettings();
    if (resolveKernelTarget(settings, {})) return true;
    for (const entry of providersOf(settings)) {
      if (!Array.isArray(entry.enabled) || !entry.enabled.length) continue;
      const auth = await authView(entry);
      if (entry.kind === 'custom') return true;
      if (auth.type !== 'none') return true;
    }
    return false;
  }

  async function resolveConversationModelPatch(body = {}) {
    if (!body || typeof body !== 'object') return { present: false };
    const hasSource = Object.prototype.hasOwnProperty.call(body, 'modelSourceId');
    const hasModel = Object.prototype.hasOwnProperty.call(body, 'modelId');
    if (!hasSource && !hasModel) return { present: false };
    const sourceId = hasSource ? textOrNull(body.modelSourceId) : null;
    const modelId = hasModel ? textOrNull(body.modelId) : null;
    if (!sourceId && !modelId) {
      return { present: true, ok: true, value: { modelSourceId: null, modelId: null } };
    }
    if (!sourceId || !modelId) {
      return { present: true, ok: false, errors: ['model source and model are required together'] };
    }
    const settings = await loadSettings();
    const entry = providersOf(settings).find((item) => item.id === sourceId);
    if (!entry) return { present: true, ok: false, errors: ['unknown model source'] };
    const names = Array.isArray(entry.enabled) ? entry.enabled : [];
    if (!names.includes(modelId)) return { present: true, ok: false, errors: ['unknown model'] };
    return { present: true, ok: true, value: { modelSourceId: entry.id, modelId } };
  }

  async function seedFromEnv({ baseUrl = '', apiKey = '', model = '' } = {}) {
    const urlText = String(baseUrl || '').trim();
    const key = String(apiKey || '').trim();
    const modelName = String(model || '').trim().slice(0, 200);
    if (!urlText && !key && !modelName) return null;
    const settings = await loadSettings();
    if (providersOf(settings).length) return null;
    const normalized = urlText ? normalizeHttpUrl(urlText) : '';
    if (urlText && !normalized) return null;
    const preset = normalized ? vendorForBaseUrl(normalized) : null;
    const id = createCustomProviderId();
    if (!CUSTOM_PROVIDER_ID.test(id)) return null;
    const provider = {
      id,
      kind: 'custom',
      name: preset?.name || '自定义 API',
      baseUrl: normalized,
      api: 'openai-completions',
      enabled: modelName ? [modelName] : [],
      overrides: {},
    };
    const defaultModel = modelName ? { providerId: id, modelId: modelName } : null;
    await saveSettings({ ...settings, providers: [provider], defaultModel });
    if (key) await credentials.modify(id, async () => ({ type: 'api_key', key }));
    return provider;
  }

  return {
    listProviders,
    getDefaultModel,
    setDefaultModel,
    patchProvider,
    removeProvider,
    resolveTarget,
    contextWindowFor,
    hasAvailableModel,
    resolveConversationModelPatch,
    seedFromEnv,
  };
}
