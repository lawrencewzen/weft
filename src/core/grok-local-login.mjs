/**
 * Read ~/.grok/auth.json (Grok CLI) without exposing tokens.
 * Same xAI OAuth client as pi-ai `dist/auth/oauth/xai.js`.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * Home for Grok CLI files. Tests pass a stub `env` without HOME so we
 * must not fall back to the real homedir (that would read the operator's login).
 */
export function grokHomeDir(env) {
  const fromEnv = process.platform === 'win32'
    ? (env?.USERPROFILE || env?.HOME)
    : (env?.HOME || env?.USERPROFILE);
  if (fromEnv) return String(fromEnv);
  if (env === process.env) return homedir();
  return '';
}

export function grokAuthPath(env) {
  const home = grokHomeDir(env);
  if (!home) return '';
  return path.join(home, '.grok', 'auth.json');
}

function pickXaiEntry(root) {
  const rec = asRecord(root);
  if (!rec) return null;
  const preferred = rec[`https://auth.x.ai::${XAI_OAUTH_CLIENT_ID}`];
  if (asRecord(preferred)) return asRecord(preferred);
  for (const [key, value] of Object.entries(rec)) {
    const entry = asRecord(value);
    if (!entry) continue;
    if (key.includes('auth.x.ai') && key.includes(XAI_OAUTH_CLIENT_ID)) return entry;
  }
  for (const value of Object.values(rec)) {
    const entry = asRecord(value);
    if (!entry) continue;
    if (text(entry.refresh_token) && text(entry.key)) return entry;
  }
  return null;
}

function accountOf(entry) {
  for (const key of ['email', 'account', 'username', 'user', 'login']) {
    const value = text(entry[key]);
    if (value) return value;
  }
  return '';
}

function expiresOf(entry) {
  const raw = entry.expires_at;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return ms - REFRESH_SKEW_MS;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed - REFRESH_SKEW_MS;
  }
  return Date.now();
}

/** Public view: detected + account only. Never include token fields. */
export function inspectGrokAuth(root) {
  const entry = pickXaiEntry(root);
  if (!entry) return { detected: false };
  const account = accountOf(entry);
  const hasAccess = Boolean(text(entry.key));
  const hasRefresh = Boolean(text(entry.refresh_token));
  if (!hasAccess && !hasRefresh && !account) return { detected: false };
  const out = { detected: true };
  if (account) out.account = account;
  return out;
}

/**
 * Convert Grok CLI auth to pi-ai xai OAuth credential.
 * Returns null if refresh/access cannot be mapped (caller must not invent refresh).
 */
export function grokAuthToXaiCredential(root) {
  const entry = pickXaiEntry(root);
  if (!entry) return null;
  const access = text(entry.key);
  const refresh = text(entry.refresh_token);
  if (!access || !refresh) return null;
  const cred = {
    type: 'oauth',
    access,
    refresh,
    expires: expiresOf(entry),
  };
  const account = accountOf(entry);
  if (account) cred.account = account;
  return cred;
}

export function readGrokAuthFile(filePath) {
  if (!filePath) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export function detectGrokLocalLogin(env) {
  const filePath = grokAuthPath(env);
  const root = readGrokAuthFile(filePath);
  if (!root) return { detected: false };
  return inspectGrokAuth(root);
}

export function loadGrokXaiCredential(env) {
  const filePath = grokAuthPath(env);
  const root = readGrokAuthFile(filePath);
  if (!root) return null;
  return grokAuthToXaiCredential(root);
}
