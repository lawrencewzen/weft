/** Provider / vendor views. Secrets never appear; only keyMasked. */

import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  GROK_SOURCE_ID,
  VENDOR_PRESETS,
  contextWindowForModel,
  effectiveBaseUrl,
  effectiveModelFor,
  normalizeSources,
  probeFailurePayload,
  sourceNeedsKey,
} from '../../core/model-sources.mjs';
import { redactAuthText } from '../../core/grok-auth.mjs';
import { maskApiKey } from '../../core/settings.mjs';
import type { components } from '../contract.gen.ts';
import type { Lang } from '../phrases/index.ts';
import { brandIcons, brandIdOf } from './brand.ts';
import {
  classifyProbeFailure,
  formatProbeFailureForLang,
  sourceProbeStatusForLang,
  type ProbeFailureInput,
} from './probe-error.ts';

export type Provider = components['schemas']['Provider'];
export type ProviderModel = components['schemas']['ProviderModel'];
export type Vendor = components['schemas']['Vendor'];
export type ProvidersSnapshot = components['schemas']['ProvidersSnapshot'];
export type ResolvedModel = components['schemas']['ResolvedModel'];
export type ProviderDefaults = components['schemas']['ProviderDefaults'];
export type ProviderProbeResult = components['schemas']['ProviderProbeResult'];
export type GrokSession = components['schemas']['GrokSession'];
export type GrokPending = components['schemas']['GrokPending'];
export type GrokLoginStart = components['schemas']['GrokLoginStart'];
export type GrokLoginPollResult = components['schemas']['GrokLoginPollResult'];
export type ProviderAccess = components['schemas']['ProviderAccess'];
export type ProviderStatus = components['schemas']['ProviderStatus'];

export type SourceLike = {
  id?: unknown;
  kind?: unknown;
  vendor?: unknown;
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  models?: unknown;
  catalog?: unknown;
  lastTest?: ProbeFailureInput & { ok?: unknown; at?: unknown };
  contextWindows?: unknown;
  [key: string]: unknown;
};

export type SettingsLike = {
  sources?: unknown;
  models?: unknown;
  [key: string]: unknown;
};

export type GrokStatusLike = {
  signedIn?: unknown;
  account?: unknown;
  email?: unknown;
  expiresAt?: unknown;
  authMode?: unknown;
  source?: unknown;
  pending?: {
    loginId?: unknown;
    verificationUri?: unknown;
    userCode?: unknown;
    interval?: unknown;
    expiresAt?: unknown;
  } | null;
  [key: string]: unknown;
};

export { CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX };

export function accessForVendor(vendorId: unknown): ProviderAccess {
  const id = String(vendorId || '').trim().toLowerCase();
  if (id === 'ollama') return 'local';
  if (id === 'custom') return 'custom_endpoint';
  return 'api_key';
}

export function providerAccess(source: SourceLike | null | undefined): ProviderAccess {
  if (!source) return 'api_key';
  if (source.kind === 'grok' || source.id === GROK_SOURCE_ID) return 'account';
  return accessForVendor(source.vendor);
}

export function sourceBlockReason(
  source: SourceLike | null | undefined,
  { grokSignedIn = false }: { grokSignedIn?: boolean } = {},
): string {
  if (!source) return 'missing';
  if (source.kind === 'grok' || source.id === GROK_SOURCE_ID) {
    if (!grokSignedIn) return 'unsigned';
  } else if (sourceNeedsKey(source) && !String(source.apiKey || '').trim()) {
    return 'no_key';
  } else if (!effectiveBaseUrl(source) && !String(source.baseUrl || '').trim()) {
    return 'no_url';
  }
  if (source.lastTest && source.lastTest.ok === false) return 'offline';
  return '';
}

export function providerStatusFromReason(
  source: SourceLike | null | undefined,
  reason: string,
): ProviderStatus {
  if (reason === 'unsigned' || reason === 'no_key') return 'needs_auth';
  if (reason === 'no_url' || reason === 'missing') return 'error';
  if (reason === 'offline') {
    const kind = classifyProbeFailure(source?.lastTest || {}).kind;
    if (kind === 'network' || kind === 'timeout') return 'unreachable';
    if (kind === 'auth') return 'needs_auth';
    return 'error';
  }
  if (source?.lastTest && source.lastTest.ok === true) return 'ok';
  return 'untested';
}

