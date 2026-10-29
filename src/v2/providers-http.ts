/** v2 Provider HTTP routes. Secrets stay out of responses and logs. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  applySourcePatch,
  createApiSource,
  effectiveBaseUrl,
  isValidContextWindow,
  modelsAfterProbe,
  normalizeHttpUrl,
  normalizeSources,
  probeModels,
  vendorPreset,
  sourceNeedsKey,
} from '../core/model-sources.mjs';
import { isMaskedOrEmptyApiKey } from '../core/settings.mjs';
import type { components } from './contract.gen.ts';
import { normalizeLang } from './stream/hub.ts';
import {
  lastTestFrom,
  probeResultView,
  providerView,
  providersSnapshot,
  type SettingsLike,
  type SourceLike,
} from './views/providers.ts';

type V2Error = components['schemas']['V2Error'];
type Provider = components['schemas']['Provider'];
type ProvidersSnapshot = components['schemas']['ProvidersSnapshot'];
type ProviderProbeResult = components['schemas']['ProviderProbeResult'];
type ProviderRemoved = components['schemas']['ProviderRemoved'];

export type ProvidersJsonBody =
  | V2Error
  | Provider
  | ProvidersSnapshot
  | ProviderProbeResult
  | ProviderRemoved;

export type SendV2 = (
  res: ServerResponse,
  requestPath: string,
  method: string,
  status: number,
  body: ProvidersJsonBody,
) => void;

export type ProvidersHttpOpts = {
  getSettings?: () => Promise<SettingsLike | null | undefined>;
  putSettings?: (patch: Record<string, unknown>) => Promise<SettingsLike | unknown>;
  probeFetch?: typeof fetch;
  probeTimeoutMs?: number;
  now?: () => number;
  onProvidersChanged?: () => void;
};

export type ProvidersHttpCtx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string;
  method: string;
  sendV2: SendV2;
  readObjectBody: (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    method: string,
  ) => Promise<Record<string, unknown> | null>;
};

function langOf(url: URL): 'zh' | 'en' {
  return normalizeLang(url.searchParams.get('lang')) === 'en' ? 'en' : 'zh';
}

function parseProviderId(raw: string): string | null {
  let id = raw;
  try { id = decodeURIComponent(raw); } catch { return null; }
  if (!/^[a-f0-9]{8}$/.test(id) && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(id)) return null;
  return id;
}

async function loadSettings(opts: ProvidersHttpOpts): Promise<SettingsLike> {
  if (!opts.getSettings) return { sources: [], models: {} };
  const settings = await opts.getSettings();
  return settings && typeof settings === 'object' ? settings : { sources: [], models: {} };
}

function sourcesOf(settings: SettingsLike): SourceLike[] {
  return normalizeSources(settings.sources) as SourceLike[];
}

function defaultProviderIdOf(settings: SettingsLike): string | null {
  const snap = providersSnapshot({ settings, lang: 'zh' });
  return snap.defaultModel?.providerId ?? null;
}

function viewOf(
  source: SourceLike,
  settings: SettingsLike,
  lang: 'zh' | 'en',
): Provider {
  return providerView(source, {
    lang,
    defaultProviderId: defaultProviderIdOf(settings),
  });
}

type ProbeModelsOpts = {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type ProbeOutcome = {
  ok?: boolean;
  models?: unknown;
  error?: unknown;
  code?: unknown;
  status?: unknown;
};

async function runProbe(opts: ProbeModelsOpts, probeFetch?: typeof fetch, timeoutMs?: number): Promise<ProbeOutcome> {
  const probe = probeModels as (args: ProbeModelsOpts) => Promise<ProbeOutcome>;
  return probe({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: probeFetch || opts.fetchImpl || globalThis.fetch,
    timeoutMs: timeoutMs ?? opts.timeoutMs ?? 10_000,
  });
}

export async function handleProvidersApi(ctx: ProvidersHttpCtx, opts: ProvidersHttpOpts): Promise<boolean> {
  const { res, url, pathname, method, sendV2 } = ctx;
  if (pathname !== '/api/v2/providers' && !pathname.startsWith('/api/v2/providers/')) return false;

  const lang = langOf(url);
  const now = opts.now ?? Date.now;

  if (method === 'GET' && pathname === '/api/v2/providers') {
    try {
      const settings = await loadSettings(opts);
      sendV2(res, pathname, method, 200, providersSnapshot({ settings, lang }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'list providers failed';
      sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/v2/providers') {
    const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
    if (!body) return true;
    const created = createApiSource(body) as { source?: SourceLike; error?: string };
    if (!created.source) {
      sendV2(res, pathname, method, 400, { error: created.error || 'invalid source', code: 'E_BAD_REQUEST' });
      return true;
    }
    if (!opts.putSettings) {
      sendV2(res, pathname, method, 500, { error: 'store not ready', code: 'E_INTERNAL' });
      return true;
    }
    try {
      const settings = await loadSettings(opts);
      const sources = sourcesOf(settings);
      if (sources.some((source) => source.id === created.source!.id)) {
        sendV2(res, pathname, method, 409, { error: 'exists', code: 'E_CONFLICT' });
        return true;
      }
      const saved = await opts.putSettings({ sources: [...sources, created.source] }) as SettingsLike | undefined;
      const next = saved && typeof saved === 'object' ? saved : { ...settings, sources: [...sources, created.source] };
      opts.onProvidersChanged?.();
      sendV2(res, pathname, method, 201, viewOf(created.source, next, lang));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'create failed';
      sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/v2/providers/test') {
    const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
    if (!body) return true;
    const preset = vendorPreset(body.vendor);
    if (!preset) {
      sendV2(res, pathname, method, 400, { error: 'unknown vendor', code: 'E_BAD_REQUEST' });
      return true;
    }
    const baseUrl = body.baseUrl != null && String(body.baseUrl).trim()
      ? normalizeHttpUrl(body.baseUrl)
      : (preset.id !== 'custom' ? preset.baseUrl : '');
    const apiKey = isMaskedOrEmptyApiKey(body.apiKey) ? '' : String(body.apiKey ?? '');
    if (!baseUrl) {
      sendV2(res, pathname, method, 400, { error: 'base url required', code: 'E_BAD_REQUEST' });
      return true;
    }
    if (sourceNeedsKey({ kind: 'api', vendor: preset.id }) && !apiKey) {
      sendV2(res, pathname, method, 400, { error: 'api key required', code: 'E_BAD_REQUEST' });
      return true;
    }
    try {
      const result = await runProbe({ baseUrl, apiKey }, opts.probeFetch, opts.probeTimeoutMs);
      sendV2(res, pathname, method, 200, probeResultView(result, { lang, vendor: preset.id }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'probe failed';
      sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' });
    }
    return true;
  }

  const contextMatch = /^\/api\/v2\/providers\/([^/]+)\/models\/([^/]+)\/context-window$/.exec(pathname);
  if (method === 'PUT' && contextMatch) {
    const id = parseProviderId(contextMatch[1]);
    let modelId = contextMatch[2];
    try { modelId = decodeURIComponent(modelId); } catch { /* keep */ }
    const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
    if (!body) return true;
    if (!Object.prototype.hasOwnProperty.call(body, 'window')) {
      sendV2(res, pathname, method, 400, { error: 'window required', code: 'E_BAD_REQUEST' });
      return true;
    }
    const window = body.window;
    if (window !== null && !isValidContextWindow(window)) {
      sendV2(res, pathname, method, 400, { error: 'invalid context window', code: 'E_BAD_REQUEST' });
      return true;
    }
    if (!modelId) {
      sendV2(res, pathname, method, 400, { error: 'model required', code: 'E_BAD_REQUEST' });
      return true;
    }
    return applyAndRespond(ctx, opts, id, { contextWindows: { [modelId]: window } }, lang, now);
  }

  const testMatch = /^\/api\/v2\/providers\/([^/]+)\/test$/.exec(pathname);
  if (method === 'POST' && testMatch) {
    const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
    if (!body) return true;
    const id = parseProviderId(testMatch[1]);
    try {
      const settings = await loadSettings(opts);
      const sources = sourcesOf(settings);
      const index = id ? sources.findIndex((source) => source.id === id) : -1;
      if (index < 0) {
        sendV2(res, pathname, method, 404, { error: 'not found' });
        return true;
      }
      const source = sources[index]!;
      const result: ProbeOutcome = await runProbe({
        baseUrl: String(effectiveBaseUrl(source) || ''),
        apiKey: String(source.apiKey || ''),
      }, opts.probeFetch, opts.probeTimeoutMs);
      const next: SourceLike = { ...source, lastTest: lastTestFrom(result, now()) };
      if (result.ok === true) {
        const probedModels = Array.isArray(result.models) ? result.models : [];
        const merged = modelsAfterProbe(source.models, probedModels) as { models: string[]; catalog: string[] };
        next.models = merged.models;
        if (merged.catalog.length) next.catalog = merged.catalog;
        else delete next.catalog;
      }
      const nextSources = sources.slice();
      nextSources[index] = next;
      if (!opts.putSettings) {
        sendV2(res, pathname, method, 500, { error: 'store not ready', code: 'E_INTERNAL' });
        return true;
      }
      const saved = await opts.putSettings({ sources: nextSources }) as SettingsLike | undefined;
      const savedSettings = saved && typeof saved === 'object' ? saved : { ...settings, sources: nextSources };
      opts.onProvidersChanged?.();
      sendV2(res, pathname, method, 200, viewOf(next, savedSettings, lang));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'probe failed';
      sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' });
    }
    return true;
  }

  const idMatch = /^\/api\/v2\/providers\/([^/]+)$/.exec(pathname);
  if (!idMatch) {
    sendV2(res, pathname, method, 404, { error: 'not found' });
    return true;
  }
  const id = parseProviderId(idMatch[1]);

  if (method === 'DELETE') {
    try {
      const settings = await loadSettings(opts);
      const sources = sourcesOf(settings);
      const index = id ? sources.findIndex((source) => source.id === id) : -1;
      if (index < 0) {
        sendV2(res, pathname, method, 404, { error: 'not found' });
        return true;
      }
      const current = sources[index]!;
      if (!opts.putSettings) {
        sendV2(res, pathname, method, 500, { error: 'store not ready', code: 'E_INTERNAL' });
        return true;
      }
      const nextSources = sources.filter((source) => source.id !== current.id);
      const models = { ...((settings.models && typeof settings.models === 'object') ? settings.models as Record<string, unknown> : {}) };
      const def = models.default as { sourceId?: unknown } | null | undefined;
      if (def && def.sourceId === current.id) models.default = null;
      await opts.putSettings({ sources: nextSources, models });
      opts.onProvidersChanged?.();
      sendV2(res, pathname, method, 200, { removed: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'delete failed';
      sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' });
    }
    return true;
  }

  if (method === 'PATCH') {
    const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
    if (!body) return true;
    const patch: Record<string, unknown> = {};
    for (const key of ['vendor', 'name', 'baseUrl', 'apiKey', 'models']) {
      if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
    }
    let defaultModel: unknown;
    const hasDefault = Object.prototype.hasOwnProperty.call(body, 'defaultModel');
    if (hasDefault) defaultModel = body.defaultModel;
    return applyAndRespond(ctx, opts, id, patch, lang, now, hasDefault ? { defaultModel } : undefined);
  }

  sendV2(res, pathname, method, 404, { error: 'not found' });
  return true;
}

async function applyAndRespond(
  ctx: ProvidersHttpCtx,
  opts: ProvidersHttpOpts,
  id: string | null,
  patch: Record<string, unknown>,
  lang: 'zh' | 'en',
  _now: () => number,
  extra?: { defaultModel?: unknown },
): Promise<true> {
  const { res, pathname, method, sendV2 } = ctx;
  try {
    const settings = await loadSettings(opts);
    const sources = sourcesOf(settings);
    const index = id ? sources.findIndex((source) => source.id === id) : -1;
    if (index < 0) {
      sendV2(res, pathname, method, 404, { error: 'not found' });
      return true;
    }
    const current = sources[index]!;
    const patched = applySourcePatch(current, patch) as { source?: SourceLike; error?: string };
    if (!patched.source) {
      sendV2(res, pathname, method, 400, { error: patched.error || 'invalid source', code: 'E_BAD_REQUEST' });
      return true;
    }
    const nextSources = sources.slice();
    nextSources[index] = patched.source;
    const models = { ...((settings.models && typeof settings.models === 'object') ? settings.models as Record<string, unknown> : {}) };
    if (extra && Object.prototype.hasOwnProperty.call(extra, 'defaultModel')) {
      const value = extra.defaultModel;
      if (value === null) {
        const def = models.default as { sourceId?: unknown } | null | undefined;
        if (def && def.sourceId === current.id) models.default = null;
      } else if (typeof value === 'string' && value.trim()) {
        const modelId = value.trim();
        const names = Array.isArray(patched.source.models) ? patched.source.models : [];
        if (!names.includes(modelId)) {
          sendV2(res, pathname, method, 400, { error: 'unknown model', code: 'E_BAD_REQUEST' });
          return true;
        }
        models.default = { sourceId: current.id, model: modelId };
      } else {
        sendV2(res, pathname, method, 400, { error: 'invalid defaultModel', code: 'E_BAD_REQUEST' });
        return true;
      }
    }
    if (!opts.putSettings) {
      sendV2(res, pathname, method, 500, { error: 'store not ready', code: 'E_INTERNAL' });
      return true;
    }
    const saved = await opts.putSettings({
      sources: nextSources,
      ...(extra ? { models } : {}),
    }) as SettingsLike | undefined;
    const savedSettings = saved && typeof saved === 'object'
      ? saved
      : { ...settings, sources: nextSources, ...(extra ? { models } : {}) };
    opts.onProvidersChanged?.();
    sendV2(res, pathname, method, 200, viewOf(patched.source, savedSettings, lang));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'update failed';
    sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' });
  }
  return true;
}
