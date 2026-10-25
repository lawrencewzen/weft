import type { IncomingMessage, ServerResponse } from 'node:http';
import { SECURITY_HEADERS } from '../core/auth.mjs';
import {
  createV2Auth,
  generateLocalToken,
  handleNextLogin,
  resolveWebCodeTtlMs,
  type V2Auth,
} from './auth.ts';
import type { components } from './contract.gen.ts';
import { removeDiscoverySync, writeDiscoverySync } from './daemon/discovery.ts';
import { contractMismatchLog, validateResponse } from './validate.ts';
import { PROTOCOL_VERSION } from './version.ts';

type ServiceInfo = components['schemas']['ServiceInfo'];
type V2Error = components['schemas']['V2Error'];
type WebCode = components['schemas']['WebCode'];

export type V2Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export type V2Runtime = {
  handleApi: V2Handler;
  handleLogin: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
  writeDiscoveryFile: (port: number) => void;
  removeDiscoveryFile: () => void;
  dispose: () => void;
};

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
  body: ServiceInfo | WebCode | V2Error,
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

function unauthorized(res: ServerResponse, requestPath: string, method: string): void {
  sendV2(res, requestPath, method, 401, { error: 'unauthorized', code: 'E_UNAUTHORIZED' } satisfies V2Error);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) {
      const err = new Error('payload too large');
      (err as Error & { status?: number }).status = 413;
      throw err;
    }
    chunks.push(buf);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('invalid JSON');
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
}

export function createV2Handler(opts: {
  serviceVersion: string;
  startedAt: number;
  auth: V2Auth;
}): V2Handler {
  const { serviceVersion, startedAt, auth } = opts;
  return async (req, res, url) => {
    if (url.pathname !== '/api/v2' && !url.pathname.startsWith('/api/v2/')) return false;
    const pathname = normalizePath(url.pathname);
    const method = req.method || 'GET';

    if (method === 'POST' && pathname === '/api/v2/auth/web-code') {
      if (!auth.hasBearer(req)) {
        unauthorized(res, pathname, method);
        return true;
      }
      try {
        const body = await readJsonBody(req);
        if (body == null || typeof body !== 'object' || Array.isArray(body)) {
          sendV2(res, pathname, method, 400, { error: 'invalid body', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
      } catch (err) {
        const status = Number((err as { status?: number })?.status) || 400;
        const message = status === 413 ? 'payload too large' : 'invalid JSON';
        const code = status === 413 ? 'E_PAYLOAD' : 'E_BAD_REQUEST';
        sendV2(res, pathname, method, status, { error: message, code } satisfies V2Error);
        return true;
      }
      const issued = auth.issueWebCode();
      sendV2(res, pathname, method, 200, issued satisfies WebCode);
      return true;
    }

    if (!auth.isAuthorized(req)) {
      unauthorized(res, pathname, method);
      return true;
    }

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

export function createV2Runtime(opts: {
  serviceVersion: string;
  startedAt: number;
  dataDir: string;
  pid?: number;
  now?: () => number;
  webCodeTtlMs?: number;
}): V2Runtime {
  const pid = opts.pid ?? process.pid;
  const auth = createV2Auth({
    localToken: generateLocalToken(),
    now: opts.now,
    webCodeTtlMs: opts.webCodeTtlMs ?? resolveWebCodeTtlMs(),
  });
  const handleApi = createV2Handler({
    serviceVersion: opts.serviceVersion,
    startedAt: opts.startedAt,
    auth,
  });

  return {
    handleApi,
    handleLogin(req, res, url) {
      return handleNextLogin(req, res, url, auth);
    },
    writeDiscoveryFile(port: number) {
      writeDiscoverySync(opts.dataDir, {
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion: opts.serviceVersion,
        pid,
        port,
        startedAt: opts.startedAt,
        token: auth.localToken,
      });
    },
    removeDiscoveryFile() {
      removeDiscoverySync(opts.dataDir, pid);
    },
    dispose() {
      auth.dispose();
    },
  };
}
