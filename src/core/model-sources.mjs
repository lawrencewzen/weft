import { randomBytes } from 'node:crypto';

/** OpenAI-compatible vendors. Ollama is the only preset that does not need a key. */
export const VENDOR_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', needsKey: true },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', needsKey: true },
  { id: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true },
  { id: 'moonshot', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', needsKey: true },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', needsKey: true },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false },
  { id: 'custom', name: '自定义 API', baseUrl: '', needsKey: true },
];

/** Legacy subscription source id; leftover rows with this id or kind are dropped. */
const DROPPED_SOURCE_ID = 'grok';
export const SETTINGS_VERSION = 2;

const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
export const CONTEXT_WINDOW_MIN = 1000;
export const CONTEXT_WINDOW_MAX = 10_000_000;

export function createSourceId() {
  return randomBytes(4).toString('hex');
}

export function vendorPreset(id) {
  const key = String(id || '').trim().toLowerCase();
  return VENDOR_PRESETS.find((item) => item.id === key) || null;
}

export function normalizeHttpUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { return ''; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function vendorForBaseUrl(baseUrl) {
  const url = normalizeHttpUrl(baseUrl);
  if (!url) return null;
  return VENDOR_PRESETS.find((item) => item.baseUrl && normalizeHttpUrl(item.baseUrl) === url) || null;
}

export function isValidContextWindow(value) {
  return Number.isInteger(value) && value >= CONTEXT_WINDOW_MIN && value <= CONTEXT_WINDOW_MAX;
}

function legacyDefaultModel(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return '';
  if (typeof models.default !== 'string') return '';
  return models.default.trim().slice(0, 200);
}

/**
 * A leftover provider row becomes an API source only when it was actually configured:
 * a key, an Ollama base URL, or a base URL that is not that vendor's preset.
 */
function wantsLegacyApiSource(provider, baseUrl, apiKey) {
  if (String(apiKey || '').trim()) return true;
  const url = normalizeHttpUrl(baseUrl);
  if (String(provider || '').trim().toLowerCase() === 'ollama' && url) return true;
  if (!url) return false;
  const presetUrl = normalizeHttpUrl(vendorPreset(provider)?.baseUrl);
  return url !== presetUrl;
}

/**
 * One-shot upgrade from the single provider/baseUrl/apiKey record.
 * Already-versioned settings are returned unchanged.
 * Pass `createId` to keep the function deterministic.
 */
export function migrateLegacySettings(raw, { createId = createSourceId } = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  if (input.version === SETTINGS_VERSION || input.version === 3) return input;
  delete input.grok;

  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey : '';
  const sources = [];
  let apiSource = null;
  if (wantsLegacyApiSource(provider, baseUrl, apiKey)) {
    const preset = vendorPreset(provider);
    const vendor = preset?.id || (provider ? provider.toLowerCase().slice(0, 32) : 'custom');
    let id = createId();
    if (!SOURCE_ID.test(id) || id === DROPPED_SOURCE_ID) id = createSourceId();
    const storedUrl = normalizeHttpUrl(baseUrl) || (preset && preset.id !== 'custom' ? preset.baseUrl : '');
    apiSource = {
      id,
      kind: 'api',
      vendor,
      name: preset?.name || provider || '自定义 API',
      baseUrl: storedUrl,
      apiKey,
      models: [],
    };
    sources.push(apiSource);
  }
  const models = {};
  if (apiSource) {
    const model = legacyDefaultModel(input.models);
    if (model) {
      if (!apiSource.models.includes(model)) apiSource.models.push(model);
      models.default = { sourceId: apiSource.id, model };
    }
  }
  return {
    ...input,
    version: SETTINGS_VERSION,
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    sources,
    models,
  };
}
