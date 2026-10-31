import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const ANTIGRAVITY_ACP_ID = 'antigravity-acp';
export const ANTIGRAVITY_ACP_MARKER = 'pi-antigravity-acp:managed-by-antigravity';
/** Phrase key. A turn with no conversation workspace fails with this instead of process.cwd(). */
export const AGY_ERR_NO_WORKSPACE = 'agy_err_no_workspace';

const sessionCwds = new Map();
const turns = new AsyncLocalStorage();
const STREAM_CAPTURED = Symbol('weftAntigravityCwd');

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

function workspaceError() {
  const error = new Error(AGY_ERR_NO_WORKSPACE);
  error.code = 'E_AGY_NO_WORKSPACE';
  error.phrase = AGY_ERR_NO_WORKSPACE;
  return error;
}

/**
 * Remember which workspace an ACP session belongs to.
 * An empty cwd is stored on purpose: the turn must fail, not fall back to process.cwd().
 */
export function bindAntigravitySessionCwd(sessionId, cwd) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return;
  sessionCwds.set(id, typeof cwd === 'string' ? cwd.trim() : '');
}

/** Workspace for the conversation whose model request is running on this async resource. */
export function noteAntigravityTurn(cwd) {
  turns.enterWith({ cwd: typeof cwd === 'string' ? cwd.trim() : '' });
}

export function clearAntigravityCwdBindings() {
  sessionCwds.clear();
}

/**
 * Workspace directory for one ACP session. Missing or blank throws.
 * Never returns process.cwd().
 */
export function resolveAntigravityWorkspaceCwd(options = {}) {
  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  let cwd;
  if (sessionId && sessionCwds.has(sessionId)) {
    cwd = sessionCwds.get(sessionId);
  } else {
    const turn = turns.getStore();
    if (turn && typeof turn.cwd === 'string') cwd = turn.cwd;
    if (sessionId && cwd !== undefined) sessionCwds.set(sessionId, cwd);
  }
  if (typeof cwd !== 'string' || !cwd.trim()) throw workspaceError();
  return cwd;
}

function rememberStreamWorkspace(options) {
  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  if (!sessionId || sessionCwds.has(sessionId)) return;
  const turn = turns.getStore();
  if (!turn) return;
  sessionCwds.set(sessionId, typeof turn.cwd === 'string' ? turn.cwd : '');
}

/**
 * Copy the in-flight conversation workspace onto options.sessionId before the
 * plugin awaits. Concurrent conversations each call this on their own async resource.
 */
export function captureAntigravityWorkspaceOnStream(provider) {
  if (!provider || provider[STREAM_CAPTURED]) return provider;
  for (const name of ['stream', 'streamSimple']) {
    const fn = provider[name];
    if (typeof fn !== 'function') continue;
    provider[name] = function antigravityWorkspaceStream(model, context, options) {
      rememberStreamWorkspace(options);
      return fn.call(provider, model, context, options);
    };
  }
  provider[STREAM_CAPTURED] = true;
  return provider;
}

export async function loadAntigravityAcp() {
  try {
    const mod = await import('../vendor/antigravity-acp.mjs');
    if (typeof mod.createAntigravityProvider !== 'function') return null;
    if (typeof mod.setCwdResolver === 'function') {
      mod.setCwdResolver((options) => resolveAntigravityWorkspaceCwd(options));
    }
    const bundle = mod.createAntigravityProvider();
    captureAntigravityWorkspaceOnStream(bundle?.provider);
    return bundle;
  } catch (err) {
    console.error(`WEFT_WARN antigravity-acp ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