function lastTestedAtMs(lastTest: SourceLike['lastTest']): number | null {
  const at = lastTest?.at;
  if (typeof at === 'number' && Number.isFinite(at)) return Math.trunc(at);
  if (typeof at !== 'string' || !at) return null;
  const n = Date.parse(at);
  return Number.isFinite(n) ? n : null;
}

function keyMaskedOf(apiKey: unknown): string | null {
  const masked = maskApiKey(typeof apiKey === 'string' ? apiKey : '');
  return masked || null;
}

function contextWindowsMap(source: SourceLike | null | undefined): Record<string, number> {
  const raw = source?.contextWindows;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, number>;
}

export function providerModelsView(source: SourceLike): ProviderModel[] {
  const icons = brandIcons();
  const names = Array.isArray(source.models) ? source.models : [];
  const windows = contextWindowsMap(source);
  const out: ProviderModel[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id) continue;
    out.push({
      id,
      displayName: icons.displayName(id),
      brand: brandIdOf(icons.brandForModel(id)),
      contextWindow: contextWindowForModel(source, id),
      contextWindowCustom: Object.prototype.hasOwnProperty.call(windows, id),
    });
  }
  return out;
}

export function providerView(
  source: SourceLike,
  opts: {
    lang?: Lang;
    grokSignedIn?: boolean;
    defaultProviderId?: string | null;
  } = {},
): Provider {
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  const grokSignedIn = Boolean(opts.grokSignedIn);
  const reason = sourceBlockReason(source, { grokSignedIn });
  const status = providerStatusFromReason(source, reason);
  const statusText = status === 'ok' || status === 'untested'
    ? ''
    : sourceProbeStatusForLang(source, reason, lang);
  const icons = brandIcons();
  const vendorKey = source.kind === 'grok' ? 'grok' : source.vendor;
  return {
    id: String(source.id || ''),
    vendor: brandIdOf(icons.brandForProvider(vendorKey)),
    name: String(source.name || ''),
    access: providerAccess(source),
    runtime: 'model',
    baseUrl: source.kind === 'grok' ? '' : (effectiveBaseUrl(source) || String(source.baseUrl || '')),
    keyMasked: keyMaskedOf(source.apiKey),
    hasKey: Boolean(String(source.apiKey || '').trim()),
    status,
    statusText,
    lastTestedAt: lastTestedAtMs(source.lastTest),
    models: providerModelsView(source),
    isDefault: Boolean(opts.defaultProviderId && String(source.id || '') === opts.defaultProviderId),
  };
}

export function vendorViews(): Vendor[] {
  const icons = brandIcons();
  return VENDOR_PRESETS.map((preset: { id: string; name: string; baseUrl: string; needsKey: boolean }) => ({
    id: preset.id,
    name: preset.name,
    access: accessForVendor(preset.id),
    needsKey: Boolean(preset.needsKey),
    baseUrl: preset.baseUrl || '',
    brand: brandIdOf(icons.brandForProvider(preset.id)),
  }));
}

