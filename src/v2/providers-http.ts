/** v2 Provider HTTP routes. Secrets stay out of responses and logs. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { components } from './contract.gen.ts';
import { normalizeLang } from './stream/hub.ts';
import {
  availableView,
  loginSessionView,
  providerView,
  providersSnapshotFrom,
  serviceErrorBody,
  type RawAvailable,
  type RawLoginSession,
  type RawProvider,
} from './views/providers.ts';
import { CUSTOM_PROVIDER_APIS } from '../core/provider-config.mjs';

type V2Error = components['schemas']['V2Error'];
type Provider = components['schemas']['Provider'];
type ProvidersSnapshot = components['schemas']['ProvidersSnapshot'];
type AvailableProvidersSnapshot = components['schemas']['AvailableProvidersSnapshot'];
type ProviderEnvelope = components['schemas']['ProviderEnvelope'];
type LoginSessionEnvelope = components['schemas']['LoginSessionEnvelope'];

export type ProvidersJsonBody =
  | V2Error
  | Provider
  | ProvidersSnapshot
  | AvailableProvidersSnapshot
  | ProviderEnvelope
  | LoginSessionEnvelope;

export type SendV2 = (
  res: ServerResponse,
  requestPath: string,
  method: string,
  status: number,
  body: ProvidersJsonBody | null,
) => void;

export type ProviderServiceLike = {
  listProviders: () => Promise<RawProvider[]>;
  listAvailable: () => Promise<RawAvailable[]>;
  getProvider: (id: string) => Promise<RawProvider | null>;
  getDefaultModel: () => Promise<{ providerId: string; modelId: string } | null>;
  patchProvider: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  removeProvider: (id: string) => Promise<unknown>;
  connectApiKey: (id: string, apiKey: string) => Promise<RawProvider | null>;
  connectEnv: (id: string) => Promise<RawProvider | null>;
  connectLocalLogin: (id: string) => Promise<RawProvider | null>;
  startOAuth: (id: string) => Promise<RawLoginSession>;
  getSession: (sid: string) => RawLoginSession | Promise<RawLoginSession>;
  answerSession: (sid: string, value: string) => RawLoginSession | Promise<RawLoginSession>;
  cancelSession: (sid: string) => RawLoginSession | Promise<RawLoginSession>;
  addCustom: (body: {
    name?: unknown;
    baseUrl?: unknown;
    api?: unknown;
    apiKey?: unknown;
  }) => Promise<RawProvider | null>;
  testProvider: (id: string) => Promise<RawProvider | null>;
};

export type ProvidersHttpOpts = {
  service?: ProviderServiceLike | null;
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

function statusOf(err: { code?: unknown }): number {
  const code = String(err?.code || '');
  if (code === 'E_NOT_FOUND') return 404;
  if (code === 'E_AUTH' || code === 'E_NETWORK' || code === 'E_HTTP' || code === 'E_BAD_REQUEST') return 400;
  if (code === 'E_CONFLICT') return 409;
  return 500;
}

function sendError(
  ctx: ProvidersHttpCtx,
  err: unknown,
  lang: 'zh' | 'en',
): void {
  const rec = err && typeof err === 'object' ? err as { code?: unknown; message?: unknown; phrase?: unknown; status?: unknown } : {};
  ctx.sendV2(ctx.res, ctx.pathname, ctx.method, statusOf(rec), serviceErrorBody(rec, lang));
}

function isProvidersPath(pathname: string): boolean {
  return pathname === '/api/v2/providers' || pathname.startsWith('/api/v2/providers/');
}

function isLoginPath(pathname: string): boolean {
  return pathname.startsWith('/api/v2/login-sessions/');
}

function parseTail(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw || raw.includes('/')) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

const CUSTOM_API = new Set(CUSTOM_PROVIDER_APIS);

export async function handleProvidersApi(ctx: ProvidersHttpCtx, opts: ProvidersHttpOpts): Promise<boolean> {
  const { res, url, pathname, method, sendV2 } = ctx;
  if (!isProvidersPath(pathname) && !isLoginPath(pathname)) return false;

  const lang = langOf(url);
  const service = opts.service;
  if (!service) {
    sendV2(res, pathname, method, 503, { error: 'providers api is being rewritten', code: 'E_UNAVAILABLE' });
    return true;
  }

  async function sendProvider(raw: RawProvider | null): Promise<void> {
    if (!raw) {
      sendV2(res, pathname, method, 404, serviceErrorBody({ code: 'E_NOT_FOUND', phrase: 'src_err_missing' }, lang));
      return;
    }
    sendV2(res, pathname, method, 200, { provider: providerView(raw, lang) });
  }

  try {
    if (method === 'GET' && pathname === '/api/v2/providers') {
      const [providers, defaultModel] = await Promise.all([
        service.listProviders(),
        service.getDefaultModel(),
      ]);
      sendV2(res, pathname, method, 200, providersSnapshotFrom({ providers, defaultModel }, lang));
      return true;
    }

    if (method === 'GET' && pathname === '/api/v2/providers/available') {
      const providers = await service.listAvailable();
      sendV2(res, pathname, method, 200, {
        providers: providers.map((item) => availableView(item, lang)),
      });
      return true;
    }

    if (method === 'POST' && pathname === '/api/v2/providers/custom') {
      const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
      if (!body) return true;
      const created = await service.addCustom({
        name: body.name,
        baseUrl: body.baseUrl,
        api: body.api,
        apiKey: body.apiKey,
      });
      opts.onProvidersChanged?.();
      await sendProvider(created);
      return true;
    }

    const connectMatch = pathname.match(/^\/api\/v2\/providers\/([^/]+)\/connect$/);
    if (method === 'POST' && connectMatch) {
      let id: string;
      try { id = decodeURIComponent(connectMatch[1]); } catch {
        sendV2(res, pathname, method, 400, { error: 'invalid id', code: 'E_BAD_REQUEST' });
        return true;
      }
      const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
      if (!body) return true;
      const connectMethod = String(body.method || '').trim();
      if (connectMethod === 'api_key') {
        const created = await service.connectApiKey(id, String(body.apiKey ?? ''));
        opts.onProvidersChanged?.();
        await sendProvider(created);
        return true;
      }
      if (connectMethod === 'env') {
        const created = await service.connectEnv(id);
        opts.onProvidersChanged?.();
        await sendProvider(created);
        return true;
      }
      if (connectMethod === 'oauth') {
        const session = await service.startOAuth(id);
        sendV2(res, pathname, method, 200, { session: loginSessionView(session, lang) });
        return true;
      }
      if (connectMethod === 'local_login') {
        const created = await service.connectLocalLogin(id);
        opts.onProvidersChanged?.();
        await sendProvider(created);
        return true;
      }
      sendV2(res, pathname, method, 400, serviceErrorBody({ code: 'E_BAD_REQUEST', phrase: 'src_err_method' }, lang));
      return true;
    }

    const testMatch = pathname.match(/^\/api\/v2\/providers\/([^/]+)\/test$/);
    if (method === 'POST' && testMatch) {
      let id: string;
      try { id = decodeURIComponent(testMatch[1]); } catch {
        sendV2(res, pathname, method, 400, { error: 'invalid id', code: 'E_BAD_REQUEST' });
        return true;
      }
      const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
      if (!body) return true;
      const tested = await service.testProvider(id);
      await sendProvider(tested);
      return true;
    }

    if ((method === 'PATCH' || method === 'DELETE') && pathname.startsWith('/api/v2/providers/')) {
      const id = parseTail(pathname, '/api/v2/providers/');
      if (!id) {
        sendV2(res, pathname, method, 404, { error: 'not found', code: 'E_NOT_FOUND' });
        return true;
      }
      if (method === 'DELETE') {
        await service.removeProvider(id);
        opts.onProvidersChanged?.();
        sendV2(res, pathname, method, 204, null);
        return true;
      }
      const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
      if (!body) return true;
      if (body.api != null && body.api !== '' && !CUSTOM_API.has(String(body.api))) {
        sendV2(res, pathname, method, 400, serviceErrorBody({ code: 'E_BAD_REQUEST', phrase: 'src_err_api' }, lang));
        return true;
      }
      await service.patchProvider(id, body);
      opts.onProvidersChanged?.();
      await sendProvider(await service.getProvider(id));
      return true;
    }

    const answerMatch = pathname.match(/^\/api\/v2\/login-sessions\/([^/]+)\/answer$/);
    if (method === 'POST' && answerMatch) {
      let sid: string;
      try { sid = decodeURIComponent(answerMatch[1]); } catch {
        sendV2(res, pathname, method, 400, { error: 'invalid id', code: 'E_BAD_REQUEST' });
        return true;
      }
      const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
      if (!body) return true;
      const session = await service.answerSession(sid, String(body.value ?? ''));
      sendV2(res, pathname, method, 200, { session: loginSessionView(session, lang) });
      return true;
    }

    const cancelMatch = pathname.match(/^\/api\/v2\/login-sessions\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      let sid: string;
      try { sid = decodeURIComponent(cancelMatch[1]); } catch {
        sendV2(res, pathname, method, 400, { error: 'invalid id', code: 'E_BAD_REQUEST' });
        return true;
      }
      const body = await ctx.readObjectBody(ctx.req, res, pathname, method);
      if (!body) return true;
      const session = await service.cancelSession(sid);
      sendV2(res, pathname, method, 200, { session: loginSessionView(session, lang) });
      return true;
    }

    const sessionId = parseTail(pathname, '/api/v2/login-sessions/');
    if (method === 'GET' && sessionId) {
      const session = await service.getSession(sessionId);
      sendV2(res, pathname, method, 200, { session: loginSessionView(session, lang) });
      return true;
    }

    sendV2(res, pathname, method, 404, { error: 'not found', code: 'E_NOT_FOUND' });
    return true;
  } catch (err) {
    sendError(ctx, err, lang);
    return true;
  }
}
