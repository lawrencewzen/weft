/** POST /api/v2/client-log — the web page reports its own errors into the server log. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { log as defaultLog } from '../../core/log.mjs';
import { SESSION_COOKIE } from '../auth.ts';
import type { components } from '../contract.gen.ts';
import type { ReadObjectBodyFn, SendV2Fn } from './extensions.ts';

type V2Error = components['schemas']['V2Error'];

export const CLIENT_LOG_TAG = 'WEFT_CLIENT';
export const MAX_MESSAGE_BYTES = 2 * 1024;
export const MAX_STACK_BYTES = 8 * 1024;
export const MAX_PER_WINDOW = 30;
export const WINDOW_MS = 60_000;

const LEVELS = new Set(['error', 'warn']);
const SOURCES = new Set(['window.onerror', 'unhandledrejection', 'error-boundary', 'console']);

type LoggerLike = {
  error: (tag: string, message: string, ...extras: unknown[]) => void;
  warn: (tag: string, message: string, ...extras: unknown[]) => void;
};

/** Cut text to at most `max` UTF-8 bytes without splitting a character. */
export function truncateBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let end = Math.min(text.length, max);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > max) end -= 1;
  // do not leave half of a surrogate pair
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…[truncated]`;
}

/** Keep pathname and hash only; never the query string or origin. */
export function safePath(raw: string): string {
  let rest = raw;
  const hashAt = rest.indexOf('#');
  let hash = '';
  if (hashAt !== -1) {
    hash = rest.slice(hashAt);
    rest = rest.slice(0, hashAt);
  }
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  const q = rest.indexOf('?');
  if (q !== -1) rest = rest.slice(0, q);
  const qh = hash.indexOf('?');
  if (qh !== -1) hash = hash.slice(0, qh);
  return truncateBytes(rest + hash, 256);
}

export type ClientLogLimiter = {
  /** True when the record may be written. Reports `dropped N` once per window. */
  allow(sessionKey: string): boolean;
};

export function createClientLogLimiter(opts: {
  logger?: LoggerLike;
  now?: () => number;
  max?: number;
  windowMs?: number;
} = {}): ClientLogLimiter {
  const logger = opts.logger ?? (defaultLog as LoggerLike);
  const now = opts.now ?? Date.now;
  const max = opts.max ?? MAX_PER_WINDOW;
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const sessions = new Map<string, { start: number; count: number; dropped: number }>();

  function flush(key: string, entry: { dropped: number }): void {
    if (entry.dropped > 0) {
      logger.warn(CLIENT_LOG_TAG, `dropped ${entry.dropped} client log records (rate limit)`, { limit: `${max}/min` });
    }
    void key;
  }

  return {
    allow(sessionKey) {
      const t = now();
      // forget idle sessions, reporting what they dropped
      if (sessions.size > 256) {
        for (const [k, v] of sessions) {
          if (t - v.start >= windowMs) {
            flush(k, v);
            sessions.delete(k);
          }
        }
      }
      let entry = sessions.get(sessionKey);
      if (entry && t - entry.start >= windowMs) {
        flush(sessionKey, entry);
        entry = undefined;
      }
      if (!entry) {
        entry = { start: t, count: 0, dropped: 0 };
        sessions.set(sessionKey, entry);
      }
      if (entry.count >= max) {
        entry.dropped += 1;
        return false;
      }
      entry.count += 1;
      return true;
    },
  };
}

function sessionKeyOf(req: IncomingMessage): string {
  const raw = req.headers.cookie;
  if (raw) {
    for (const part of String(raw).split(';')) {
      const idx = part.indexOf('=');
      if (idx !== -1 && part.slice(0, idx).trim() === SESSION_COOKIE) return `s:${part.slice(idx + 1).trim()}`;
    }
  }
  return 'bearer';
}

function optString(body: Record<string, unknown>, key: string): string | undefined | null {
  const v = body[key];
  if (v == null) return undefined;
  return typeof v === 'string' ? v : null;
}

export async function handleClientLogApi(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  method: string;
  sendV2: SendV2Fn;
  readObjectBody: ReadObjectBodyFn;
  limiter: ClientLogLimiter;
  logger?: LoggerLike;
}): Promise<boolean> {
  const { req, res, pathname, method, sendV2, readObjectBody } = opts;
  if (pathname !== '/api/v2/client-log') return false;
  if (method !== 'POST') {
    sendV2(res, pathname, method, 405, { error: 'method not allowed', code: 'E_BAD_REQUEST' } satisfies V2Error);
    return true;
  }
  const body = await readObjectBody(req, res, pathname, method);
  if (!body) return true;
  const bad = (error: string): true => {
    sendV2(res, pathname, method, 400, { error, code: 'E_BAD_REQUEST' } satisfies V2Error);
    return true;
  };
  if (typeof body.level !== 'string' || !LEVELS.has(body.level)) return bad('invalid level');
  if (typeof body.message !== 'string' || !body.message) return bad('invalid message');
  const stack = optString(body, 'stack');
  const source = optString(body, 'source');
  const url = optString(body, 'url');
  const userAgent = optString(body, 'userAgent');
  const appVersion = optString(body, 'appVersion');
  if (stack === null || source === null || url === null || userAgent === null || appVersion === null) {
    return bad('invalid field');
  }
  if (source !== undefined && !SOURCES.has(source)) return bad('invalid source');

  if (opts.limiter.allow(sessionKeyOf(req))) {
    const logger = opts.logger ?? (defaultLog as LoggerLike);
    const message = truncateBytes(body.message, MAX_MESSAGE_BYTES);
    const fields = {
      source,
      path: url === undefined ? undefined : safePath(url),
      ua: userAgent === undefined ? undefined : truncateBytes(userAgent, 200),
      v: appVersion === undefined ? undefined : truncateBytes(appVersion, 40),
    };
    const stackText = stack ? truncateBytes(stack, MAX_STACK_BYTES) : undefined;
    if (body.level === 'warn') logger.warn(CLIENT_LOG_TAG, message, fields, stackText);
    else logger.error(CLIENT_LOG_TAG, message, fields, stackText);
  }
  sendV2(res, pathname, method, 204, null);
  return true;
}
