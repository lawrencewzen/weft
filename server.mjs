import http, { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS as BUILTIN_TOOLS } from './src/core/config.mjs';
import { resolveInWorkspace } from './src/core/paths.mjs';
import { listWorkspaceTree } from './src/core/workspace-tree.mjs';
import { diffStats } from './src/core/diff.mjs';
import { publicSettings } from './src/core/settings.mjs';
import { VENDOR_PRESETS } from './src/core/model-sources.mjs';
import { createCredentialStore, createModelsStore } from './src/core/provider-stores.mjs';
import { createProviderService } from './src/core/provider-service.mjs';
import { migrateAppSettingsToV3 } from './src/core/provider-migrate.mjs';
import { cloneGitRepo, stripGitUrlCredentials } from './src/core/git-import.mjs';
import { gitFailureBody, planWorkspaceGit as planGitImport, usesConnectionClone } from './src/core/workspace-git.mjs';
import {
  createGitConnection,
  publicGitConnection,
  recordGitTest,
  updateGitConnection,
} from './src/core/git-connections.mjs';
import { listGitlabBranches, listGitlabProjects, testGitlabConnection } from './src/core/gitlab-api.mjs';
import { createExtensionHost } from './src/core/extensions.mjs';
import { describePlugins, installPlugin, PLUGIN_ID } from './src/core/plugins.mjs';
import { listSkills, listSkillRecords, createSkill, updateSkill, deleteSkill, SKILL_ID } from './src/core/skills.mjs';
import { buildAgents } from './src/core/agents.mjs';
import { createSqliteStore } from './src/store/sqlite.mjs';
import { explicitDemo, selectChatRuntime } from './src/kernel/models.mjs';
import {
  resolveAuthToken,
  unauthenticatedHostsWarning,
  requestAuthorized,
  hostAllowed,
  originAllowed,
  isMutating,
  isJsonContentType,
  isSecureRequest,
  setCookieHeader,
  SECURITY_HEADERS,
  issueSseTicket,
  consumeSseTicket,
  tokensMatch,
} from './src/core/auth.mjs';
import { resolveAllowedWorkspacePath, defaultWorkspaceRoot, listBrowsableDirs } from './src/core/workspace-guard.mjs';
import { acquireDataDirLock } from './src/core/lock.mjs';
import { presentConversationContext } from './src/core/usage.mjs';
import { openConversationKernel } from './src/kernel/conversations.mjs';
import { createV2Runtime } from './src/v2/index.ts';
import { NOT_BUILT_HINT } from './src/v2/auth.ts';
import { loadSubagentFromStore } from './src/v2/load-subagent.ts';
import fs from 'node:fs/promises';

