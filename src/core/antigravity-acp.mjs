import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const ANTIGRAVITY_ACP_ID = 'antigravity-acp';
export const ANTIGRAVITY_ACP_MARKER = 'pi-antigravity-acp:managed-by-antigravity';

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function expandHome(file, home) {
  return file === '~' || file.startsWith('~/') ? path.join(home, file.slice(1)) : file;
}

function regularFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function effectiveHome(env = process.env) {
  const home = env?.HOME || env?.USERPROFILE;
  if (typeof home === 'string' && home.trim()) return home.trim();
  return homedir();
}

/** `<GEMINI_HOME>/antigravity-acp` or `<home>/.gemini/antigravity-acp`. */
export function resolveAntigravityAcpDirectory(env = process.env) {
  const home = effectiveHome(env);
  const geminiHome = typeof env?.GEMINI_HOME === 'string' ? env.GEMINI_HOME.trim() : '';
  const base = geminiHome ? expandHome(geminiHome, home) : path.join(home, '.gemini');
  return path.join(base, 'antigravity-acp');
}

/**
 * Structural local health only. Never returns token values.
 * `configured-not-authenticated` with an auth type is the macOS keychain case:
 * settings.json exists, the refresh token lives in the login keychain.
 */
export function inspectAntigravityAcpAuth(env = process.env) {
  const directory = resolveAntigravityAcpDirectory(env);
  const tokenPath = path.join(directory, 'acp_token.json');
  const settingsPath = path.join(directory, 'settings.json');
  const tokenFile = regularFile(tokenPath);
  const settingsFile = regularFile(settingsPath);
  let authType;
  if (settingsFile) {
    try {
      const settings = asRecord(JSON.parse(readFileSync(settingsPath, 'utf8')));
      const auth = asRecord(settings?.auth);
      if (typeof auth?.type === 'string' && auth.type.trim()) authType = auth.type.trim();
    } catch {
      return { status: 'corrupt', tokenFile, settingsFile };
    }
  }
  if (typeof env?.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim()) {
    return { status: 'api-key-env', authType: authType || 'gemini-api-key', tokenFile, settingsFile };
  }
  if (tokenFile) {
    try {
      const token = asRecord(JSON.parse(readFileSync(tokenPath, 'utf8')));
      if (typeof token?.refresh_token === 'string' && token.refresh_token.length > 0) {
        return { status: 'oauth-refreshable', authType: authType || 'oauth-personal', tokenFile, settingsFile };
      }
      return { status: 'corrupt', ...(authType ? { authType } : {}), tokenFile, settingsFile };
    } catch {
      return { status: 'corrupt', ...(authType ? { authType } : {}), tokenFile, settingsFile };
    }
  }
  if (authType) return { status: 'configured-not-authenticated', authType, tokenFile, settingsFile };
  return { status: 'missing', tokenFile, settingsFile };
}

export function antigravityAcpLocalLogin(env = process.env) {
  const health = inspectAntigravityAcpAuth(env);
  if (health.status === 'oauth-refreshable' || health.status === 'api-key-env') {
    return { detected: true };
  }
  if (health.status === 'configured-not-authenticated' && health.authType) {
    return { detected: true };
  }
  return { detected: false };
}

export function antigravityAcpCredential() {
  return {
    type: 'oauth',
    access: ANTIGRAVITY_ACP_MARKER,
    refresh: ANTIGRAVITY_ACP_MARKER,
    expires: Number.MAX_SAFE_INTEGER,
  };
}

export async function loadAntigravityAcp() {
  try {
    const mod = await import('../vendor/antigravity-acp.mjs');
    if (typeof mod.createAntigravityProvider !== 'function') return null;
    return mod.createAntigravityProvider();
  } catch (err) {
    console.error(`WEFT_WARN antigravity-acp ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
