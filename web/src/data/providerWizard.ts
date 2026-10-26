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

export type WayOption = { id: ConnectWay; enabled: boolean };

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

export function waysForVendor(vendor: Vendor): WayOption[] {
  if (vendor.id === GROK_VENDOR_ID || vendor.access === 'account') {
    return [
      { id: 'account', enabled: true },
      { id: 'agent', enabled: false },
    ];
  }
  if (vendor.access === 'custom_endpoint') {
    return [
      { id: 'custom_endpoint', enabled: true },
      { id: 'api_key', enabled: true },
      { id: 'agent', enabled: false },
    ];
  }
  return [
    { id: 'api_key', enabled: true },
    { id: 'custom_endpoint', enabled: true },
    { id: 'agent', enabled: false },
  ];
}

export function defaultWay(vendor: Vendor): ConnectWay {
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
  if (state.step === 1) return Boolean(state.vendorId);
  if (state.step !== 2) return false;
  if (!vendor || !state.way || state.way === 'agent') return false;
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
    const hay = `${item.id} ${item.name} ${item.brand || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

export type BrandFilter = { id: string; name: string; count: number };

export function brandFilters(models: readonly ProviderModel[]): BrandFilter[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const model of models) {
    const id = model.brand;
    if (!id) continue;
    const prev = counts.get(id);
    if (prev) prev.count += 1;
    else counts.set(id, { name: id, count: 1 });
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