// 内置 fetch 默认不读 HTTP(S)_PROXY；配置了代理时让模型请求也走它（遵守 NO_PROXY）
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => String(process.env[k] || '').trim());
if (PROXY_ENV && process.env.NODE_USE_ENV_PROXY !== '1') {
  if (typeof http.setGlobalProxyFromEnv === 'function') http.setGlobalProxyFromEnv();
  else console.warn('WEFT_WARN 检测到代理环境变量，但当前 Node 不支持 http.setGlobalProxyFromEnv，请以 NODE_USE_ENV_PROXY=1 启动');
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_NEXT = path.join(ROOT, 'public-next');
const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 3000;
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const startedAt = Date.now();
const DATA_DIR = process.env.WEFT_DATA_DIR || path.join(ROOT, 'data');
const SKILL_DIRS = [path.join(ROOT, 'skills'), path.join(DATA_DIR, 'skills')];
const PLUGIN_DIRS = [path.join(ROOT, 'plugins'), path.join(DATA_DIR, 'plugins')];
const USER_SKILLS = path.join(DATA_DIR, 'skills');
const USER_PLUGINS = path.join(DATA_DIR, 'plugins');
await fs.mkdir(DATA_DIR, { recursive: true });
const v2Opts = {
  serviceVersion: String(pkg.version || '0.0.0'),
  startedAt,
  dataDir: DATA_DIR,
  demo: envRequestsFaux(),
  hasActiveWork: () => kernelApi?.hasActiveWork?.() ?? false,
  onIdleExit: () => shutdown(),
  onRestart: () => shutdown(),
  async loadConversation(id) {
    if (!kernelApi) return null;
    const conv = await store.getConversation(id);
    if (!conv) return null;
    const presented = await kernelApi.present(conv, { includeMessages: true });
    const subagents = await kernelApi.listSubagents(presented);
    const target = providerService ? await providerService.resolveTarget(presented) : null;
    return {
      presented,
      subagents,
      modelTarget: target ? { source: { id: target.providerId }, model: target.modelId } : null,
      window: providerService ? await providerService.contextWindowFor(presented) : null,
    };
  },
  async getConversation(id) {
    return (await store.getConversation(id)) || null;
  },
  async getMessageImage(conversationId, messageId, index) {
    if (!kernelApi) return null;
    return kernelApi.getMessageImage(conversationId, messageId, index);
  },
  async getMessagePaste(conversationId, messageId, index) {
    if (!kernelApi) return null;
    return kernelApi.getMessagePaste(conversationId, messageId, index);
  },
  async getWorkspace(id) {
    return (await store.getWorkspace(id)) || null;
  },
  async postMessage(conv, text, opts) {
    if (!kernelApi) return { status: 500, body: { error: 'kernel not ready' } };
    return kernelApi.postMessage(conv, text, opts);
  },
  async withdrawMessage(cid, requestId) {
    if (!kernelApi) return { status: 500, body: { error: 'kernel not ready' } };
    return kernelApi.withdrawMessage(cid, requestId);
  },
  async stopConversation(id) {
    if (!kernelApi) return { status: 500, body: { error: 'kernel not ready' } };
    return kernelApi.stopConversation(id);
  },
  subscribeConversation(cid, fn) {
    if (!kernelApi) return () => {};
    return kernelApi.subscribe(cid, fn);
  },
  listWorkspaces() {
    return store.listWorkspaces();
  },
  listConversations(workspaceId) {
    return store.listConversations(workspaceId);
  },
  statusOf(conv) {
    if (!kernelApi) return Promise.resolve('idle');
    return kernelApi.statusOf(conv);
  },
  subagentDigests(convs) {
    if (!kernelApi) return Promise.resolve(new Map());
    return kernelApi.subagentDigests(convs);
  },
  async createConversation(workspaceId, fields = {}) {
    const ws = await store.getWorkspace(workspaceId);
    if (!ws || ws.removedAt) return { status: 404 };
    if (!kernelApi) return { status: 500 };
    const conv = await kernelApi.createConversation({
      workspaceId,
      workspacePath: ws.path,
      title: fields.title || 'New conversation',
      status: 'idle',
    });
    return { status: 201, conv };
  },
  async removeWorkspace(id) {
    await store.removeWorkspace(id);
  },
  subscribeAll(fn) {
    if (!kernelApi) return () => {};
    return kernelApi.subscribeAll(fn);
  },
  async loadSubagent(cid, agentId) {
    if (!kernelApi) return null;
    return loadSubagentFromStore({
      getConversation: (id) => store.getConversation(id),
      listSubagents: (conv) => kernelApi.listSubagents(conv),
      childMessages: (id, aid) => kernelApi.childMessages(id, aid),
    }, cid, agentId);
  },
  async sendToAgent(cid, agentId, text) {
    if (!kernelApi) return { status: 500, body: { error: 'kernel not ready' } };
    return kernelApi.sendToAgent(cid, agentId, text);
  },
  async stopAgent(cid, agentId) {
    if (!kernelApi) return { status: 500, body: { error: 'kernel not ready' } };
    return kernelApi.stopAgent(cid, agentId);
  },
  async changesConversation(cid) {
    if (!kernelApi) return [];
    return kernelApi.changes(cid);
  },
  async diffConversation(cid, filePath) {
    if (!kernelApi) return { status: 500, body: { error: 'kernel not ready' } };
    return kernelApi.diff(cid, filePath);
  },
  async patchConversation(id, body) {
    if (!kernelApi) return { status: 500, body: { error: 'kernel not ready' } };
    return kernelApi.patchConversation(id, body);
  },
  getSettings() {
    return ensureSettings();
  },
  putSettings(patch) {
    return store.putSettings(patch);
  },
  extensions: {
    dataDir: DATA_DIR,
    rootDir: ROOT,
    pluginDirs: PLUGIN_DIRS,
    userPlugins: USER_PLUGINS,
    skillDirs: SKILL_DIRS,
    userSkills: USER_SKILLS,
    createWorkspace(fields) {
      return store.createWorkspace(fields);
    },
    restoreWorkspaceByPath(wsPath, name) {
      return store.restoreWorkspaceByPath(wsPath, name);
    },
    getSettings() {
      return store.getSettings();
    },
    putSettings(patch) {
      return store.putSettings(patch);
    },
    async reloadPlugins() {
      await reloadKernelPlugins();
    },
    planWorkspaceGit(body) {
      return planGitImport(body, { loadConnections: loadGitConnections });
    },
  },
};
const v2 = createV2Runtime(v2Opts);

let dataLock;
try {
  dataLock = await acquireDataDirLock(DATA_DIR);
} catch (err) {
  console.error(`WEFT_ERROR ${err.message || err}`);
  process.exit(1);
}

const { token: AUTH_TOKEN, enabled: AUTH_ENABLED } = resolveAuthToken();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

function sendCatalogError(res, err) {
  const status = Number(err?.status) || 500;
  const body = { error: status >= 500 ? 'server error' : (err?.message || 'error') };
  if (err?.catalogCode) body.code = err.catalogCode;
  sendJson(res, status, body);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function boundPort() {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : PORT;
}

async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('payload too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('invalid JSON');
    err.status = 400;
    throw err;
  }
}

function envRequestsFaux() {
  return explicitDemo();
}

async function ensureSettings() {
  await migrateAppSettingsToV3(store, { credentials: credentialStore });
  return store.getSettings();
}

async function resolveChatKind() {
  if (envRequestsFaux()) return 'faux';
  if (String(process.env.WEFT_LLM || '').trim().toLowerCase() === 'openai') return 'openai';
  const available = providerService ? await providerService.hasAvailableModel() : false;
  return selectChatRuntime('', { hasApiKey: available, hasBaseUrl: available });
}

async function settingsResponse(stored) {
  const body = publicSettings(stored);
  body.vendors = VENDOR_PRESETS.map((item) => ({ ...item }));
  body.runtime = await resolveChatKind();
  return body;
}

function publicConversation(conv) {
  if (!conv) return conv;
  const out = { ...conv };
  delete out.harnessId;
  delete out.lastSubmissionId;
  delete out.autoContinues;
  delete out.retries;
  delete out.lastCheckpointAt;
  delete out.currentStep;
  delete out.pipelineId;
  delete out.pipelineStep;
  return out;
}

async function agentsFor(conv, messages) {
  return buildAgents({ conv, messages });
}

function sendStaticFile(req, res, fp, type) {
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(fp).pipe(res);
}

function sendNotBuilt(res) {
  res.writeHead(404, {
    ...SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(NOT_BUILT_HINT);
}

/** Old bookmarks /next and /next/<path> redirect to the same path without the prefix. */
function serveNextRedirect(req, res, url) {
  const pathname = url.pathname;
  if (pathname !== '/next' && !pathname.startsWith('/next/')) return false;
  const rest = pathname === '/next' ? '/' : pathname.slice('/next'.length) || '/';
  const dest = rest.startsWith('/') ? rest : `/${rest}`;
  res.writeHead(302, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    Location: `${dest}${url.search || ''}`,
  });
  res.end();
  return true;
}

/** The legacy UI is gone (T47-1); old bookmarks fall back to the new app. */
function serveLegacyRedirect(req, res, url) {
  const pathname = url.pathname;
  if (pathname !== '/legacy' && !pathname.startsWith('/legacy/')) return false;
  res.writeHead(302, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    Location: '/',
  });
  res.end();
  return true;
}

/** New React app at /. */
function serveNew(req, res, url) {
  if (!existsSync(PUBLIC_NEXT)) {
    sendNotBuilt(res);
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const fp = path.resolve(PUBLIC_NEXT, `.${rel}`);
  if (!fp.startsWith(PUBLIC_NEXT + path.sep) && fp !== PUBLIC_NEXT) {
    res.writeHead(403, { ...SECURITY_HEADERS });
    res.end('Forbidden');
    return;
  }
  if (existsSync(fp) && statSync(fp).isFile()) {
    const type = MIME[path.extname(fp)] || 'application/octet-stream';
    sendStaticFile(req, res, fp, type);
    return;
  }
  if (path.extname(rel)) {
    res.writeHead(404, { ...SECURITY_HEADERS });
    res.end('Not found');
    return;
  }
  const fallback = path.join(PUBLIC_NEXT, 'index.html');
  if (existsSync(fallback) && statSync(fallback).isFile()) {
    sendStaticFile(req, res, fallback, 'text/html; charset=utf-8');
    return;
  }
  sendNotBuilt(res);
}

function isSsePath(p) {
  return /^\/api\/conversations\/[^/]+\/events$/.test(p);
}

const store = createSqliteStore(DATA_DIR);
const credentialStore = createCredentialStore(store);
const modelsStore = createModelsStore(store);
const providerService = createProviderService({
  store,
  credentials: credentialStore,
  modelsStore,
  onChange() {
    try { v2.notifyProvidersChanged(); } catch { /* v2 may still be starting */ }
  },
});
v2Opts.providerService = providerService;
let kernelApi = null;

async function reloadKernelPlugins() {
  if (typeof kernelApi?.reloadPlugins !== 'function') return;
  try {
    await kernelApi.reloadPlugins();
  } catch (err) {
    console.error(`WEFT_KERNEL_PLUGIN ${err instanceof Error ? err.message : err}`);
  }
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { v2.removeDiscoveryFile(); } catch { /* ignore */ }
  try { v2.dispose(); } catch { /* ignore */ }
  try { store.close(); } catch { /* ignore */ }
  try { dataLock?.release?.(); } catch { /* ignore */ }
  dataLock = null;
  if (!kernelApi) {
    process.exit(0);
    return;
  }
  kernelApi.close().finally(() => process.exit(0));
}
process.on('exit', () => {
  try { v2.removeDiscoveryFile(); } catch { /* ignore */ }
  try { dataLock?.release?.(); } catch { /* ignore */ }
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, shutdown);
}
// Tests spawn with a pipe on stdin (Windows cannot deliver SIGTERM). Closing
// that pipe is the portable graceful-exit path; interactive TTY is unchanged.
if (String(process.env.WEFT_STDIN_EXIT || '').trim() === '1') {
  process.stdin.on('end', shutdown);
  process.stdin.on('error', () => {});
  process.stdin.resume();
  if (process.stdin.readableEnded) shutdown();
}

await ensureSettings();
{
  const baseUrl = String(process.env.LLM_BASE_URL || '').trim();
  const apiKey = String(process.env.LLM_API_KEY || '').trim();
  const model = String(process.env.LLM_MODEL || '').trim();
  if (baseUrl || apiKey || model) {
    await providerService.seedFromEnv({ baseUrl, apiKey, model });
  }
}

const extensionHost = createExtensionHost({
  skillDirs: SKILL_DIRS,
  pluginDirs: PLUGIN_DIRS,
  getSettings: () => store.getSettings(),
});

try {
  kernelApi = await openConversationKernel({
    dataDir: DATA_DIR,
    store,
    demo: envRequestsFaux(),
    describeAgents: agentsFor,
    extensions: extensionHost,
    getSettings: () => ensureSettings(),
    credentials: credentialStore,
    modelsStore,
    providerService,
  });
} catch (err) {
  console.error(`WEFT_KERNEL_OPEN_FAILED ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    v2.touch();
    const port = boundPort();
    if (!hostAllowed(req.headers.host, port)) {
      sendJson(res, 400, { error: 'invalid host' });
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login/')) {
      if (!AUTH_ENABLED) {
        res.writeHead(302, {
          ...SECURITY_HEADERS,
          'cache-control': 'no-store',
          Location: '/',
        });
        res.end();
        return;
      }
      const given = url.searchParams.get('token') || '';
      if (!tokensMatch(given, AUTH_TOKEN)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        'Set-Cookie': setCookieHeader(AUTH_TOKEN, { secure: isSecureRequest(req) }),
        Location: '/',
      });
      res.end();
      return;
    }

    if (isMutating(req.method)) {
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin, port)) {
        sendJson(res, 403, { error: 'invalid origin' });
        return;
      }
      if (!isJsonContentType(req)) {
        sendJson(res, 415, { error: 'unsupported media type' });
        return;
      }
    }

    if (url.pathname.startsWith('/api/')) {
      const p = url.pathname.replace(/\/$/, '') || '/';
      if (await v2.handleApi(req, res, url)) return;
      if (AUTH_ENABLED && !requestAuthorized(req, AUTH_TOKEN)) {
        if (req.method === 'GET' && isSsePath(p) && consumeSseTicket(url.searchParams.get('ticket'))) {
          /* ticket consumed */
        } else {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
      }
      await routeApi(req, res, url);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (v2.handleLogin(req, res, url)) return;
      if (serveNextRedirect(req, res, url)) return;
      if (serveLegacyRedirect(req, res, url)) return;
      serveNew(req, res, url);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.status || (err.code === 'E_SANDBOX' ? 403 : 500);
    if (!res.headersSent) {
      if (err.code === 'E_SANDBOX') sendJson(res, 403, { error: 'E_SANDBOX' });
      else sendJson(res, status, { error: err.message || 'server error' });
    } else {
      res.end();
    }
  }
});

async function handleSources(req, res, p, m) {
  if (p === '/api/sources' || p === '/api/sources/test' || /^\/api\/sources\/[^/]+$/.test(p)) {
    sendJson(res, 503, { error: 'providers api is being rewritten', code: 'E_UNAVAILABLE' });
    return true;
  }
  return false;
}

async function loadGitConnections() {
  const settings = await store.getSettings();
  return Array.isArray(settings.gitConnections) ? settings.gitConnections : [];
}

async function saveGitConnections(list) {
  await store.putSettings({ gitConnections: list });
  return loadGitConnections();
}

async function planGit(body) {
  return planGitImport(body, { loadConnections: loadGitConnections });
}

async function testConnectionRecord(connection) {
  const result = await testGitlabConnection(connection);
  return { ok: result.ok === true, username: result.username || '', code: result.ok ? '' : (result.code || 'unknown') };
}

async function handleGitConnections(req, res, p, m) {
  if (!p.startsWith('/api/git/connections')) return false;

  if (p === '/api/git/connections' && m === 'GET') {
    sendJson(res, 200, (await loadGitConnections()).map(publicGitConnection));
    return true;
  }
  if (p === '/api/git/connections' && m === 'POST') {
    const body = await readBody(req);
    const list = await loadGitConnections();
    if (list.length >= 50) {
      sendJson(res, 400, { error: 'invalid connection', errors: ['too many connections'] });
      return true;
    }
    const built = createGitConnection(body || {});
    if (!built.ok) {
      sendJson(res, 400, { error: 'invalid connection', errors: built.errors });
      return true;
    }
    list.push(built.value);
    await saveGitConnections(list);
    v2.notifyExtensionsChanged();
    sendJson(res, 201, publicGitConnection(built.value));
    return true;
  }
  if (p === '/api/git/connections/test' && m === 'POST') {
    const body = await readBody(req) || {};
    let connection;
    if (body.id) {
      const current = (await loadGitConnections()).find((item) => item.id === String(body.id));
      if (!current) {
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      const updated = updateGitConnection(current, body);
      if (!updated.ok) {
        const code = updated.errors?.includes('token required') ? 'auth_failed' : 'unknown';
        sendJson(res, 200, { ok: false, code });
        return true;
      }
      connection = updated.value;
    } else {
      const built = createGitConnection(body);
      if (!built.ok) {
        const code = built.errors?.includes('token required') ? 'auth_failed' : 'unknown';
        sendJson(res, 200, { ok: false, code });
        return true;
      }
      connection = built.value;
    }
    const result = await testConnectionRecord(connection);
    sendJson(res, 200, result.ok ? { ok: true, username: result.username } : { ok: false, code: result.code });
    return true;
  }

  let match = p.match(/^\/api\/git\/connections\/([^/]+)\/projects\/([^/]+)\/branches$/);
  if (match && m === 'GET') {
    const connection = (await loadGitConnections()).find((item) => item.id === decodeURIComponent(match[1]));
    if (!connection) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    const result = await listGitlabBranches(connection, decodeURIComponent(match[2]));
    if (!result.ok) {
      sendJson(res, 400, { error: 'git clone failed', code: result.code || 'unknown', via: 'connection' });
      return true;
    }
    sendJson(res, 200, { branches: result.branches, defaultBranch: result.defaultBranch || '' });
    return true;
  }
  match = p.match(/^\/api\/git\/connections\/([^/]+)\/projects$/);
  if (match && m === 'GET') {
    const connection = (await loadGitConnections()).find((item) => item.id === decodeURIComponent(match[1]));
    if (!connection) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    const result = await listGitlabProjects(connection, urlSearch(req));
    if (!result.ok) {
      sendJson(res, 400, { error: 'git clone failed', code: result.code || 'unknown', via: 'connection' });
      return true;
    }
    sendJson(res, 200, { projects: result.projects });
    return true;
  }
  match = p.match(/^\/api\/git\/connections\/([^/]+)\/test$/);
  if (match && m === 'POST') {
    const id = decodeURIComponent(match[1]);
    const list = await loadGitConnections();
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    const result = await testConnectionRecord(list[index]);
    list[index] = recordGitTest(list[index], result);
    await saveGitConnections(list);
    v2.notifyExtensionsChanged();
    sendJson(res, 200, result.ok
      ? { ok: true, username: result.username, connection: publicGitConnection(list[index]) }
      : { ok: false, code: result.code, connection: publicGitConnection(list[index]) });
    return true;
  }
  match = p.match(/^\/api\/git\/connections\/([^/]+)$/);
  if (match && m === 'PATCH') {
    const id = decodeURIComponent(match[1]);
    const list = await loadGitConnections();
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    const body = await readBody(req) || {};
    const updated = updateGitConnection(list[index], body);
    if (!updated.ok) {
      sendJson(res, 400, { error: 'invalid connection', errors: updated.errors });
      return true;
    }
    list[index] = updated.value;
    await saveGitConnections(list);
    v2.notifyExtensionsChanged();
    sendJson(res, 200, publicGitConnection(updated.value));
    return true;
  }
  if (match && m === 'DELETE') {
    const id = decodeURIComponent(match[1]);
    const list = await loadGitConnections();
    if (!list.some((item) => item.id === id)) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    await saveGitConnections(list.filter((item) => item.id !== id));
    v2.notifyExtensionsChanged();
    sendJson(res, 200, { ok: true, id });
    return true;
  }
  return false;
}

function urlSearch(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1').searchParams.get('search') || '';
  } catch {
    return '';
  }
}

async function routeApi(req, res, url) {
  const p = url.pathname.replace(/\/$/, '') || '/';
  const m = req.method;

  if (await handleGitConnections(req, res, p, m)) return;

  if (m === 'GET' && p === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (m === 'GET' && p === '/api/workspace-root') {
    sendJson(res, 200, { root: defaultWorkspaceRoot() });
    return;
  }

  if (m === 'GET' && p === '/api/workspace-root/dirs') {
    try {
      sendJson(res, 200, await listBrowsableDirs(url.searchParams.get('path')));
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message || 'path is not allowed', code: err.code || 'E_PATH' });
    }
    return;
  }

  if (m === 'POST' && p === '/api/sse-ticket') {
    sendJson(res, 200, issueSseTicket(60_000));
    return;
  }

  if (m === 'POST' && p === '/api/workspaces') {
    const body = await readBody(req);
    if (!body?.name) {
      sendJson(res, 400, { error: 'name required' });
      return;
    }
    const wantsGit = Boolean(body.gitUrl) || Boolean(body.connectionId) || (body.projectId != null && String(body.projectId).trim() !== '');
    if (wantsGit) {
      const id = randomUUID();
      const dest = path.join(DATA_DIR, 'workspaces', id, 'repo');
      try {
        const planned = await planGit(body);
        let gitUrl = planned.gitUrl;
        let branch = planned.branch || '';
        const connection = usesConnectionClone(planned.connection, gitUrl) ? planned.connection : null;
        try {
          await cloneGitRepo({ url: gitUrl, branch, dest, connection });
        } catch (err) {
          if (connection && !err.via) err.via = 'connection';
          throw err;
        }
        gitUrl = stripGitUrlCredentials(gitUrl);
        const ws = await store.createWorkspace({
          id,
          name: body.name,
          path: dest,
          source: 'git',
          gitUrl,
          branch: branch || null,
          rootPath: dest,
          worktrees: [],
        });
        sendJson(res, 201, { id: ws.id, name: ws.name, path: ws.path, source: ws.source, gitUrl: ws.gitUrl, branch: ws.branch, rootPath: ws.rootPath, worktrees: ws.worktrees });
        v2.notifySidebarChanged();
      } catch (err) {
        sendJson(res, err.status || 400, gitFailureBody(err));
      }
      return;
    }
    if (!body.path) {
      const id = randomUUID();
      const dest = path.join(DATA_DIR, 'workspaces', id, 'repo');
      await fs.mkdir(dest, { recursive: true });
      const ws = await store.createWorkspace({
        id,
        name: body.name,
        path: dest,
        source: 'local',
        rootPath: dest,
        worktrees: [],
      });
      sendJson(res, 201, { id: ws.id, name: ws.name, path: ws.path, source: ws.source, gitUrl: ws.gitUrl, branch: ws.branch, rootPath: ws.rootPath, worktrees: ws.worktrees });
      v2.notifySidebarChanged();
      return;
    }
    let resolved;
    try {
      resolved = await resolveAllowedWorkspacePath(body.path, { dataDir: DATA_DIR });
    } catch (err) {
      sendJson(res, err.status || 400, {
        error: err.message || 'path is not allowed',
        allowedRoot: defaultWorkspaceRoot(),
      });
      return;
    }
    const ws = (await store.restoreWorkspaceByPath(resolved, body.name))
      || await store.createWorkspace({ name: body.name, path: resolved, source: 'local', rootPath: resolved, worktrees: [] });
    sendJson(res, 201, { id: ws.id, name: ws.name, path: ws.path, source: ws.source, gitUrl: ws.gitUrl, branch: ws.branch, rootPath: ws.rootPath, worktrees: ws.worktrees });
    v2.notifySidebarChanged();
    return;
  }

  if (m === 'GET' && p === '/api/workspaces') {
    sendJson(res, 200, await store.listWorkspaces());
    return;
  }

  {
    const removeMatch = m === 'DELETE' && p.match(/^\/api\/workspaces\/([^/]+)$/);
    if (removeMatch) {
      const wid = decodeURIComponent(removeMatch[1]);
      const ws = await store.getWorkspace(wid);
      if (!ws || ws.removedAt) { sendJson(res, 404, { error: 'workspace not found' }); return; }
      const busy = [];
      for (const item of await store.listConversations(wid)) {
        const live = await kernelApi.present(item);
        if (live.status === 'running') busy.push(live.id);
      }
      if (busy.length) {
        sendJson(res, 409, { error: 'workspace has active conversations', code: 'E_WS_BUSY', conversations: busy });
        return;
      }
      // Only hides the workspace. Files on disk and conversation records are kept.
      await store.removeWorkspace(wid);
      sendJson(res, 200, { id: wid, removed: true });
      v2.notifySidebarChanged();
      return;
    }
  }

  let match;
  match = p.match(/^\/api\/workspaces\/([^/]+)\/conversations$/);
  if (match && m === 'POST') {
    const wid = decodeURIComponent(match[1]);
    const ws = await store.getWorkspace(wid);
    if (!ws) { sendJson(res, 404, { error: 'workspace not found' }); return; }
    const body = await readBody(req);
    const modelChoice = await providerService.resolveConversationModelPatch(body);
    if (modelChoice.present && !modelChoice.ok) {
      sendJson(res, 400, { errors: modelChoice.errors });
      return;
    }
    const conv = await kernelApi.createConversation({
      workspaceId: wid,
      workspacePath: ws.path,
      title: body.title || 'New conversation',
      status: 'idle',
      ...(modelChoice.present ? modelChoice.value : {}),
    });
    sendJson(res, 201, {
      id: conv.id,
      workspaceId: conv.workspaceId,
      title: conv.title,
      status: 'idle',
      modelSourceId: conv.modelSourceId || null,
      modelId: conv.modelId || null,
    });
    v2.notifySidebarChanged();
    return;
  }
  if (match && m === 'GET') {
    const wid = decodeURIComponent(match[1]);
    const q = url.searchParams.get('q') || undefined;
    const list = await store.listConversations(wid, { q });
    const digests = await kernelApi.subagentDigests(list);
    const presented = [];
    for (const item of list) {
      const row = publicConversation(await kernelApi.present(item));
      const digest = digests.get(item.id);
      if (digest?.total > 0) {
        row.subagents = { total: digest.total, live: digest.live };
      }
      presented.push(row);
    }
    sendJson(res, 200, presented);
    return;
  }

  match = p.match(/^\/api\/workspaces\/([^/]+)\/tree$/);
  if (match && m === 'GET') {
    const wid = decodeURIComponent(match[1]);
    const ws = await store.getWorkspace(wid);
    if (!ws) { sendJson(res, 404, { error: 'workspace not found' }); return; }
    try {
      const abs = await resolveInWorkspace(ws.path, '.');
      const entries = await listWorkspaceTree(abs);
      sendJson(res, 200, { entries });
    } catch (err) {
      if (err.code === 'E_SANDBOX') { sendJson(res, 403, { error: 'E_SANDBOX' }); return; }
      throw err;
    }
    return;
  }

  match = p.match(/^\/api\/workspaces\/([^/]+)\/files$/);
  if (match && m === 'GET') {
    const wid = decodeURIComponent(match[1]);
    const ws = await store.getWorkspace(wid);
    if (!ws) { sendJson(res, 404, { error: 'workspace not found' }); return; }
    const rel = url.searchParams.get('path') || '';
    try {
      const abs = await resolveInWorkspace(ws.path, rel);
      const content = await fs.readFile(abs, 'utf8');
      sendJson(res, 200, { path: rel, content });
    } catch (err) {
      if (err.code === 'E_SANDBOX') { sendJson(res, 403, { error: 'E_SANDBOX' }); return; }
      if (err.code === 'ENOENT') { sendJson(res, 404, { error: 'not found' }); return; }
      throw err;
    }
    return;
  }
  if (match && m === 'PUT') {
    const wid = decodeURIComponent(match[1]);
    const ws = await store.getWorkspace(wid);
    if (!ws) { sendJson(res, 404, { error: 'workspace not found' }); return; }
    const body = await readBody(req);
    try {
      const abs = await resolveInWorkspace(ws.path, body.path);
      let before = '';
      try { before = await fs.readFile(abs, 'utf8'); } catch { before = ''; }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body.content ?? '', 'utf8');
      const { added, removed } = diffStats(before, body.content ?? '');
      sendJson(res, 200, { path: body.path, added, removed });
    } catch (err) {
      if (err.code === 'E_SANDBOX') { sendJson(res, 403, { error: 'E_SANDBOX' }); return; }
      throw err;
    }
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/agents$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    sendJson(res, 200, { agents: await kernelApi.listSubagents(conv) });
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/agents\/([^/]+)\/messages$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const aid = decodeURIComponent(match[2]);
    const result = await kernelApi.childMessages(cid, aid);
    sendJson(res, result.status, result.body);
    return;
  }
  if (match && m === 'POST') {
    const cid = decodeURIComponent(match[1]);
    const aid = decodeURIComponent(match[2]);
    const body = await readBody(req);
    const result = await kernelApi.sendToAgent(cid, aid, body.text);
    sendJson(res, result.status, result.body);
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/agents\/([^/]+)\/stop$/);
  if (match && m === 'POST') {
    const cid = decodeURIComponent(match[1]);
    const aid = decodeURIComponent(match[2]);
    const result = await kernelApi.stopAgent(cid, aid);
    sendJson(res, result.status, result.body);
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const live = await kernelApi.present(conv, { includeMessages: true });
    const messages = live.messages;
    const agents = [
      ...(await agentsFor(live, messages)),
      ...(await kernelApi.listSubagents(live)),
    ];
    const context = presentConversationContext(
      live.usage,
      await providerService.contextWindowFor(live),
    );
    sendJson(res, 200, {
      id: live.id,
      title: live.title,
      status: live.status,
      modelSourceId: live.modelSourceId || null,
      modelId: live.modelId || null,
      messages,
      agents,
      usage: context.usage,
      contextWindow: context.contextWindow,
      contextLabel: context.contextLabel,
      ...(live.llmError ? { llmError: live.llmError } : {}),
    });
    return;
  }
  if (match && m === 'PATCH') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const body = await readBody(req);
    const patched = await kernelApi.patchConversation(cid, body);
    sendJson(res, patched.status, patched.body);
    if (patched.status < 400) {
      v2.notifySidebarChanged();
      v2.notifyConversation(cid);
    }
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (match && m === 'POST') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const body = await readBody(req);
    const posted = await kernelApi.postMessage(conv, body.text || '');
    sendJson(res, posted.status, posted.body);
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/stop$/);
  if (match && m === 'POST') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const stopped = await kernelApi.stopConversation(cid);
    sendJson(res, stopped.status, stopped.body);
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/changes$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    try {
      sendJson(res, 200, await kernelApi.changes(cid));
    } catch (err) {
      if (err.code === 'E_SANDBOX') { sendJson(res, 403, { error: 'E_SANDBOX' }); return; }
      throw err;
    }
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/diff$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const filePath = url.searchParams.get('path') || '';
    try {
      const result = await kernelApi.diff(cid, filePath);
      sendJson(res, result.status, result.body);
    } catch (err) {
      if (err.code === 'E_SANDBOX') { sendJson(res, 403, { error: 'E_SANDBOX' }); return; }
      throw err;
    }
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/events$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    v2.trackConnection(req);
    await kernelApi.streamEvents(req, res, cid, { headers: SECURITY_HEADERS });
    return;
  }

  if (p === '/api/sources' || p === '/api/sources/test' || /^\/api\/sources\/[^/]+$/.test(p)) {
    if (await handleSources(req, res, p, m)) return;
  }

  if (p === '/api/settings' && m === 'GET') {
    sendJson(res, 200, await settingsResponse(await ensureSettings()));
    return;
  }
  if (p === '/api/settings' && m === 'PUT') {
    const body = await readBody(req) || {};
    await ensureSettings();
    const patch = { ...body };
    delete patch.sources;
    delete patch.version;
    delete patch.grok;
    delete patch.provider;
    delete patch.baseUrl;
    delete patch.apiKey;
    delete patch.hasApiKey;
    delete patch.gitConnections;
    delete patch.models;
    delete patch.providers;
    delete patch.defaultModel;
    const saved = await store.putSettings(patch);
    sendJson(res, 200, await settingsResponse(saved));
    return;
  }

  if (p === '/api/about' && m === 'GET') {
    let pkg = { name: 'weft', version: '0.0.0', description: '' };
    try {
      pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    } catch { /* ignore */ }
    sendJson(res, 200, { name: pkg.name, version: pkg.version, description: pkg.description || '' });
    return;
  }

  if (p === '/api/plugins' && m === 'GET') {
    const s = await store.getSettings();
    sendJson(res, 200, await describePlugins(PLUGIN_DIRS, s.plugins || {}));
    return;
  }
  if (p === '/api/plugins' && m === 'POST') {
    const body = await readBody(req);
    try {
      const s = await store.getSettings();
      const current = await describePlugins(PLUGIN_DIRS, s.plugins || {});
      const existingToolNames = new Set(BUILTIN_TOOLS);
      for (const plugin of current) {
        if (plugin.enabled && plugin.loaded) {
          for (const tool of plugin.tools || []) existingToolNames.add(tool.name);
        }
      }
      const installed = await installPlugin(body?.path, USER_PLUGINS, {
        existingIds: new Set(current.map((plugin) => plugin.id)),
        existingToolNames,
        baseDir: ROOT,
      });
      await store.putSettings({ plugins: { [installed.id]: true } });
      await reloadKernelPlugins();
      v2.notifyExtensionsChanged();
      sendJson(res, 201, installed);
    } catch (err) {
      sendCatalogError(res, err);
    }
    return;
  }
  match = p.match(/^\/api\/plugins\/([^/]+)$/);
  if (match && m === 'PUT') {
    const id = decodeURIComponent(match[1]);
    if (!PLUGIN_ID.test(id)) {
      sendJson(res, 400, { error: 'invalid plugin id', code: 'err_plugin_invalid' });
      return;
    }
    const body = await readBody(req);
    const s = await store.getSettings();
    const current = await describePlugins(PLUGIN_DIRS, s.plugins || {});
    if (!current.some((plugin) => plugin.id === id)) {
      sendJson(res, 404, { error: 'plugin not found', code: 'err_plugin_not_found' });
      return;
    }
    const enabled = body?.enabled !== false;
    await store.putSettings({ plugins: { [id]: enabled } });
    await reloadKernelPlugins();
    const next = await describePlugins(PLUGIN_DIRS, (await store.getSettings()).plugins || {});
    v2.notifyExtensionsChanged();
    sendJson(res, 200, next.find((plugin) => plugin.id === id) || { id, enabled });
    return;
  }

  if (p === '/api/skills' && m === 'GET') {
    const s = await store.getSettings();
    sendJson(res, 200, await listSkills(SKILL_DIRS, s.skills || {}, USER_SKILLS));
    return;
  }
  if (p === '/api/skills' && m === 'POST') {
    const body = await readBody(req);
    try {
      const existing = await listSkillRecords(SKILL_DIRS);
      const created = await createSkill(USER_SKILLS, body || {}, new Set(existing.map((skill) => skill.id)));
      await store.putSettings({ skills: { [created.id]: true } });
      const list = await listSkills(SKILL_DIRS, (await store.getSettings()).skills || {}, USER_SKILLS);
      v2.notifyExtensionsChanged();
      sendJson(res, 201, list.find((skill) => skill.id === created.id));
    } catch (err) {
      sendCatalogError(res, err);
    }
    return;
  }
  match = p.match(/^\/api\/skills\/([^/]+)$/);
  if (match && m === 'DELETE') {
    const id = decodeURIComponent(match[1]);
    try {
      await deleteSkill(SKILL_DIRS, USER_SKILLS, id);
      v2.notifyExtensionsChanged();
      sendJson(res, 200, { ok: true, id });
    } catch (err) {
      sendCatalogError(res, err);
    }
    return;
  }
  if (match && (m === 'PUT' || m === 'PATCH')) {
    const id = decodeURIComponent(match[1]);
    if (!SKILL_ID.test(id)) {
      sendJson(res, 400, { error: 'invalid skill id', code: 'err_skill_invalid' });
      return;
    }
    const body = await readBody(req);
    try {
      const hasContent = body?.name != null || body?.description != null || body?.body != null;
      if (hasContent) await updateSkill(SKILL_DIRS, USER_SKILLS, id, body || {});
      if (body?.enabled != null || !hasContent) {
        const records = await listSkillRecords(SKILL_DIRS);
        if (!records.some((skill) => skill.id === id)) {
          sendJson(res, 404, { error: 'skill not found', code: 'err_skill_not_found' });
          return;
        }
        if (body?.enabled != null) {
          await store.putSettings({ skills: { [id]: body.enabled !== false } });
        }
      }
      const list = await listSkills(SKILL_DIRS, (await store.getSettings()).skills || {}, USER_SKILLS);
      const skill = list.find((item) => item.id === id);
      if (!skill) {
        sendJson(res, 404, { error: 'skill not found', code: 'err_skill_not_found' });
        return;
      }
      v2.notifyExtensionsChanged();
      sendJson(res, 200, skill);
    } catch (err) {
      sendCatalogError(res, err);
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  try {
    v2.writeDiscoveryFile(port);
  } catch (err) {
    console.error(`WEFT_ERROR discovery write failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  v2.startIdleExit();
  const hostWarning = unauthenticatedHostsWarning();
  if (hostWarning) console.warn(hostWarning);
  const loginUrl = v2.issueStartupLoginUrl(port);
  process.stdout.write(`WEFT_READY http://127.0.0.1:${port}\n打开新版界面：${loginUrl}\n`);
});
