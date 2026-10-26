import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isSecureRequest, SECURITY_HEADERS, tokensMatch } from '../core/auth.mjs';

export const SESSION_COOKIE = 'weft_session';
export const DEFAULT_WEB_CODE_TTL_MS = 60_000;
export const DEFAULT_STARTUP_CODE_TTL_MS = 600_000;
export const MAX_WEB_CODES = 256;
export const LOGIN_INVALID_MESSAGE = '登录链接无效或已过期，请重新运行 weft open';
export const NOT_BUILT_HINT = '新版界面未构建，请安装开发依赖后运行 npm run build:web';

const BEARER_PREFIX = 'Bearer ';

export type WebCodeIssue = {
  code: string;
  expiresAt: number;
};

export type V2Auth = {
  localToken: string;
  hasBearer(req: IncomingMessage): boolean;
  hasSession(req: IncomingMessage): boolean;
  isAuthorized(req: IncomingMessage): boolean;
  issueWebCode(ttlMs?: number): WebCodeIssue;
  consumeWebCode(code: string): boolean;
  issueSession(): string;
  dispose(): void;
};

export function generateLocalToken(): string {
  return randomBytes(32).toString('base64url');
}

function resolveTtlMs(raw: string, fallback: number): number {
  const text = String(raw || '').trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function resolveWebCodeTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveTtlMs(String(env.WEFT_V2_WEB_CODE_TTL_MS || ''), DEFAULT_WEB_CODE_TTL_MS);
}

export function resolveStartupCodeTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveTtlMs(String(env.WEFT_V2_STARTUP_CODE_TTL_MS || ''), DEFAULT_STARTUP_CODE_TTL_MS);
}

function cookieValue(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie;
  if (!raw) return '';
  let found = '';
  for (const part of String(raw).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k !== name) continue;
    try { found = decodeURIComponent(v); } catch { found = v; }
  }
  return found;
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization || '';
  if (!header.startsWith(BEARER_PREFIX)) return '';
  return header.slice(BEARER_PREFIX.length);
}

export function sessionCookieHeader(sessionId: string, { secure = false } = {}): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function createV2Auth(opts: {
  localToken: string;
  now?: () => number;
  webCodeTtlMs?: number;
  maxWebCodes?: number;
}): V2Auth {
  const localToken = opts.localToken;
  const now = opts.now ?? Date.now;
  const ttl = opts.webCodeTtlMs ?? DEFAULT_WEB_CODE_TTL_MS;
  const maxCodes = opts.maxWebCodes ?? MAX_WEB_CODES;
  const sessions = new Set<string>();
  const webCodes = new Map<string, number>();

  function pruneWebCodes(): void {
    const t = now();
    for (const [code, expiresAt] of webCodes) {
      if (expiresAt <= t) webCodes.delete(code);
    }
    while (webCodes.size >= maxCodes) {
      let oldestKey: string | null = null;
      let oldestExp = Infinity;
      for (const [code, expiresAt] of webCodes) {
        if (expiresAt < oldestExp) {
          oldestExp = expiresAt;
          oldestKey = code;
        }
      }
      if (!oldestKey) break;
      webCodes.delete(oldestKey);
    }
  }

  const timer = setInterval(pruneWebCodes, 10_000);
  timer.unref();

  function hasBearer(req: IncomingMessage): boolean {
    return tokensMatch(bearerToken(req), localToken);
  }

  function hasSession(req: IncomingMessage): boolean {
    const id = cookieValue(req, SESSION_COOKIE);
    return Boolean(id) && sessions.has(id);
  }

  return {
    localToken,
    hasBearer,
    hasSession,
    isAuthorized(req: IncomingMessage): boolean {
      return hasBearer(req) || hasSession(req);
    },
    issueWebCode(ttlMs?: number): WebCodeIssue {
      pruneWebCodes();
      const code = randomBytes(24).toString('base64url');
      const expiresAt = now() + (ttlMs ?? ttl);
      webCodes.set(code, expiresAt);
      return { code, expiresAt };
    },
    consumeWebCode(code: string): boolean {
      if (!code || typeof code !== 'string') return false;
      pruneWebCodes();
      const expiresAt = webCodes.get(code);
      webCodes.delete(code);
      if (expiresAt == null) return false;
      return expiresAt > now();
    },
    issueSession(): string {
      const id = randomBytes(32).toString('base64url');
      sessions.add(id);
      return id;
    },
    dispose(): void {
      clearInterval(timer);
      webCodes.clear();
      sessions.clear();
    },
  };
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

/** GET /auth?code=… — consume a one-time code and set weft_session. */
export function handleNextLogin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: V2Auth,
): boolean {
  if ((req.method || 'GET') !== 'GET') return false;
  const pathname = normalizePath(url.pathname);
  if (pathname === '/next/login') {
    res.writeHead(302, {
      ...SECURITY_HEADERS,
      'cache-control': 'no-store',
      Location: `/auth${url.search || ''}`,
    });
    res.end();
    return true;
  }
  if (pathname !== '/auth') return false;
  const code = url.searchParams.get('code') || '';
  if (!auth.consumeWebCode(code)) {
    res.writeHead(401, {
      ...SECURITY_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(LOGIN_INVALID_MESSAGE);
    return true;
  }
  const sessionId = auth.issueSession();
  res.writeHead(302, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    'Set-Cookie': sessionCookieHeader(sessionId, { secure: isSecureRequest(req) }),
    Location: '/',
  });
  res.end();
  return true;
}
