import type { components } from '../../../src/v2/contract.gen';

export type Vendor = components['schemas']['Vendor'];
export type Provider = components['schemas']['Provider'];
export type ProviderModel = components['schemas']['ProviderModel'];
export type CreateProviderRequest = components['schemas']['CreateProviderRequest'];
export type PatchProviderRequest = components['schemas']['PatchProviderRequest'];
export type TestProviderRequest = components['schemas']['TestProviderRequest'];
export type ProviderAccess = components['schemas']['ProviderAccess'];
export type ProviderStatus = components['schemas']['ProviderStatus'];

export const GROK_VENDOR_ID = 'grok';

export const GROK_VENDOR: Vendor = {
  id: GROK_VENDOR_ID,
  name: 'Grok Build',
  access: 'account',
  needsKey: false,
  baseUrl: '',
  brand: 'Grok',
};

export const SETTINGS_PAGES = ['general', 'providers', 'git', 'plugins', 'skills', 'about'] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

export type ConnectWay = 'api_key' | 'account' | 'custom_endpoint' | 'agent';

export type WayOption = { id: ConnectWay; enabled: boolean; product?: string | null };

/** Design Provider-1 order. Grok Build is extra so ②B device-code login stays reachable. */
export const VENDOR_CARD_ORDER = [
  'anthropic',
  'openai',
  'gemini',
  'xai',
  'qwen',
  'github-copilot',
  'kiro',
  'deepseek',
  'moonshot',
  'zhipu',
  'openrouter',
  'ollama',
  'lmstudio',
  'custom',
] as const;

export const COMING_SOON_VENDOR_IDS = new Set(['github-copilot', 'kiro', 'lmstudio']);

type VendorCatalogEntry = {
  id: string;
  name: { zh: string; en: string };
  access: Vendor['access'];
  needsKey: boolean;
  baseUrl: string;
  brand: string | null;
  accountProduct?: { zh: string; en: string };
  agentProduct?: { zh: string; en: string };
  proto?: { zh: string; en: string };
  docsName?: { zh: string; en: string };
};