export function defaultModelView(
  settings: SettingsLike | null | undefined,
  grokSignedIn = false,
): ResolvedModel | null {
  const effective = effectiveModelFor(settings, { grokSignedIn }) as {
    sourceId?: string | null;
    model?: string | null;
  };
  const providerId = typeof effective?.sourceId === 'string' ? effective.sourceId.trim() : '';
  const modelId = typeof effective?.model === 'string' ? effective.model.trim() : '';
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

export function providersSnapshot(opts: {
  settings?: SettingsLike | null;
  grokSignedIn?: boolean;
  lang?: Lang;
}): ProvidersSnapshot {
  const grokSignedIn = Boolean(opts.grokSignedIn);
  const sources = normalizeSources(opts.settings?.sources) as SourceLike[];
  const defaultModel = defaultModelView(opts.settings, grokSignedIn);
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  return {
    providers: sources.map((source) => providerView(source, {
      lang,
      grokSignedIn,
      defaultProviderId: defaultModel?.providerId ?? null,
    })),
    vendors: vendorViews(),
    defaultModel,
  };
}

export function lastTestFrom(
  result: { ok?: unknown; error?: unknown; code?: unknown; status?: unknown } | null | undefined,
  now = Date.now(),
): { ok: boolean; at: string; error?: string; code?: string; status?: number } {
  const lastTest: { ok: boolean; at: string; error?: string; code?: string; status?: number } = {
    ok: result?.ok === true,
    at: new Date(now).toISOString(),
  };
  if (!lastTest.ok) {
    const failure = probeFailurePayload(result) as { error?: string; code?: string; status?: number };
    if (failure.error) lastTest.error = redactAuthText(failure.error);
    if (failure.code) lastTest.code = failure.code;
    if (failure.status) lastTest.status = failure.status;
  }
  return lastTest;
}

export function probeResultView(
  result: { ok?: unknown; models?: unknown; error?: unknown; code?: unknown; status?: unknown } | null | undefined,
  opts: { lang?: Lang; vendor?: unknown } = {},
): ProviderProbeResult {
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  const ok = result?.ok === true;
  const models = ok && Array.isArray(result?.models)
    ? (result.models as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  if (ok) {
    return { ok: true, models, status: 'ok', statusText: '' };
  }
  const lastTest = lastTestFrom(result);
  const source = { vendor: opts.vendor, lastTest };
  const reason = 'offline';
  return {
    ok: false,
    models: [],
    status: providerStatusFromReason(source, reason),
    statusText: formatProbeFailureForLang(lastTest, lang) || sourceProbeStatusForLang(source, reason, lang),
  };
}

function timestampMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
}

export function grokPendingView(
  pending: GrokStatusLike['pending'] | { loginId?: unknown; verificationUri?: unknown; userCode?: unknown; interval?: unknown; expiresAt?: unknown } | null | undefined,
): GrokPending | null {
  if (!pending || typeof pending !== 'object') return null;
  const loginId = pending.loginId == null ? '' : String(pending.loginId);
  const verificationUri = pending.verificationUri == null ? '' : String(pending.verificationUri);
  const userCode = pending.userCode == null ? '' : String(pending.userCode);
  if (!loginId && !verificationUri && !userCode) return null;
  return {
    loginId,
    verificationUri,
    userCode,
    interval: Number.isFinite(Number(pending.interval)) ? Math.trunc(Number(pending.interval)) : 0,
    expiresAt: timestampMs(pending.expiresAt) ?? 0,
  };
}

export function grokSessionView(status: GrokStatusLike | null | undefined): GrokSession {
  return {
    signedIn: Boolean(status?.signedIn),
    account: status?.account == null || status.account === '' ? null : String(status.account),
    email: status?.email == null || status.email === '' ? null : String(status.email),
    expiresAt: timestampMs(status?.expiresAt),
    authMode: status?.authMode == null || status.authMode === '' ? null : String(status.authMode),
    source: status?.source == null || status.source === '' ? null : String(status.source),
    pending: grokPendingView(status?.pending),
  };
}

export function grokLoginStartView(started: {
  loginId?: unknown;
  verificationUri?: unknown;
  userCode?: unknown;
  interval?: unknown;
  expiresAt?: unknown;
}): GrokLoginStart {
  return grokPendingView(started) || {
    loginId: '',
    verificationUri: '',
    userCode: '',
    interval: 0,
    expiresAt: 0,
  };
}

export function grokPollView(result: { status?: unknown; interval?: unknown; expiresAt?: unknown; grok?: GrokStatusLike } | null | undefined): GrokLoginPollResult {
  if (result?.status === 'done') {
    return { status: 'done', grok: grokSessionView(result.grok) };
  }
  return {
    status: 'pending',
    interval: Number.isFinite(Number(result?.interval)) ? Math.trunc(Number(result?.interval)) : 0,
    expiresAt: timestampMs(result?.expiresAt) ?? 0,
  };
}
