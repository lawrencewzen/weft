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

export const CONTEXT_WINDOW_MIN = 1000;
export const CONTEXT_WINDOW_MAX = 10_000_000;

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