const FALLBACK_VENDORS: Vendor[] = [
  { id: 'deepseek', name: 'DeepSeek', access: 'api_key', needsKey: true, baseUrl: 'https://api.deepseek.com/v1', brand: 'DeepSeek' },
  { id: 'xai', name: 'xAI', access: 'api_key', needsKey: true, baseUrl: 'https://api.x.ai/v1', brand: 'XAI' },
  { id: 'openai', name: 'OpenAI', access: 'api_key', needsKey: true, baseUrl: 'https://api.openai.com/v1', brand: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic', access: 'api_key', needsKey: true, baseUrl: 'https://api.anthropic.com/v1', brand: 'Anthropic' },
  { id: 'gemini', name: 'Gemini', access: 'api_key', needsKey: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', brand: 'Gemini' },
  { id: 'qwen', name: '通义千问', access: 'api_key', needsKey: true, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', brand: 'Qwen' },
  { id: 'moonshot', name: 'Kimi', access: 'api_key', needsKey: true, baseUrl: 'https://api.moonshot.cn/v1', brand: 'Moonshot' },
  { id: 'zhipu', name: '智谱', access: 'api_key', needsKey: true, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', brand: 'Zhipu' },
  { id: 'openrouter', name: 'OpenRouter', access: 'api_key', needsKey: true, baseUrl: 'https://openrouter.ai/api/v1', brand: 'OpenRouter' },
  { id: 'ollama', name: 'Ollama', access: 'local', needsKey: false, baseUrl: 'http://127.0.0.1:11434/v1', brand: 'Ollama' },
  { id: 'custom', name: '自定义地址', access: 'custom_endpoint', needsKey: true, baseUrl: '', brand: null },
];

const EXTRA_VENDORS: VendorCatalogEntry[] = [
  {
    id: 'github-copilot',
    name: { zh: 'GitHub Copilot', en: 'GitHub Copilot' },
    access: 'api_key',
    needsKey: true,
    baseUrl: '',
    brand: 'GithubCopilot',
    accountProduct: { zh: 'Copilot', en: 'Copilot' },
  },
  {
    id: 'kiro',
    name: { zh: 'Kiro', en: 'Kiro' },
    access: 'api_key',
    needsKey: true,
    baseUrl: '',
    brand: 'Kiro',
  },
  {
    id: 'lmstudio',
    name: { zh: 'LM Studio', en: 'LM Studio' },
    access: 'local',
    needsKey: false,
    baseUrl: 'http://127.0.0.1:1234/v1',
    brand: 'LmStudio',
  },
];

const VENDOR_DISPLAY: Record<string, { zh: string; en: string }> = {
  grok: { zh: 'Grok Build', en: 'Grok Build' },
  gemini: { zh: 'Google', en: 'Google' },
  qwen: { zh: '阿里云 · 通义', en: 'Alibaba Tongyi' },
  ollama: { zh: 'Ollama', en: 'Ollama' },
  custom: { zh: '自定义地址', en: 'Custom endpoint' },
};

const ACCOUNT_PRODUCT: Record<string, { zh: string; en: string }> = {
  grok: { zh: 'Grok Build', en: 'Grok Build' },
  anthropic: { zh: 'Claude Code', en: 'Claude Code' },
  openai: { zh: 'Codex', en: 'Codex' },
  xai: { zh: 'Grok Build', en: 'Grok Build' },
};

const AGENT_PRODUCT: Record<string, { zh: string; en: string }> = {
  anthropic: { zh: 'Claude Code', en: 'Claude Code' },
  openai: { zh: 'Codex', en: 'Codex' },
  grok: { zh: 'Grok', en: 'Grok' },
};

const VENDOR_PROTO: Record<string, { zh: string; en: string }> = {
  anthropic: { zh: 'Anthropic 协议', en: 'Anthropic protocol' },
};

const VENDOR_DOCS_NAME: Record<string, { zh: string; en: string }> = {
  anthropic: { zh: 'Anthropic Console', en: 'Anthropic Console' },
  deepseek: { zh: 'DeepSeek 开放平台', en: 'DeepSeek platform' },
  openai: { zh: 'OpenAI Platform', en: 'OpenAI Platform' },
  gemini: { zh: 'Google AI Studio', en: 'Google AI Studio' },
  xai: { zh: 'xAI Console', en: 'xAI Console' },
  qwen: { zh: '阿里云百炼', en: 'Alibaba Model Studio' },
  moonshot: { zh: 'Kimi 开放平台', en: 'Kimi platform' },
  zhipu: { zh: '智谱开放平台', en: 'Zhipu platform' },
  openrouter: { zh: 'OpenRouter', en: 'OpenRouter' },
};

const BRAND_CHIP_LABEL: Record<string, string> = {
  OpenAI: 'GPT',
  openai: 'GPT',
  Qwen: '通义千问',
  qwen: '通义千问',
  Meta: 'Llama',
  meta: 'Llama',
};

function pickLang(value: { zh: string; en: string } | undefined, lang: 'zh' | 'en' | undefined): string | undefined {
  if (!value) return undefined;
  return lang === 'en' ? value.en : value.zh;
}

function extraAsVendor(entry: VendorCatalogEntry, lang: 'zh' | 'en' = 'zh'): Vendor {
  return {
    id: entry.id,
    name: pickLang(entry.name, lang) || entry.name.zh,
    access: entry.access,
    needsKey: entry.needsKey,
    baseUrl: entry.baseUrl,
    brand: entry.brand,
  };
}

export type WizardStep = 1 | 2 | 3;

export type WizardMode = 'add' | 'edit';

export type WizardState = {
  mode: WizardMode;
  step: WizardStep;
  vendorId: string | null;
  way: ConnectWay | null;
  name: string;
  nameTouched: boolean;
  apiKey: string;
  apiKeyEdited: boolean;
  baseUrl: string;
  baseUrlTouched: boolean;
  advancedOpen: boolean;
  probeOk: boolean;
  probedModelIds: string[];
  selectedModelIds: string[];
  showSelectedOnly: boolean;
  modelQuery: string;
  brandFilter: string | null;
  vendorQuery: string;
  createdId: string | null;
  originalKeyMasked: string | null;
  originalBaseUrl: string;
  originalName: string;
};

export function withGrokVendor(vendors: readonly Vendor[]): Vendor[] {
  if (vendors.some((item) => item.id === GROK_VENDOR_ID)) return [...vendors];
  return [GROK_VENDOR, ...vendors];
}

export function isComingSoonVendor(vendor: Pick<Vendor, 'id'> | string | null | undefined): boolean {
  const id = typeof vendor === 'string' ? vendor : vendor?.id;
  return Boolean(id && COMING_SOON_VENDOR_IDS.has(id));
}

export function isGrokAccountVendor(vendor: Pick<Vendor, 'id'> | null | undefined): boolean {
  return vendor?.id === GROK_VENDOR_ID;
}

/** 14 design cards plus Grok Build, overlaying server presets when present. */
export function presentVendors(vendors: readonly Vendor[], lang: 'zh' | 'en' = 'zh'): Vendor[] {
  const byId = new Map<string, Vendor>();
  for (const item of FALLBACK_VENDORS) byId.set(item.id, item);
  for (const item of withGrokVendor(vendors)) byId.set(item.id, item);
  for (const extra of EXTRA_VENDORS) {
    if (!byId.has(extra.id)) byId.set(extra.id, extraAsVendor(extra, lang));
  }
  const rank = (id: string) => {
    if (id === GROK_VENDOR_ID) return VENDOR_CARD_ORDER.indexOf('xai') + 0.5;
    const index = VENDOR_CARD_ORDER.indexOf(id as (typeof VENDOR_CARD_ORDER)[number]);
    return index < 0 ? 1000 : index;
  };
  return [...byId.values()]
    .map((item) => {
      const extra = EXTRA_VENDORS.find((row) => row.id === item.id);
      const name = pickLang(VENDOR_DISPLAY[item.id], lang)
        || pickLang(extra?.name, lang)
        || item.name;
      return {
        ...item,
        name,
        brand: item.brand || extra?.brand || item.brand,
      };
    })
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name, lang === 'en' ? 'en' : 'zh'));
}

export function accountProductName(vendor: Vendor, lang: 'zh' | 'en' = 'zh'): string | null {
  return pickLang(ACCOUNT_PRODUCT[vendor.id], lang) || null;
}

export function agentProductName(vendor: Vendor, lang: 'zh' | 'en' = 'zh'): string | null {
  return pickLang(AGENT_PRODUCT[vendor.id], lang)
    || pickLang(ACCOUNT_PRODUCT[vendor.id], lang)
    || null;
}

export function vendorProtocolName(vendor: Vendor, lang: 'zh' | 'en' = 'zh'): string {
  return pickLang(VENDOR_PROTO[vendor.id], lang)
    || (lang === 'en' ? 'OpenAI protocol' : 'OpenAI 协议');
}

export function vendorDocsName(vendor: Vendor, lang: 'zh' | 'en' = 'zh'): string {
  return pickLang(VENDOR_DOCS_NAME[vendor.id], lang) || vendor.name;
}

export function waysForVendor(vendor: Vendor, lang: 'zh' | 'en' = 'zh'): WayOption[] {
  const coming = isComingSoonVendor(vendor);
  const accountProduct = accountProductName(vendor, lang);
  const agentProduct = agentProductName(vendor, lang);
  if (isGrokAccountVendor(vendor) || vendor.access === 'account') {
    return [
      { id: 'account', enabled: !coming, product: accountProduct },
      { id: 'agent', enabled: false, product: agentProduct },
    ];
  }
  return [
    { id: 'account', enabled: false, product: accountProduct },
    { id: 'api_key', enabled: !coming },
    { id: 'agent', enabled: false, product: agentProduct },
    { id: 'custom_endpoint', enabled: !coming },
  ];
}

export function defaultWay(vendor: Vendor): ConnectWay {
  if (vendor.access === 'custom_endpoint' || vendor.id === 'custom') return 'custom_endpoint';
  if (isGrokAccountVendor(vendor) || vendor.access === 'account') return 'account';
  return waysForVendor(vendor).find((item) => item.enabled)?.id ?? 'api_key';
}

export function isMaskedApiKey(value: string, currentMasked?: string | null): boolean {
  const s = String(value ?? '').trim();
  if (!s) return true;
  if (currentMasked && s === currentMasked) return true;
  return /^[•*]+\w{0,4}$/.test(s);
}

export function blankWizard(mode: WizardMode = 'add'): WizardState {
  return {
    mode,
    step: mode === 'edit' ? 2 : 1,
    vendorId: null,
    way: null,
    name: '',
    nameTouched: false,
    apiKey: '',
    apiKeyEdited: false,
    baseUrl: '',
    baseUrlTouched: false,
    advancedOpen: false,
    probeOk: false,
    probedModelIds: [],
    selectedModelIds: [],
    showSelectedOnly: false,
    modelQuery: '',
    brandFilter: null,
    vendorQuery: '',
    createdId: null,
    originalKeyMasked: null,
    originalBaseUrl: '',
    originalName: '',
  };
}

export function wizardFromProvider(provider: Provider): WizardState {
  const way: ConnectWay = provider.access === 'account'
    ? 'account'
    : provider.access === 'custom_endpoint'
      ? 'custom_endpoint'
      : 'api_key';
  return {
    ...blankWizard('edit'),
    step: 2,
    vendorId: provider.id === GROK_VENDOR_ID ? GROK_VENDOR_ID : (provider.vendor || 'custom'),
    way,
    name: provider.name,
    nameTouched: true,
    apiKey: provider.keyMasked || '',
    apiKeyEdited: false,
    baseUrl: provider.baseUrl || '',
    baseUrlTouched: false,
    advancedOpen: false,
    probeOk: provider.status === 'ok',
    probedModelIds: provider.models.map((item) => item.id),
    selectedModelIds: provider.models.map((item) => item.id),
    createdId: provider.id,
    originalKeyMasked: provider.keyMasked,
    originalBaseUrl: provider.baseUrl || '',
    originalName: provider.name,
  };
}

export function canAdvance(
  state: WizardState,
  vendor: Vendor | null,
  grokSignedIn = false,
): boolean {
  if (state.step === 1) return Boolean(state.vendorId) && !isComingSoonVendor(state.vendorId);
  if (state.step !== 2) return false;
  if (!vendor || !state.way || state.way === 'agent' || isComingSoonVendor(vendor)) return false;
  if (state.way === 'account') return grokSignedIn;
  if (state.mode === 'edit' && !state.apiKeyEdited && !state.baseUrlTouched) return true;
  return state.probeOk;
}

export function canFinish(state: WizardState): boolean {
  return state.step === 3 && state.selectedModelIds.length > 0;
}

/** Add-mode drafts created on step 2 (tested save) are deleted on cancel. Grok account login is kept. */
export function shouldDiscardDraftOnCancel(state: Pick<WizardState, 'mode' | 'createdId'>): boolean {
  return state.mode === 'add' && Boolean(state.createdId) && state.createdId !== GROK_VENDOR_ID;
}

export function effectiveBaseUrl(state: WizardState, vendor: Vendor | null): string {
  const typed = state.baseUrl.trim();
  if (typed) return typed;
  return vendor?.baseUrl || '';
}

export function buildTestDraftBody(state: WizardState, vendor: Vendor): TestProviderRequest {
  const body: TestProviderRequest = { vendor: vendor.id };
  const url = effectiveBaseUrl(state, vendor);
  if (url) body.baseUrl = url;
  if (state.apiKey && !isMaskedApiKey(state.apiKey, state.originalKeyMasked)) {
    body.apiKey = state.apiKey;
  }
  return body;
}

export function buildCreateBody(state: WizardState, vendor: Vendor): CreateProviderRequest {
  const body: CreateProviderRequest = {
    vendor: vendor.id === GROK_VENDOR_ID ? 'custom' : vendor.id,
  };
  const name = state.name.trim() || vendor.name;
  if (name) body.name = name;
  const url = effectiveBaseUrl(state, vendor);
  if (url) body.baseUrl = url;
  if (state.apiKey && !isMaskedApiKey(state.apiKey, state.originalKeyMasked)) {
    body.apiKey = state.apiKey;
  }
  if (state.selectedModelIds.length) body.models = state.selectedModelIds;
  else if (state.probedModelIds.length) body.models = state.probedModelIds;
  return body;
}

export function buildPatchBody(state: WizardState): PatchProviderRequest {
  const body: PatchProviderRequest = {};
  const name = state.name.trim();
  if (name && name !== state.originalName) body.name = name;
  if (state.baseUrlTouched) {
    const url = state.baseUrl.trim();
    if (url !== state.originalBaseUrl) body.baseUrl = url;
  }
  if (
    state.apiKeyEdited
    && state.apiKey.trim()
    && !isMaskedApiKey(state.apiKey, state.originalKeyMasked)
  ) {
    body.apiKey = state.apiKey.trim();
  }
  body.models = state.selectedModelIds;
  return body;
}

export function hostOf(url: string): string {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    return new URL(text).host;
  } catch {
    return text.replace(/^https?:\/\//i, '').split('/')[0] || text;
  }
}

export function formatContextWindow(n: number): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1_000_000 && v % 1_000_000 === 0) return `${v / 1_000_000}M`;
  if (v >= 1000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(Math.round(v));
}

export function keyTail(masked: string | null | undefined): string {
  const text = String(masked || '');
  if (!text) return '';
  return text.slice(-4);
}

export function statusKind(status: ProviderStatus): 'ok' | 'warn' | 'bad' | 'off' {
  if (status === 'ok') return 'ok';
  if (status === 'needs_auth') return 'warn';
  if (status === 'unreachable' || status === 'error') return 'bad';
  return 'off';
}

export function vendorDocsUrl(vendor: Vendor): string | null {
  const host = hostOf(vendor.baseUrl);
  if (!host) return null;
  try {
    const url = new URL(vendor.baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return `https://${host}`;
  }
}

export function filterVendors(vendors: readonly Vendor[], query: string): Vendor[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...vendors];
  return vendors.filter((item) => {
    const hay = `${item.id} ${item.name} ${item.brand || ''} ${accountProductName(item) || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

export type BrandFilter = { id: string; name: string; count: number };

export function brandChipLabel(brand: string | null | undefined): string {
  const id = String(brand || '');
  if (!id) return '';
  return BRAND_CHIP_LABEL[id] || id;
}

export function brandFilters(models: readonly ProviderModel[]): BrandFilter[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const model of models) {
    const id = model.brand;
    if (!id) continue;
    const prev = counts.get(id);
    if (prev) prev.count += 1;
    else counts.set(id, { name: brandChipLabel(id), count: 1 });
  }
  return [...counts.entries()]
    .map(([id, value]) => ({ id, name: value.name, count: value.count }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function filterModels(
  models: readonly ProviderModel[],
  opts: { query: string; brand: string | null; selectedOnly: boolean; selectedIds: readonly string[] },
): ProviderModel[] {
  const q = opts.query.trim().toLowerCase();
  const selected = new Set(opts.selectedIds);
  return models.filter((model) => {
    if (opts.selectedOnly && !selected.has(model.id)) return false;
    if (opts.brand && model.brand !== opts.brand) return false;
    if (!q) return true;
    const hay = `${model.displayName} ${model.id}`.toLowerCase();
    return hay.includes(q);
  });
}

export function modelsFromIds(ids: readonly string[]): ProviderModel[] {
  return ids.map((id) => ({
    id,
    displayName: id,
    brand: null,
    contextWindow: 0,
    contextWindowCustom: false,
  }));
}

export function isGrokProvider(provider: Provider): boolean {
  return provider.id === GROK_VENDOR_ID || provider.access === 'account';
}

export function vendorForProvider(provider: Provider, vendors: readonly Vendor[]): Vendor | null {
  if (isGrokProvider(provider)) {
    return vendors.find((item) => item.id === GROK_VENDOR_ID) || GROK_VENDOR;
  }
  if (provider.access === 'local') {
    return vendors.find((item) => item.id === 'ollama') || null;
  }
  if (provider.access === 'custom_endpoint') {
    return vendors.find((item) => item.id === 'custom') || null;
  }
  return vendors.find((item) => item.brand && item.brand === provider.vendor)
    || vendors.find((item) => item.id === 'custom')
    || null;
}
