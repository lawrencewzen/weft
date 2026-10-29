/** v2 Provider HTTP routes. Rewritten in T59-4b; this placeholder returns 503. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { components } from './contract.gen.ts';

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

export type SettingsLike = {
  providers?: unknown;
  defaultModel?: unknown;
  [key: string]: unknown;
};

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

const UNAVAILABLE: V2Error = {
  error: 'providers api is being rewritten',
  code: 'E_UNAVAILABLE',
};

export async function handleProvidersApi(ctx: ProvidersHttpCtx, _opts: ProvidersHttpOpts): Promise<boolean> {
  const { res, pathname, method, sendV2 } = ctx;
  if (pathname !== '/api/v2/providers' && !pathname.startsWith('/api/v2/providers/')) return false;
  sendV2(res, pathname, method, 503, UNAVAILABLE);
  return true;
}
