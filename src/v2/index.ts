import type { IncomingMessage, ServerResponse } from 'node:http';
import { SECURITY_HEADERS } from '../core/auth.mjs';
import type { components } from './contract.gen.ts';
import { contractMismatchLog, validateResponse } from './validate.ts';
import { PROTOCOL_VERSION } from './version.ts';

type ServiceInfo = components['schemas']['ServiceInfo'];
type V2Error = components['schemas']['V2Error'];

export type V2Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

function v2Headers(): Record<string, string> {
  return {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'Weft-Protocol': PROTOCOL_VERSION,
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, v2Headers());
  res.end(JSON.stringify(body));
}

function sendV2(
  res: ServerResponse,
  requestPath: string,
  method: string,
  status: number,
  body: ServiceInfo | V2Error,
): void {
  if (process.env.WEFT_V2_VALIDATE === '1') {
    const result = validateResponse(requestPath, method, status, body);
    if (!result.ok) {
      console.error(contractMismatchLog(requestPath, method, status, result.errors));
      const errorBody: V2Error = { error: 'contract mismatch', code: 'E_CONTRACT' };
      writeJson(res, 500, errorBody);
      return;
    }
  }
  writeJson(res, status, body);
}

export function createV2Handler(opts: { serviceVersion: string; startedAt: number }): V2Handler {
  const { serviceVersion, startedAt } = opts;
  return async (req, res, url) => {
    if (url.pathname !== '/api/v2' && !url.pathname.startsWith('/api/v2/')) return false;
    const pathname = normalizePath(url.pathname);
    const method = req.method || 'GET';
    if (method === 'GET' && pathname === '/api/v2/service') {
      const body = {
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion,
        pid: process.pid,
        startedAt,
      } satisfies ServiceInfo;
      sendV2(res, pathname, method, 200, body);
      return true;
    }
    sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
    return true;
  };
}
