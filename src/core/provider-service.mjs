import { randomBytes } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { builtinProviders, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { contextWindowFromEnv } from './usage.mjs';
import { redactAuthText } from './redact.mjs';
import {
  CUSTOM_PROVIDER_ID,
  CUSTOM_PROVIDER_APIS,
  createCustomProviderId,
  normalizeProvidersV3,
} from './provider-config.mjs';
import { isMaskedOrEmptyApiKey } from './settings.mjs';
import { isValidContextWindow, normalizeHttpUrl, vendorForBaseUrl } from './model-sources.mjs';
import {
  builtinProviderById,
  buildBuiltinProvider,
  buildCustomProvider,
  fetchCustomProviderModels,
  resolveEffectiveDefault,
  resolveKernelTarget,
} from '../kernel/models.mjs';

export const POPULAR_PROVIDER_IDS = Object.freeze([
  'deepseek',
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'moonshotai-cn',
  'zai',
  'qwen-token-plan-cn',
  'minimax-cn',
  'xiaomi',
]);

export const EXCLUDED_PROVIDER_IDS = new Set(['xai', 'openai-codex', 'radius', 'typesafe']);

const ENABLE_ALL_MAX = 6;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15_000;

/** Same env-var names as pi-ai `dist/env-api-keys.js` / T59-3 gen-mock-providers. */
const ENV_VAR = {
  'ant-ling': 'ANT_LING_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',
  'qwen-token-plan-individual': 'QWEN_TOKEN_PLAN_API_KEY',
  openai: 'OPENAI_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY',
  'google-vertex': 'GOOGLE_CLOUD_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  zai: 'ZAI_API_KEY',
  'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  huggingface: 'HF_TOKEN',
  fireworks: 'FIREWORKS_API_KEY',
  together: 'TOGETHER_API_KEY',
  baseten: 'BASETEN_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
  meta: 'META_API_KEY',
  'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY',
  'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'github-copilot': 'COPILOT_GITHUB_TOKEN',
  anthropic: 'ANTHROPIC_API_KEY',
};

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

function testedAtOf(lastTest) {
  if (typeof lastTest?.at === 'number' && Number.isFinite(lastTest.at) && lastTest.at > 0) {
    return Math.round(lastTest.at);
  }
  if (typeof lastTest?.at === 'string') {
    const parsed = Date.parse(lastTest.at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function lastTestStatus(lastTest) {
  if (!lastTest || typeof lastTest !== 'object') {
    return { state: 'untested' };
  }
  const status = {
    state: lastTest.ok === true ? 'ok' : 'error',
  };
  const testedAt = testedAtOf(lastTest);
  if (testedAt != null) status.testedAt = testedAt;
  if (status.state === 'error' && lastTest.error != null) {
    const error = String(lastTest.error).trim();
    if (error) status.error = error;
  }
  return status;
}

function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) err[key] = value;
  }
  throw err;
}

function defaultEnabledIds(ids) {
  return ids.length <= ENABLE_ALL_MAX ? ids.slice() : [];
}

function oauthAccount(cred) {
  if (!cred || typeof cred !== 'object') return '';
  for (const key of ['account', 'email', 'username', 'user', 'login']) {
    if (typeof cred[key] === 'string' && cred[key].trim()) return cred[key].trim();
  }
  return '';
}

function sessionId() {
  return randomBytes(8).toString('hex');
}

function classifyVerify(raw, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return 'E_AUTH';
  const text = String(raw || '').toLowerCase();
  if (/\b401\b|\b403\b|unauthorized|invalid api key|incorrect api key|authentication/.test(text)) {
    return 'E_AUTH';
  }
  if (/\btimeout\b|timed out|etimedout/.test(text)) return 'E_NETWORK';
  if (/\b(econnrefused|enotfound|econnreset|ehostunreach|enetunreach|eai_again|epipe|econnaborted)\b|socket hang up|failed to fetch|fetch failed|networkerror|network error/.test(text)) {
    return 'E_NETWORK';
  }
  if ((httpStatus >= 400 && httpStatus <= 599) || /\binvalid json\b|\bhttp\s+\d{3}\b/.test(text)) {
    return 'E_HTTP';
  }
  return 'E_NETWORK';
}

function failVerify(err, httpStatus) {
  const raw = redactAuthText(err instanceof Error ? err.message : String(err || 'request failed'));
  const code = classifyVerify(raw, httpStatus);
  fail(code, raw, { status: httpStatus || undefined });
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
  const flags = {};
  if (over.contextWindow != null) flags.contextWindow = true;
  if (over.maxTokens != null) flags.maxTokens = true;
  return {
    id: model.id,
    name: model.name || model.id,
    enabled: enabled === true,
    contextWindow: over.contextWindow ?? displayWindow(model.contextWindow),
    maxTokens: over.maxTokens ?? displayWindow(model.maxTokens),
    images: input.includes('image'),
    reasoning: model.reasoning === true,
    overridden: flags,
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
  fetchImpl = globalThis.fetch,
  models: modelsArg,
  extraProviders = [],
  now = Date.now,
  loginTtlMs = LOGIN_TTL_MS,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!credentials) throw new Error('credentials is required');
  if (!modelsStore) throw new Error('modelsStore is required');

  const extraById = new Map();
  for (const provider of extraProviders) {
    if (provider?.id) extraById.set(provider.id, provider);
  }

  const models = modelsArg || createModels({
    credentials,
    modelsStore,
    authContext: envAuthContext(env),
  });
  for (const provider of extraById.values()) models.setProvider(provider);

  const sessions = new Map();
  const sessionByProvider = new Map();

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
    if (cred?.type === 'oauth') {
      const view = { type: 'oauth' };
      const account = oauthAccount(cred);
      if (account) view.account = account;
      return view;
    }

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

  function catalogById(id) {
    return extraById.get(id) || builtinProviderById(id);
  }

  function envValue(name) {
    const value = env?.[name];
    if (value == null || value === '') return undefined;
    return String(value);
  }

  async function builtinModels(id) {
    try {
      const extra = extraById.get(id);
      if (extra) {
        const list = typeof extra.getModels === 'function' ? extra.getModels() : [];
        return Array.isArray(list) ? list.filter((item) => item && typeof item === 'object' && typeof item.id === 'string') : [];
      }
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
          : (builtin?.name || extraById.get(entry.id)?.name || entry.id),
        auth,
        lastTest: entry.lastTest || null,
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
    const hit = resolveEffectiveDefault(settings);
    if (!hit) return null;
    return { providerId: hit.provider, modelId: hit.modelId };
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
    let settings = await loadSettings();
    const providers = providersOf(settings);
    const index = providers.findIndex((item) => item.id === id);
    if (index < 0) fail('E_NOT_FOUND', 'not found', { phrase: 'src_err_missing' });
    const current = { ...providers[index] };
    if (Array.isArray(patch.enabled)) current.enabled = patch.enabled;
    if (Object.prototype.hasOwnProperty.call(patch, 'overrides')) {
      current.overrides = mergeOverrides(current.overrides, patch.overrides);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'defaultModel')) {
      if (patch.defaultModel == null || patch.defaultModel === '') {
        if (defaultModelOf(settings)?.providerId === id) {
          settings = { ...settings, defaultModel: null };
        }
      } else {
        settings = {
          ...settings,
          defaultModel: { providerId: id, modelId: String(patch.defaultModel).trim() },
        };
      }
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
    return Boolean(resolveKernelTarget(settings, {}));
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

  async function getProvider(id) {
    const listed = await listProviders();
    return listed.find((item) => item.id === id) || null;
  }

  function pickProbeModel(entry, catalog) {
    const enabled = Array.isArray(entry?.enabled) ? entry.enabled : [];
    for (const modelId of enabled) {
      const hit = catalog.find((item) => item.id === modelId);
      if (hit) return hit;
    }
    return catalog[0] || null;
  }

  async function registerForProbe(entry) {
    let provider = extraById.get(entry.id) || null;
    if (!provider) {
      if (entry.kind === 'builtin') provider = buildBuiltinProvider(entry, { env });
      else provider = buildCustomProvider(entry, { env, fetchImpl });
    }
    if (!provider) fail('E_NOT_FOUND', 'not found', { phrase: 'src_err_missing' });
    models.setProvider(provider);
    return provider;
  }

  async function probeChat(entry, { apiKey } = {}) {
    const catalog = entry.kind === 'custom'
      ? await customModels(entry.id)
      : await builtinModels(entry.id);
    const picked = pickProbeModel(entry, catalog);
    if (!picked) fail('E_BAD_REQUEST', 'no model', { phrase: 'src_err_no_model' });
    await registerForProbe({
      ...entry,
      enabled: entry.enabled?.length ? entry.enabled : [picked.id],
    });
    const model = models.getModel(entry.id, picked.id);
    if (!model) fail('E_BAD_REQUEST', 'no model', { phrase: 'src_err_no_model' });
    let httpStatus = 0;
    try {
      const result = await models.completeSimple(model, {
        messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
      }, {
        maxTokens: 1,
        maxRetries: 0,
        fetch: fetchImpl,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        ...(apiKey ? { apiKey } : {}),
        onResponse(res) { httpStatus = res.status; },
      });
      if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        failVerify(result.errorMessage || result.stopReason, httpStatus);
      }
      return picked;
    } catch (err) {
      if (err && (err.code === 'E_AUTH' || err.code === 'E_NETWORK' || err.code === 'E_HTTP' || err.code === 'E_BAD_REQUEST')) {
        throw err;
      }
      failVerify(err, httpStatus);
    }
    return picked;
  }

  async function writeLastTest(id, lastTest) {
    const settings = await loadSettings();
    const providers = providersOf(settings);
    const index = providers.findIndex((item) => item.id === id);
    if (index < 0) return;
    const next = providers.slice();
    next[index] = { ...next[index], lastTest };
    await saveSettings({ ...settings, providers: next });
  }

  async function upsertEntry(entry) {
    const settings = await loadSettings();
    const providers = providersOf(settings);
    const index = providers.findIndex((item) => item.id === entry.id);
    const next = providers.slice();
    if (index >= 0) next[index] = { ...next[index], ...entry, id: entry.id, kind: entry.kind };
    else next.push(entry);
    await saveSettings({ ...settings, providers: next });
  }

  function connectedIdsFrom(settings) {
    return new Set(providersOf(settings).map((item) => item.id));
  }

  async function listAvailable() {
    const settings = await loadSettings();
    const connected = connectedIdsFrom(settings);
    const popularIndex = new Map(POPULAR_PROVIDER_IDS.map((id, i) => [id, i]));
    const seen = new Set();
    const out = [];

    function pushProvider(provider) {
      const id = provider?.id;
      if (!id || seen.has(id) || EXCLUDED_PROVIDER_IDS.has(id)) return;
      seen.add(id);
      const authMethods = [];
      if (provider.auth?.apiKey || !provider.auth?.oauth) authMethods.push('api_key');
      if (provider.auth?.oauth) authMethods.push('oauth');
      const chatModels = typeof provider.getModels === 'function' ? provider.getModels() : [];
      const envVar = ENV_VAR[id];
      const item = {
        id,
        name: provider.name || id,
        authMethods,
        modelCount: Array.isArray(chatModels) ? chatModels.length : 0,
        popular: popularIndex.has(id),
        envDetected: Boolean(envVar && envValue(envVar)),
        connected: connected.has(id),
      };
      if (envVar) item.envVar = envVar;
      out.push(item);
    }

    for (const provider of extraById.values()) pushProvider(provider);
    for (const provider of builtinProviders()) pushProvider(provider);

    out.sort((a, b) => {
      const ap = popularIndex.has(a.id);
      const bp = popularIndex.has(b.id);
      if (ap !== bp) return ap ? -1 : 1;
      if (ap && bp) return popularIndex.get(a.id) - popularIndex.get(b.id);
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    return out;
  }

  function requireBuiltin(id) {
    const provider = catalogById(id);
    if (!provider) fail('E_NOT_FOUND', 'not found', { phrase: 'src_err_provider' });
    return provider;
  }

  async function connectApiKey(id, apiKey) {
    const key = String(apiKey || '').trim();
    if (!key || isMaskedOrEmptyApiKey(key)) {
      fail('E_BAD_REQUEST', 'api key required', { phrase: 'src_err_key' });
    }
    requireBuiltin(id);
    const settings = await loadSettings();
    const existing = providersOf(settings).find((item) => item.id === id);
    const modelsList = await builtinModels(id);
    const enabled = existing?.enabled || defaultEnabledIds(modelsList.map((item) => item.id));
    const entry = {
      id,
      kind: 'builtin',
      enabled,
      overrides: existing?.overrides || {},
    };
    await registerForProbe(entry);
    await probeChat(entry, { apiKey: key });
    await credentials.modify(id, async () => ({ type: 'api_key', key }));
    const lastTest = { ok: true, at: now() };
    if (existing) {
      await writeLastTest(id, lastTest);
    } else {
      await upsertEntry({ ...entry, lastTest });
    }
    return getProvider(id);
  }

  async function connectEnv(id) {
    requireBuiltin(id);
    const envVar = ENV_VAR[id];
    if (!envVar || !envValue(envVar)) {
      fail('E_BAD_REQUEST', 'env not detected', { phrase: 'src_err_env' });
    }
    const settings = await loadSettings();
    const existing = providersOf(settings).find((item) => item.id === id);
    const modelsList = await builtinModels(id);
    const enabled = existing?.enabled || defaultEnabledIds(modelsList.map((item) => item.id));
    const entry = {
      id,
      kind: 'builtin',
      enabled,
      overrides: existing?.overrides || {},
    };
    await registerForProbe(entry);
    await probeChat(entry);
    const lastTest = { ok: true, at: now() };
    if (existing) await writeLastTest(id, lastTest);
    else await upsertEntry({ ...entry, lastTest });
    return getProvider(id);
  }

  function publicSession(session) {
    const out = {
      id: session.id,
      providerId: session.providerId,
      state: session.state,
      events: session.events.slice(),
    };
    if (session.prompt) out.prompt = session.prompt;
    if (session.error) out.error = session.error;
    if (session.errorPhrase) out.errorPhrase = session.errorPhrase;
    if (session.provider) out.provider = session.provider;
    return out;
  }

  function expireSession(session, phraseKey = 'src_err_expired') {
    if (!session || session.state === 'done' || session.state === 'cancelled' || session.state === 'error') {
      return session;
    }
    try { session.controller.abort(); } catch { /* ignore */ }
    if (session.timer) clearTimeout(session.timer);
    if (session.promptWait) {
      const wait = session.promptWait;
      session.promptWait = null;
      try { wait.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* ignore */ }
    }
    session.state = 'error';
    session.errorPhrase = phraseKey;
    session.error = phraseKey;
    session.prompt = undefined;
    if (sessionByProvider.get(session.providerId) === session.id) sessionByProvider.delete(session.providerId);
    return session;
  }

  function cancelSessionRecord(session) {
    if (!session) fail('E_NOT_FOUND', 'not found', { phrase: 'src_err_session' });
    if (session.state === 'done') return session;
    try { session.controller.abort(); } catch { /* ignore */ }
    if (session.timer) clearTimeout(session.timer);
    if (session.promptWait) {
      const wait = session.promptWait;
      session.promptWait = null;
      try { wait.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* ignore */ }
    }
    session.state = 'cancelled';
    session.prompt = undefined;
    session.errorPhrase = 'src_err_cancelled';
    if (sessionByProvider.get(session.providerId) === session.id) sessionByProvider.delete(session.providerId);
    return session;
  }

  function mapNotifyEvent(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.type === 'auth_url' && typeof event.url === 'string') {
      const item = { type: 'auth_url', url: event.url };
      if (typeof event.instructions === 'string' && event.instructions) item.instructions = event.instructions;
      return item;
    }
    if (event.type === 'device_code') {
      return {
        type: 'device_code',
        userCode: String(event.userCode || ''),
        verificationUri: String(event.verificationUri || ''),
      };
    }
    if (event.type === 'info' || event.type === 'progress') {
      return { type: event.type, message: String(event.message || '') };
    }
    return null;
  }

  function mapPrompt(prompt) {
    if (!prompt || typeof prompt !== 'object') return null;
    const type = prompt.type;
    if (type !== 'text' && type !== 'secret' && type !== 'select' && type !== 'manual_code') return null;
    const out = { type, message: String(prompt.message || '') };
    if (typeof prompt.placeholder === 'string' && prompt.placeholder) out.placeholder = prompt.placeholder;
    if (type === 'select' && Array.isArray(prompt.options)) {
      out.options = prompt.options
        .filter((item) => item && typeof item === 'object' && item.id != null)
        .map((item) => {
          const option = { id: String(item.id), label: String(item.label || item.id) };
          if (typeof item.description === 'string' && item.description) option.description = item.description;
          return option;
        });
    }
    return out;
  }

  async function finishOAuthSuccess(session, credential) {
    const id = session.providerId;
    const settings = await loadSettings();
    const existing = providersOf(settings).find((item) => item.id === id);
    const modelsList = await builtinModels(id);
    const enabled = existing?.enabled || defaultEnabledIds(modelsList.map((item) => item.id));
    const entry = {
      id,
      kind: 'builtin',
      enabled,
      overrides: existing?.overrides || {},
    };
    if (existing) await upsertEntry({ ...existing, ...entry });
    else await upsertEntry(entry);
    session.provider = await getProvider(id);
    session.state = 'done';
    session.prompt = undefined;
    if (session.timer) clearTimeout(session.timer);
    if (sessionByProvider.get(id) === session.id) sessionByProvider.delete(id);
    void credential;
  }

  async function startOAuth(id) {
    const catalog = requireBuiltin(id);
    if (!catalog.auth?.oauth?.login) {
      fail('E_BAD_REQUEST', 'oauth not supported', { phrase: 'src_err_method' });
    }
    const previousId = sessionByProvider.get(id);
    if (previousId) {
      const previous = sessions.get(previousId);
      if (previous) cancelSessionRecord(previous);
    }
    const sid = sessionId();
    const controller = new AbortController();
    const session = {
      id: sid,
      providerId: id,
      state: 'pending',
      events: [],
      controller,
      promptWait: null,
      expiresAt: now() + loginTtlMs,
      timer: null,
    };
    session.timer = setTimeout(() => {
      expireSession(session);
    }, loginTtlMs);
    if (typeof session.timer.unref === 'function') session.timer.unref();
    sessions.set(sid, session);
    sessionByProvider.set(id, sid);
    models.setProvider(catalog);

    const interaction = {
      signal: controller.signal,
      notify(event) {
        const mapped = mapNotifyEvent(event);
        if (mapped) session.events.push(mapped);
      },
      async prompt(prompt) {
        const mapped = mapPrompt(prompt);
        if (!mapped) return '';
        session.prompt = mapped;
        session.state = 'prompt';
        try {
          const value = await new Promise((resolve, reject) => {
            session.promptWait = { resolve, reject };
          });
          return value;
        } finally {
          session.promptWait = null;
          session.prompt = undefined;
          if (session.state === 'prompt') session.state = 'pending';
        }
      },
    };

    session.loginPromise = models.login(id, 'oauth', interaction).then(async (credential) => {
      if (session.state === 'cancelled' || session.state === 'error') return;
      await finishOAuthSuccess(session, credential);
    }).catch((err) => {
      if (session.state === 'cancelled') return;
      if (controller.signal.aborted && session.state !== 'done') {
        if (session.state !== 'error') expireSession(session);
        return;
      }
      session.state = 'error';
      session.error = redactAuthText(err instanceof Error ? err.message : String(err || 'login failed'));
      session.prompt = undefined;
      if (session.timer) clearTimeout(session.timer);
      if (sessionByProvider.get(id) === sid) sessionByProvider.delete(id);
    });

    return publicSession(session);
  }

  function liveSession(sid) {
    const session = sessions.get(sid);
    if (!session) fail('E_NOT_FOUND', 'not found', { phrase: 'src_err_session' });
    if (session.state !== 'done' && session.state !== 'cancelled' && session.state !== 'error') {
      if (now() >= session.expiresAt) expireSession(session);
    }
    return session;
  }

  function getSession(sid) {
    return publicSession(liveSession(sid));
  }

  async function answerSession(sid, value) {
    const session = liveSession(sid);
    if (session.state !== 'prompt' || !session.promptWait) {
      fail('E_BAD_REQUEST', 'not waiting', { phrase: 'src_err_session_state' });
    }
    const text = value == null ? '' : String(value);
    const wait = session.promptWait;
    session.promptWait = null;
    wait.resolve(text);
    await Promise.resolve();
    return publicSession(session);
  }

  function cancelSession(sid) {
    const session = sessions.get(sid);
    if (!session) fail('E_NOT_FOUND', 'not found', { phrase: 'src_err_session' });
    cancelSessionRecord(session);
    return publicSession(session);
  }

  async function addCustom({ name, baseUrl, api, apiKey } = {}) {
    const display = String(name || '').trim().slice(0, 80);
    if (!display) fail('E_BAD_REQUEST', 'name required', { phrase: 'src_err_name' });
    const url = normalizeHttpUrl(baseUrl);
    if (!url) fail('E_BAD_REQUEST', 'base url required', { phrase: 'src_err_url' });
    const apiId = String(api || '').trim();
    if (!CUSTOM_API.has(apiId)) fail('E_BAD_REQUEST', 'invalid api', { phrase: 'src_err_api' });
    const key = isMaskedOrEmptyApiKey(apiKey) ? '' : String(apiKey || '').trim();
    const id = createCustomProviderId();
    let fetched;
    try {
      fetched = await fetchCustomProviderModels({
        credential: key ? { type: 'api_key', key } : undefined,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        baseUrl: url,
      }, { id, api: apiId, baseUrl: url, fetchImpl });
    } catch (err) {
      failVerify(err, err?.status);
    }
    if (!Array.isArray(fetched) || !fetched.length) {
      fail('E_HTTP', 'no models', { phrase: 'src_err_models' });
    }
    const enabled = defaultEnabledIds(fetched.map((item) => item.id));
    const entry = {
      id,
      kind: 'custom',
      name: display,
      baseUrl: url,
      api: apiId,
      enabled,
      overrides: {},
      lastTest: { ok: true, at: now() },
    };
    if (key) await credentials.modify(id, async () => ({ type: 'api_key', key }));
    await modelsStore.write(id, { models: fetched });
    await upsertEntry(entry);
    return getProvider(id);
  }

  async function testProvider(id) {
    const settings = await loadSettings();
    const existing = providersOf(settings).find((item) => item.id === id);
    if (!existing) fail('E_NOT_FOUND', 'not found', { phrase: 'src_err_missing' });
    const at = now();
    try {
      if (existing.kind === 'custom') {
        const cred = asRecord(await credentials.read(id));
        const key = cred?.type === 'api_key' && typeof cred.key === 'string' ? cred.key : '';
        let fetched;
        try {
          fetched = await fetchCustomProviderModels({
            credential: key ? { type: 'api_key', key } : undefined,
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            baseUrl: existing.baseUrl,
          }, { id, api: existing.api, baseUrl: existing.baseUrl, fetchImpl });
        } catch (err) {
          failVerify(err, err?.status);
        }
        const ids = new Set((fetched || []).map((item) => item.id));
        const enabled = (existing.enabled || []).filter((modelId) => ids.has(modelId));
        const overrides = {};
        for (const [modelId, over] of Object.entries(existing.overrides || {})) {
          if (ids.has(modelId)) overrides[modelId] = over;
        }
        await modelsStore.write(id, { models: fetched || [] });
        await upsertEntry({
          ...existing,
          enabled,
          overrides,
          lastTest: { ok: true, at },
        });
      } else {
        await probeChat(existing);
        await writeLastTest(id, { ok: true, at });
      }
    } catch (err) {
      const code = err?.code === 'E_AUTH' || err?.code === 'E_NETWORK' || err?.code === 'E_HTTP'
        ? err.code
        : classifyVerify(err?.message, err?.status);
      await writeLastTest(id, {
        ok: false,
        at,
        code,
        error: redactAuthText(err instanceof Error ? err.message : String(err || '')),
        status: err?.status,
      });
      throw err;
    }
    return getProvider(id);
  }

  return {
    listProviders,
    listAvailable,
    getProvider,
    getDefaultModel,
    setDefaultModel,
    patchProvider,
    removeProvider,
    connectApiKey,
    connectEnv,
    startOAuth,
    getSession,
    answerSession,
    cancelSession,
    addCustom,
    testProvider,
    resolveTarget,
    contextWindowFor,
    hasAvailableModel,
    resolveConversationModelPatch,
    seedFromEnv,
  };
}
