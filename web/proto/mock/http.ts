import type { MockHub } from './hub';
import {
  getConv,
  nextId,
  publishChange,
  publishConversationView,
  publishExtensions,
  publishProviders,
  publishRemove,
  publishSummary,
  publishWorkspaces,
  recomputeContext,
  touch,
} from './db';
import { continueConversation, sendMessage, stopConversation } from './run';
import { parseSendImages } from '../../../src/v2/views/message-images';
import { replyInSubThread, stopSubThread, subagentKey } from './subagents';
import { branchesOf, tokenFails } from './extensions';
import {
  EXTERNAL_TOUCH_MS,
  createRepo,
  readRepoFile,
  repoTree,
  saveRepoFile,
  textDiff,
  touchRepoFile,
} from './repo';
import {
  conversationValue,
  itemValue,
  summaryOf,
  toolValue,
} from './views';
import type {
  ConversationSummary,
  EntityValue,
  GitConnection,
  GitTestResult,
  GrokPending,
  GrokSession,
  Lang,
  MockConv,
  MockDb,
  Plugin,
  Provider,
  ResolvedModel,
  Skill,
  ThreadItem,
  MockSubThread,
  ToolCall,
  Workspace,
  WorkspaceDirEntry,
  WorkspaceDirs,
} from './types';

export type MockReply = {
  status: number;
  body?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
};

const SERVICE_VERSION = '0.1.0-prototype';
const STARTED_AT = Date.now();
const WORK_ROOT = 'D:\\work';
const GROK_VERIFY_URI = 'https://grok.com/device';

function ok(body: unknown): MockReply {
  return { status: 200, body };
}

function created(body: unknown): MockReply {
  return { status: 201, body };
}

function accepted(body: unknown): MockReply {
  return { status: 202, body };
}

function fail(status: number, error: string, code?: string, extra?: Record<string, unknown>): MockReply {
  return { status, body: { error, code, ...extra } };
}

function valueOf<T>(value: EntityValue, lang: Lang): T {
  return (typeof value === 'function' ? value(lang) : value) as T;
}

function langOf(url: URL): Lang {
  return url.searchParams.get('lang') === 'en' ? 'en' : 'zh';
}

function readBody(init?: RequestInit): Record<string, unknown> {
  const raw = init?.body;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function modelLabel(db: MockDb, model: ResolvedModel | null): string {
  if (!model) return '';
  const provider = db.providers.find((row) => row.id === model.providerId);
  const found = provider?.models.find((row) => row.id === model.modelId);
  return found?.displayName || model.modelId;
}

const MODEL_NAMES: Record<string, { name: string; brand: string | null; window: number }> = {
  'grok-4.6': { name: 'Grok 4.6', brand: 'Grok', window: 200_000 },
  'grok-4': { name: 'Grok 4', brand: 'Grok', window: 128_000 },
  'grok-code-fast': { name: 'Grok Code Fast', brand: 'Grok', window: 256_000 },
  'grok-build': { name: 'Grok Build', brand: 'Grok', window: 256_000 },
  'gpt-5': { name: 'GPT-5', brand: 'OpenAI', window: 400_000 },
  'gpt-5-mini': { name: 'GPT-5 mini', brand: 'OpenAI', window: 200_000 },
  'gpt-4.1': { name: 'GPT-4.1', brand: 'OpenAI', window: 128_000 },
  'claude-sonnet-4-5': { name: 'Claude Sonnet', brand: 'Claude', window: 200_000 },
  'claude-opus-4-1': { name: 'Claude Opus', brand: 'Claude', window: 200_000 },
  'anthropic/claude-sonnet': { name: 'Claude Sonnet', brand: 'Claude', window: 200_000 },
  'anthropic/claude-haiku': { name: 'Claude Haiku', brand: 'Claude', window: 200_000 },
  'openai/gpt-5': { name: 'GPT', brand: 'OpenAI', window: 400_000 },
  'google/gemini-pro': { name: 'Gemini Pro', brand: 'Gemini', window: 1_000_000 },
  'deepseek/deepseek-chat': { name: 'DeepSeek Chat', brand: 'DeepSeek', window: 128_000 },
  'qwen/qwen-coder': { name: '通义千问 Coder', brand: 'Qwen', window: 256_000 },
  'meta-llama/llama-3': { name: 'Llama', brand: 'Meta', window: 128_000 },
  'mistralai/mistral-large': { name: 'Mistral Large', brand: 'Mistral', window: 128_000 },
  'x-ai/grok-4': { name: 'Grok', brand: 'Grok', window: 256_000 },
  'deepseek-chat': { name: 'DeepSeek Chat', brand: 'DeepSeek', window: 128_000 },
  'local-model': { name: 'Local Model', brand: null, window: 32_000 },
};

function mockModelSupportsImages(modelId: string): boolean {
  return !/code-fast|coder|local-model|deepseek-chat/i.test(modelId);
}

function modelRows(ids: string[], fallbackBrand: string | null): Provider['models'] {
  const seen = new Set<string>();
  const out: Provider['models'] = [];
  for (const id of ids) {
    const modelId = String(id || '').trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const meta = MODEL_NAMES[modelId];
    out.push({
      id: modelId,
      displayName: meta?.name || modelId,
      brand: meta?.brand || fallbackBrand,
      contextWindow: meta?.window || 128_000,
      contextWindowCustom: false,
      images: mockModelSupportsImages(modelId),
    });
  }
  return out;
}

function maskKey(key: string): string {
  const text = key.trim();
  if (!text) return '';
  const tail = text.slice(-4);
  return `${text.slice(0, 3)}…${tail}`;
}

function probeModels(vendor: string, modelIds?: string[]): string[] {
  if (modelIds?.length) return modelIds;
  if (vendor === 'xai' || vendor === 'grok') return ['grok-4.6', 'grok-4', 'grok-code-fast'];
  if (vendor === 'openai') return ['gpt-5', 'gpt-5-mini', 'gpt-4.1'];
  if (vendor === 'anthropic') return ['claude-sonnet-4-5', 'claude-opus-4-1'];
  if (vendor === 'deepseek') return ['deepseek-chat'];
  if (vendor === 'openrouter') {
    return [
      'anthropic/claude-sonnet',
      'anthropic/claude-haiku',
      'openai/gpt-5',
      'google/gemini-pro',
      'deepseek/deepseek-chat',
      'qwen/qwen-coder',
      'meta-llama/llama-3',
      'mistralai/mistral-large',
      'x-ai/grok-4',
    ];
  }
  return ['local-model', 'gpt-4o-mini'];
}

function probeFailure(lang: Lang, reason: string): { status: 'error'; statusText: string } {
  return {
    status: 'error',
    statusText: lang === 'en'
      ? `Connection failed: ${reason} (prototype: keys starting with "bad" always fail)`
      : `${reason}（原型：Key 以 bad 开头时固定失败）`,
  };
}

function conversationSnapshot(conv: MockConv, lang: Lang): unknown {
  return {
    conversation: valueOf(conversationValue(conv), lang),
    items: conv.items.map((item) => valueOf<ThreadItem>(itemValue(item), lang)),
    tools: Object.values(conv.tools).map((tool) => {
      const group = conv.items.find((item) => item.kind === 'tool_group' && item.toolIds.includes(tool.id));
      const groupId = group && group.kind === 'tool_group' ? group.id : `group:${tool.id}`;
      return valueOf<ToolCall>(toolValue(tool, groupId), lang);
    }),
  };
}

function subagentSnapshot(thread: MockSubThread, lang: Lang): unknown {
  const groupIdOf = (toolId: string): string => {
    for (const item of thread.items) {
      if (item.kind === 'tool_group' && item.toolIds.includes(toolId)) return item.id;
    }
    return `group:${toolId}`;
  };
  return {
    subagent: thread.view,
    items: thread.items.map((item) => valueOf<ThreadItem>(itemValue(item), lang)),
    tools: Object.values(thread.tools).map((tool) => valueOf<ToolCall>(toolValue(tool, groupIdOf(tool.id)), lang)),
  };
}

function providerView(provider: Provider): Provider {
  return { ...provider, models: provider.models.map((model) => ({ ...model })) };
}

function publishProviderGone(hub: MockHub, id: string): void {
  hub.publish('providers', { event: 'remove', entity: 'provider', id });
}

function defaultWindowOf(db: MockDb, providerId: string, modelId: string): number | undefined {
  return db.defaultWindows.get(`${providerId}:${modelId}`);
}

function removeWorkspace(db: MockDb, hub: MockHub, workspaceId: string): MockReply {
  const ws = db.workspaces.find((row) => row.id === workspaceId);
  if (!ws) return fail(404, '工作区不存在');
  const rows = [...db.conversations.values()].filter((conv) => conv.view.workspaceId === workspaceId);
  if (rows.some((conv) => conv.view.status === 'running')) {
    return fail(409, '工作区里还有运行中的对话', 'E_WS_BUSY');
  }
  for (const conv of rows) {
    db.conversations.delete(conv.view.id);
    publishRemove(conv, hub, 'conversation', conv.view.id);
    hub.publish('workspaces', {
      event: 'remove',
      entity: 'conversation_summary',
      id: conv.view.id,
    });
  }
  db.workspaces = db.workspaces.filter((row) => row.id !== workspaceId);
  db.repos.delete(workspaceId);
  hub.publish('workspaces', { event: 'remove', entity: 'workspace', id: workspaceId });
  publishWorkspaces(db, hub);
  return ok({ removed: true });
}

function createConversation(db: MockDb, hub: MockHub, workspaceId: string, title: string): MockReply {
  const ws = db.workspaces.find((row) => row.id === workspaceId);
  if (!ws) return fail(404, '工作区不存在');
  const id = nextId(db, 'c');
  const model = db.defaultModel;
  const provider = db.providers.find((row) => row.id === model?.providerId);
  const found = provider?.models.find((row) => row.id === model?.modelId);
  const window = found?.contextWindow || 200_000;
  const conv: MockConv = {
    view: {
      id,
      workspaceId,
      title: title || '新对话',
      updatedAt: Date.now(),
      status: 'idle',
      model: model && found
        ? { sourceId: model.providerId, modelId: model.modelId, label: modelLabel(db, model) }
        : null,
      run: {
        status: 'idle',
        startedAt: null,
        pendingText: null,
        canSend: true,
        canStop: false,
        lockedReason: null,
        error: null,
      },
      context: { used: 0, window, percent: 0, level: 'ok' },
      itemIds: [],
      sends: [],
    },
    pending: null,
    items: [],
    tools: {},
    changes: [],
    diffs: {},
    subagents: [],
    run: null,
    requestRuns: new Map(),
  };
  db.conversations.set(id, conv);
  publishSummary(db, hub, id);
  return created(summaryOf(conv) as ConversationSummary);
}

function patchConversation(
  db: MockDb,
  hub: MockHub,
  conv: MockConv,
  body: Record<string, unknown>,
): MockReply {
  const raw = body.model;
  if (raw === null) {
    conv.view.model = null;
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    const providerId = typeof row.providerId === 'string' ? row.providerId : '';
    const modelId = typeof row.modelId === 'string' ? row.modelId : '';
    if (!providerId || !modelId) return fail(400, 'model 需要 providerId 和 modelId', 'E_BAD_REQUEST');
    conv.view.model = {
      sourceId: providerId,
      modelId,
      label: modelLabel(db, { providerId, modelId }),
    };
  }
  recomputeContext(db, conv);
  touch(conv);
  publishConversationView(conv, hub);
  return ok(valueOf(conversationValue(conv), 'zh'));
}

function setContextWindow(
  db: MockDb,
  hub: MockHub,
  providerId: string,
  modelId: string,
  window: number | null,
): MockReply {
  const provider = db.providers.find((row) => row.id === providerId);
  const model = provider?.models.find((row) => row.id === modelId);
  if (!provider || !model) return fail(404, 'Provider 或模型不存在');
  if (window == null) {
    model.contextWindow = defaultWindowOf(db, providerId, modelId) || model.contextWindow;
    model.contextWindowCustom = false;
  } else {
    if (!Number.isInteger(window) || window < 1000 || window > 10_000_000) {
      return fail(400, '上下文上限超出范围', 'E_BAD_REQUEST');
    }
    model.contextWindow = window;
    model.contextWindowCustom = true;
  }
  publishProviders(db, hub);
  for (const conv of db.conversations.values()) {
    if (conv.view.model?.sourceId !== providerId || conv.view.model.modelId !== modelId) continue;
    recomputeContext(db, conv);
    publishConversationView(conv, hub);
  }
  return ok(providerView(provider));
}

function createProvider(db: MockDb, hub: MockHub, body: Record<string, unknown>): MockReply {
  const vendor = str(body.vendor) || 'custom';
  const baseUrl = str(body.baseUrl) || (vendor === 'xai' ? 'https://api.x.ai/v1' : '');
  const apiKey = str(body.apiKey);
  const name = str(body.name) || (db.vendors.find((row) => row.id === vendor)?.name ?? vendor);
  const access = vendor === 'custom' ? 'custom_endpoint' : 'api_key';
  const models = modelRows(
    Array.isArray(body.models) ? body.models.map((item) => String(item)) : probeModels(vendor).slice(0, 2),
    db.vendors.find((row) => row.id === vendor)?.brand ?? null,
  );
  const provider: Provider = {
    id: nextId(db, 'p'),
    vendor,
    name,
    access,
    runtime: 'model',
    baseUrl,
    keyMasked: apiKey ? maskKey(apiKey) : null,
    hasKey: Boolean(apiKey),
    status: apiKey || access === 'custom_endpoint' ? 'ok' : 'untested',
    statusText: '',
    lastTestedAt: Date.now(),
    models,
    isDefault: false,
  };
  db.providers.push(provider);
  for (const model of provider.models) {
    db.defaultWindows.set(`${provider.id}:${model.id}`, model.contextWindow);
  }
  if (!db.defaultModel && provider.models[0]) {
    db.defaultModel = { providerId: provider.id, modelId: provider.models[0].id };
  }
  for (const row of db.providers) row.isDefault = db.defaultModel?.providerId === row.id;
  publishProviders(db, hub);
  return created(providerView(provider));
}

function patchProvider(db: MockDb, hub: MockHub, provider: Provider, body: Record<string, unknown>): MockReply {
  if (typeof body.name === 'string' && body.name.trim()) provider.name = body.name.trim();
  if (typeof body.baseUrl === 'string') provider.baseUrl = body.baseUrl;
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    provider.keyMasked = maskKey(body.apiKey);
    provider.hasKey = true;
    provider.status = 'ok';
    provider.statusText = '';
    provider.lastTestedAt = Date.now();
  }
  if (Array.isArray(body.models)) {
    const ids = body.models.map((item) => String(item));
    const existing = new Map(provider.models.map((model) => [model.id, model]));
    provider.models = modelRows(ids, provider.vendor).map((model) => {
      const old = existing.get(model.id);
      return old
        ? { ...model, contextWindow: old.contextWindow, contextWindowCustom: old.contextWindowCustom }
        : model;
    });
    for (const model of provider.models) {
      if (!db.defaultWindows.has(`${provider.id}:${model.id}`)) {
        db.defaultWindows.set(`${provider.id}:${model.id}`, model.contextWindow);
      }
    }
  }
  if (body.defaultModel === null) {
    if (db.defaultModel?.providerId === provider.id) db.defaultModel = null;
  } else if (typeof body.defaultModel === 'string' && body.defaultModel) {
    db.defaultModel = { providerId: provider.id, modelId: body.defaultModel };
  }
  for (const row of db.providers) row.isDefault = db.defaultModel?.providerId === row.id;
  publishProviders(db, hub);
  return ok(providerView(provider));
}

function grokSession(db: MockDb): GrokSession {
  const signedIn = db.grok.signedIn;
  return {
    signedIn,
    account: signedIn ? db.grok.account : null,
    email: signedIn ? 'demo@weft.local' : null,
    expiresAt: signedIn ? STARTED_AT + 86_400_000 : null,
    authMode: signedIn ? 'oidc' : null,
    source: signedIn ? 'prototype' : null,
    pending: db.grok.pending,
  };
}

function ensureGrokProvider(db: MockDb, hub: MockHub): Provider {
  const found = db.providers.find((row) => row.id === 'grok');
  if (found) return found;
  const provider: Provider = {
    id: 'grok',
    vendor: 'xai',
    name: 'Grok Build',
    access: 'account',
    runtime: 'model',
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    keyMasked: null,
    hasKey: true,
    status: 'ok',
    statusText: '',
    lastTestedAt: null,
    models: modelRows(['grok-build'], 'grok'),
    isDefault: false,
  };
  db.providers.push(provider);
  for (const model of provider.models) {
    db.defaultWindows.set(`${provider.id}:${model.id}`, model.contextWindow);
  }
  publishProviders(db, hub);
  return provider;
}

function startGrokLogin(db: MockDb): GrokPending {
  const pending: GrokPending = {
    loginId: nextId(db, 'login'),
    verificationUri: GROK_VERIFY_URI,
    userCode: 'WEFT-DEMO',
    interval: 2,
    expiresAt: Date.now() + 10 * 60_000,
  };
  db.grok.pending = pending;
  db.grokPolls.set(pending.loginId, 0);
  return pending;
}

function pollGrokLogin(db: MockDb, hub: MockHub, loginId: string): MockReply {
  const pending = db.grok.pending;
  if (!pending || pending.loginId !== loginId) return fail(404, 'no_login');
  const count = (db.grokPolls.get(loginId) || 0) + 1;
  db.grokPolls.set(loginId, count);
  if (count < 2) {
    return ok({ status: 'pending', interval: 1, expiresAt: pending.expiresAt });
  }
  db.grok.signedIn = true;
  db.grok.account = 'demo@weft.local';
  db.grok.pending = null;
  db.grokPolls.delete(loginId);
  ensureGrokProvider(db, hub);
  return ok({ status: 'done', grok: grokSession(db) });
}

/* ---------- workspace directory browser ---------- */

type MockDir = { entries: WorkspaceDirEntry[]; git: boolean };

const DIRS: Record<string, MockDir> = {
  [WORK_ROOT]: {
    git: false,
    entries: [
      { name: 'weft', path: `${WORK_ROOT}\\weft`, git: true },
      { name: 'website', path: `${WORK_ROOT}\\website`, git: true },
      { name: 'sandbox', path: `${WORK_ROOT}\\sandbox`, git: false },
      { name: 'archive', path: `${WORK_ROOT}\\archive`, git: false },
    ],
  },
  [`${WORK_ROOT}\\weft`]: { git: true, entries: [] },
  [`${WORK_ROOT}\\website`]: { git: true, entries: [] },
  [`${WORK_ROOT}\\sandbox`]: {
    git: false,
    entries: [
      { name: 'playground', path: `${WORK_ROOT}\\sandbox\\playground`, git: false },
      { name: 'notes', path: `${WORK_ROOT}\\sandbox\\notes`, git: false },
    ],
  },
  [`${WORK_ROOT}\\sandbox\\playground`]: { git: false, entries: [] },
  [`${WORK_ROOT}\\sandbox\\notes`]: { git: false, entries: [] },
  [`${WORK_ROOT}\\archive`]: {
    git: false,
    entries: [{ name: 'old-site', path: `${WORK_ROOT}\\archive\\old-site`, git: false }],
  },
  [`${WORK_ROOT}\\archive\\old-site`]: { git: false, entries: [] },
};

function normalizeDir(raw: string): string {
  const text = String(raw || '').trim().replaceAll('/', '\\').replace(/\\+$/, '');
  return text || WORK_ROOT;
}

function parentDir(path: string): string | null {
  if (path.toLowerCase() === WORK_ROOT.toLowerCase()) return null;
  const at = path.lastIndexOf('\\');
  return at <= 0 ? null : path.slice(0, at);
}

function dirsView(path: string, lang: Lang): MockReply {
  const normalized = normalizeDir(path);
  const hit = DIRS[normalized];
  if (!hit) {
    return fail(404, lang === 'en' ? 'Directory not found in the prototype' : '原型里没有这个目录', 'E_PATH');
  }
  const view: WorkspaceDirs = {
    root: WORK_ROOT,
    path: normalized,
    parent: parentDir(normalized),
    selectable: normalized.toLowerCase() !== WORK_ROOT.toLowerCase(),
    git: hit.git,
    entries: hit.entries.map((entry) => ({ ...entry })),
    truncated: false,
  };
  return ok(view);
}

/* ---------- workspaces ---------- */

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function workspaceRepo(name: string) {
  return createRepo([
    {
      path: 'README.md',
      text: [`# ${name}`, '', '这是原型里新建的工作区，文件树和保存都在模拟后端里。', ''].join('\n'),
    },
  ]);
}

function createWorkspace(db: MockDb, hub: MockHub, body: Record<string, unknown>, lang: Lang): MockReply {
  const name = str(body.name).trim();
  if (!name) return fail(400, lang === 'en' ? 'name required' : '需要名字', 'E_BAD_REQUEST');
  const source = body.source === 'git' ? 'git' : 'local';
  let wsPath = normalizeDir(str(body.path) || `${WORK_ROOT}\\${name}`);
  if (!wsPath.toLowerCase().startsWith(WORK_ROOT.toLowerCase())) {
    return fail(400, lang === 'en' ? 'Path is outside the allowed root' : `目录不在允许的根目录 ${WORK_ROOT} 下`, 'E_PATH');
  }
  if (db.workspaces.some((row) => row.path.toLowerCase() === wsPath.toLowerCase())) {
    return fail(409, lang === 'en' ? 'A workspace already uses this path' : '这个目录已经是工作区了', 'E_WS_EXISTS');
  }
  let gitUrl: string | null = null;
  let branch: string | null = null;
  if (source === 'git') {
    const connectionId = str(body.connectionId);
    const projectId = body.projectId == null ? '' : String(body.projectId);
    const picked = connectionId && projectId
      ? (db.gitProjects[connectionId] || []).find((row) => String(row.id) === projectId)
      : null;
    if (connectionId && projectId && !picked) {
      return fail(404, lang === 'en' ? 'Project not found' : '找不到这个 GitLab 项目');
    }
    gitUrl = picked?.httpUrl || str(body.gitUrl);
    if (!gitUrl) return fail(400, lang === 'en' ? 'gitUrl required' : '需要仓库地址', 'E_BAD_REQUEST');
    branch = str(body.branch) || picked?.defaultBranch || 'main';
    wsPath = normalizeDir(str(body.path) || `${WORK_ROOT}\\${baseName(picked?.path || gitUrl) || name}`);
  }
  const ws: Workspace = {
    id: nextId(db, 'ws'),
    name,
    path: wsPath,
    source,
    gitUrl,
    branch,
    git: source === 'git'
      ? {
        branch: branch || 'main',
        detached: false,
        changedFiles: 0,
        insertions: 0,
        deletions: 0,
        ahead: 0,
        behind: 0,
      }
      : null,
    conversationCount: 0,
    runningCount: 0,
  };
  db.workspaces.push(ws);
  db.repos.set(ws.id, workspaceRepo(name));
  publishWorkspaces(db, hub);
  return created(ws);
}

/* ---------- extensions ---------- */

function installPlugin(db: MockDb, hub: MockHub, body: Record<string, unknown>, lang: Lang): MockReply {
  const path = str(body.path).trim();
  if (!path) {
    return fail(400, lang === 'en' ? 'Plugin directory required' : '需要插件目录', 'err_plugin_path_required');
  }
  if (/bad/i.test(path)) {
    return fail(
      400,
      lang === 'en'
        ? 'Plugin main file failed to load (prototype: paths containing "bad" always fail)'
        : '插件主文件加载失败：main 必须是插件目录内的相对 .mjs 路径（原型：路径里含 bad 时固定失败）',
      'err_plugin_main_missing',
    );
  }
  if (db.plugins.some((row) => row.id === baseName(path).toLowerCase())) {
    return fail(409, lang === 'en' ? 'Plugin already installed' : '这个插件已经装过了', 'err_plugin_exists');
  }
  const id = baseName(path).toLowerCase().replace(/[^a-z0-9_-]/g, '-') || nextId(db, 'plugin');
  const plugin: Plugin = {
    id,
    name: baseName(path),
    description: lang === 'en' ? 'Imported from a local directory (prototype)' : '从本机目录导入（原型）',
    version: '0.1.0',
    source: 'local',
    enabled: true,
    loaded: true,
    error: null,
    errorCode: null,
    tools: [{ name: `${id.replace(/[^a-z0-9_]/g, '_')}_tool`, description: '原型插件工具' }],
  };
  db.plugins.push(plugin);
  publishExtensions(db, hub);
  return created(plugin);
}

function saveSkill(db: MockDb, hub: MockHub, body: Record<string, unknown>, id: string | null, lang: Lang): MockReply {
  if (id) {
    const skill = db.skills.find((row) => row.id === id);
    if (!skill) return fail(404, lang === 'en' ? 'Skill not found' : '技能不存在');
    if (!skill.deletable) return fail(400, lang === 'en' ? 'Built-in skills are read-only' : '内置技能不能改', 'err_skill_builtin');
    if (typeof body.name === 'string' && body.name.trim()) skill.name = body.name.trim();
    if (typeof body.description === 'string') skill.description = body.description;
    if (typeof body.enabled === 'boolean') skill.enabled = body.enabled;
    publishExtensions(db, hub);
    return ok(skill);
  }
  const name = str(body.name).trim();
  if (!name) return fail(400, lang === 'en' ? 'Skill name required' : '技能需要名字', 'err_skill_name_required');
  const slug = (str(body.id).trim() || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\u4e00-\u9fa5_-]/g, '')) || nextId(db, 'skill');
  if (db.skills.some((row) => row.id === slug)) {
    return fail(409, lang === 'en' ? 'Skill id already exists' : '技能 id 已存在', 'err_skill_exists');
  }
  const skill: Skill = {
    id: slug,
    name,
    description: str(body.description),
    version: '0.1.0',
    source: 'user',
    enabled: true,
    deletable: true,
  };
  db.skills.push(skill);
  publishExtensions(db, hub);
  return created(skill);
}

function gitStatusText(lang: Lang, ok: boolean, code: string): string {
  if (ok) return lang === 'en' ? 'Connected' : '连接成功';
  if (code === 'name') return lang === 'en' ? 'Connection name required' : '需要连接名字';
  if (code === 'url') return lang === 'en' ? 'Base URL required' : '需要服务器地址';
  if (code === 'auth_failed') return lang === 'en' ? 'Token rejected by GitLab' : '令牌被 GitLab 拒绝（原型：令牌以 bad 开头时固定失败）';
  return lang === 'en' ? 'Connection failed' : '连接失败';
}

function gitFormOf(body: Record<string, unknown>, existing?: GitConnection): {
  name: string;
  kind: GitConnection['kind'];
  baseUrl: string;
  token: string;
  allowHttp: boolean;
  caFile: string;
} {
  const kindRaw = str(body.kind);
  const kind: GitConnection['kind'] = kindRaw === 'gitlab-com' || kindRaw === 'other' ? kindRaw : 'gitlab-self';
  return {
    name: typeof body.name === 'string' ? body.name.trim() : (existing?.name || ''),
    kind,
    baseUrl: (typeof body.baseUrl === 'string' ? body.baseUrl : (existing?.baseUrl || '')).trim(),
    token: str(body.token),
    allowHttp: body.allowHttp === true,
    caFile: typeof body.caFile === 'string' ? body.caFile.trim() : (existing?.caFile || ''),
  };
}

function testGit(lang: Lang, form: { name: string; baseUrl: string; token: string }): MockReply {
  if (!form.name) {
    return ok({ ok: false, username: '', code: 'name', statusText: gitStatusText(lang, false, 'name') } satisfies GitTestResult);
  }
  if (!form.baseUrl) {
    return ok({ ok: false, username: '', code: 'url', statusText: gitStatusText(lang, false, 'url') } satisfies GitTestResult);
  }
  if (tokenFails(form.token)) {
    return ok({ ok: false, username: '', code: 'auth_failed', statusText: gitStatusText(lang, false, 'auth_failed') } satisfies GitTestResult);
  }
  return ok({
    ok: true,
    username: 'lawrence',
    code: '',
    statusText: gitStatusText(lang, true, ''),
  } satisfies GitTestResult);
}

function saveGitConnection(
  db: MockDb,
  hub: MockHub,
  body: Record<string, unknown>,
  id: string | null,
  lang: Lang,
): MockReply {
  const existing = id ? db.gitConnections.find((row) => row.id === id) : undefined;
  if (id && !existing) return fail(404, lang === 'en' ? 'Connection not found' : '连接不存在');
  const form = gitFormOf(body, existing || undefined);
  if (!form.name) return fail(400, gitStatusText(lang, false, 'name'), 'git_err_name');
  if (!form.baseUrl) return fail(400, gitStatusText(lang, false, 'url'), 'git_err_url');
  const bad = tokenFails(form.token);
  const lastTest: GitConnection['lastTest'] = bad
    ? {
      ok: false,
      username: '',
      error: 'auth_failed',
      errorText: gitStatusText(lang, false, 'auth_failed'),
      at: new Date().toISOString(),
    }
    : existing?.lastTest || null;
  const conn: GitConnection = existing || {
    id: nextId(db, 'gl'),
    name: '',
    kind: 'gitlab-self',
    baseUrl: '',
    token: '',
    hasToken: false,
    allowHttp: false,
    caFile: '',
    lastTest: null,
  };
  conn.name = form.name;
  conn.kind = form.kind;
  conn.baseUrl = form.baseUrl;
  conn.allowHttp = form.allowHttp;
  conn.caFile = form.caFile;
  if (form.token) {
    conn.token = `glpat-…${form.token.slice(-4)}`;
    conn.hasToken = true;
  }
  conn.lastTest = lastTest;
  if (!existing) {
    db.gitConnections.push(conn);
    db.gitProjects[conn.id] = [
      {
        id: 1,
        path: `${form.name.toLowerCase().replace(/\s+/g, '-')}/demo-project`,
        description: lang === 'en' ? 'Demo project created by the prototype' : '原型里为这个连接生成的项目',
        defaultBranch: 'main',
        lastActivityAt: new Date().toISOString(),
        httpUrl: `${form.baseUrl.replace(/\/+$/, '')}/demo-project.git`,
      },
    ];
  }
  publishExtensions(db, hub);
  return existing ? ok(conn) : created(conn);
}

/* ---------- routing ---------- */

/** Route one mock HTTP call. Unknown `/api` paths answer 404 so the UI can show a message. */
export function handleMockRequest(db: MockDb, hub: MockHub, rawUrl: string, init?: RequestInit): MockReply {
  let url: URL;
  try {
    url = new URL(rawUrl, 'file:///');
  } catch {
    return fail(400, 'bad url');
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = String(init?.method || 'GET').toUpperCase();
  const body = readBody(init);
  const lang = langOf(url);

  if (path === '/api/settings') {
    if (method === 'PUT') return ok({ ok: true });
    return ok({});
  }

  if (path === '/api/v2/service') {
    return ok({
      protocolVersion: '2.0.0',
      serviceVersion: SERVICE_VERSION,
      pid: 4242,
      startedAt: STARTED_AT,
      demo: false,
    });
  }

  /* ---- providers ---- */
  if (path === '/api/v2/providers' && method === 'GET') {
    return ok({
      providers: db.providers.map((provider) => providerView(provider)),
      vendors: db.vendors,
      defaultModel: db.defaultModel,
    });
  }
  if (path === '/api/v2/providers' && method === 'POST') {
    return createProvider(db, hub, body);
  }
  if (path === '/api/v2/providers/test' && method === 'POST') {
    const vendor = str(body.vendor) || 'custom';
    const key = str(body.apiKey);
    const baseUrl = str(body.baseUrl);
    if (tokenFails(key) || /bad/i.test(baseUrl)) {
      return ok({ ok: false, models: [], ...probeFailure(lang, lang === 'en' ? '401 Unauthorized' : '401 未授权') });
    }
    const models = probeModels(vendor);
    return ok({
      ok: true,
      models,
      status: 'ok',
      statusText: lang === 'en' ? `Found ${models.length} models` : `发现 ${models.length} 个模型`,
    });
  }
  if (path === '/api/v2/providers/grok/session' && method === 'GET') {
    return ok(grokSession(db));
  }
  if (path === '/api/v2/providers/grok/login' && method === 'POST') {
    return ok(startGrokLogin(db));
  }
  if (path === '/api/v2/providers/grok/login/poll' && method === 'POST') {
    return pollGrokLogin(db, hub, str(body.loginId));
  }
  if (path === '/api/v2/providers/grok/login/cancel' && method === 'POST') {
    db.grok.pending = null;
    db.grokPolls.clear();
    return ok(grokSession(db));
  }
  if (path === '/api/v2/providers/grok/logout' && method === 'POST') {
    db.grok.signedIn = false;
    db.grok.account = null;
    db.grok.pending = null;
    for (const row of db.providers) {
      if (row.id !== 'grok') continue;
      row.status = 'needs_auth';
      row.statusText = lang === 'en' ? 'Signed out' : '已退出登录';
    }
    publishProviders(db, hub);
    return ok(grokSession(db));
  }

  const contextMatch = /^\/api\/v2\/providers\/([^/]+)\/models\/([^/]+)\/context-window$/.exec(path);
  if (contextMatch && method === 'PUT') {
    const providerId = decodeURIComponent(contextMatch[1]);
    const modelId = decodeURIComponent(contextMatch[2]);
    const window = body.window === null ? null : Number(body.window);
    return setContextWindow(db, hub, providerId, modelId, Number.isFinite(window as number) ? window as number : null);
  }

  const providerTestMatch = /^\/api\/v2\/providers\/([^/]+)\/test$/.exec(path);
  if (providerTestMatch && method === 'POST') {
    const id = decodeURIComponent(providerTestMatch[1]);
    let provider = db.providers.find((row) => row.id === id);
    if (!provider && id === 'grok') {
      if (!db.grok.signedIn) return fail(409, lang === 'en' ? 'Grok is not signed in' : 'Grok 还没登录');
      provider = ensureGrokProvider(db, hub);
    }
    if (!provider) return fail(404, 'Provider 不存在');
    if (provider.id === 'grok' && !db.grok.signedIn) {
      provider.status = 'needs_auth';
      provider.statusText = lang === 'en' ? 'Sign in to Grok first' : '先登录 Grok';
      publishProviders(db, hub);
      return ok(providerView(provider));
    }
    provider.status = 'ok';
    provider.statusText = '';
    provider.lastTestedAt = Date.now();
    publishProviders(db, hub);
    return ok(providerView(provider));
  }

  const providerMatch = /^\/api\/v2\/providers\/([^/]+)$/.exec(path);
  if (providerMatch) {
    const id = decodeURIComponent(providerMatch[1]);
    let provider = db.providers.find((row) => row.id === id);
    if (!provider && id === 'grok' && db.grok.signedIn) provider = ensureGrokProvider(db, hub);
    if (!provider) return fail(404, 'Provider 不存在');
    if (method === 'PATCH') return patchProvider(db, hub, provider, body);
    if (method === 'GET') return ok(providerView(provider));
    if (method === 'DELETE') {
      const wasDefault = db.defaultModel?.providerId === provider.id;
      db.providers = db.providers.filter((row) => row.id !== provider!.id);
      publishProviderGone(hub, provider.id);
      // A signed-in Grok account is the only source of the `grok` Provider. In the
      // prototype it cannot stand on its own, so removing the default Provider or
      // the last API-key Provider signs Grok out too. That keeps the
      // 「没有配置模型」state reachable from the settings page.
      const onlyAccountLeft = db.providers.length > 0
        && db.providers.every((row) => row.access === 'account');
      if (db.grok.signedIn && (wasDefault || db.providers.length === 0 || onlyAccountLeft)) {
        db.grok.signedIn = false;
        db.grok.account = null;
        db.grok.pending = null;
        db.providers = db.providers.filter((row) => row.id !== 'grok');
        publishProviderGone(hub, 'grok');
      }
      if (db.defaultModel?.providerId === provider.id) {
        const next = db.providers.find((row) => row.models.length);
        db.defaultModel = next ? { providerId: next.id, modelId: next.models[0].id } : null;
      }
      for (const row of db.providers) row.isDefault = db.defaultModel?.providerId === row.id;
      publishProviders(db, hub);
      return ok({ removed: true });
    }
  }

  /* ---- workspaces ---- */
  if (path === '/api/v2/workspaces' && method === 'GET') {
    return ok({ workspaces: db.workspaces, conversations: [...db.conversations.values()].map(summaryOf) });
  }
  if (path === '/api/v2/workspaces' && method === 'POST') {
    return createWorkspace(db, hub, body, lang);
  }
  if (path === '/api/v2/workspace-root' && method === 'GET') {
    return ok({ root: WORK_ROOT });
  }
  if (path === '/api/v2/workspace-root/dirs' && method === 'GET') {
    return dirsView(url.searchParams.get('path') || WORK_ROOT, lang);
  }

  const wsConvMatch = /^\/api\/v2\/workspaces\/([^/]+)\/conversations$/.exec(path);
  if (wsConvMatch && method === 'POST') {
    const workspaceId = decodeURIComponent(wsConvMatch[1]);
    return createConversation(db, hub, workspaceId, String(body.title || ''));
  }
  const wsGitMatch = /^\/api\/v2\/workspaces\/([^/]+)\/git\/refresh$/.exec(path);
  if (wsGitMatch && method === 'POST') {
    const workspaceId = decodeURIComponent(wsGitMatch[1]);
    const ws = db.workspaces.find((row) => row.id === workspaceId);
    if (!ws) return fail(404, '工作区不存在');
    publishWorkspaces(db, hub);
    return ok(ws as Workspace);
  }
  const wsTreeMatch = /^\/api\/v2\/workspaces\/([^/]+)\/tree$/.exec(path);
  if (wsTreeMatch && method === 'GET') {
    const workspaceId = decodeURIComponent(wsTreeMatch[1]);
    const repo = db.repos.get(workspaceId);
    if (!repo) return fail(404, '工作区不存在');
    return ok(repoTree(repo));
  }
  const wsFilesMatch = /^\/api\/v2\/workspaces\/([^/]+)\/files$/.exec(path);
  if (wsFilesMatch) {
    const workspaceId = decodeURIComponent(wsFilesMatch[1]);
    const repo = db.repos.get(workspaceId);
    if (!repo) return fail(404, '工作区不存在');
    if (method === 'GET') {
      const raw = url.searchParams.get('path') || '';
      const content = readRepoFile(repo, raw);
      if (!content) return fail(404, lang === 'en' ? 'File not found' : '文件不存在', 'ENOENT');
      if (repo.touchOnOpen.has(content.path) && !repo.touched.has(content.path)) {
        repo.touchOnOpen.delete(content.path);
        window.setTimeout(() => {
          touchRepoFile(repo, content.path);
        }, EXTERNAL_TOUCH_MS);
      }
      return ok(content);
    }
    if (method === 'PUT') {
      const target = str(body.path);
      const text = typeof body.text === 'string' ? body.text : '';
      const baseVersion = typeof body.baseVersion === 'string' ? body.baseVersion : null;
      if (!target) return fail(400, 'path required', 'E_BAD_REQUEST');
      const before = readRepoFile(repo, target)?.text ?? '';
      const attempt = saveRepoFile(repo, target, text, baseVersion);
      if (!attempt.ok) {
        return fail(409, lang === 'en' ? 'File changed on disk' : '文件已被其他编辑器改过', 'E_CONFLICT', {
          current: attempt.conflict,
        });
      }
      const saved = attempt.result;
      const diff = textDiff(saved.path, before, text);
      for (const conv of db.conversations.values()) {
        if (conv.view.workspaceId !== workspaceId) continue;
        const change = conv.changes.find((row) => row.path === saved.path);
        const next = { path: saved.path, added: saved.added, removed: saved.removed, error: null };
        if (change) {
          change.added = next.added;
          change.removed = next.removed;
          change.error = next.error;
        } else {
          conv.changes.push(next);
        }
        conv.diffs[saved.path] = diff;
        publishChange(conv, hub, change || next);
      }
      return ok(saved);
    }
  }
  const wsMatch = /^\/api\/v2\/workspaces\/([^/]+)$/.exec(path);
  if (wsMatch && method === 'DELETE') {
    return removeWorkspace(db, hub, decodeURIComponent(wsMatch[1]));
  }

  /* ---- extensions ---- */
  if (path === '/api/v2/plugins' && method === 'GET') {
    return ok({ plugins: db.plugins });
  }
  if (path === '/api/v2/plugins' && method === 'POST') {
    return installPlugin(db, hub, body, lang);
  }
  const pluginMatch = /^\/api\/v2\/plugins\/([^/]+)$/.exec(path);
  if (pluginMatch && method === 'PATCH') {
    const id = decodeURIComponent(pluginMatch[1]);
    const plugin = db.plugins.find((row) => row.id === id);
    if (!plugin) return fail(404, lang === 'en' ? 'Plugin not found' : '插件不存在');
    if (typeof body.enabled === 'boolean') plugin.enabled = body.enabled;
    publishExtensions(db, hub);
    return ok(plugin);
  }
  if (path === '/api/v2/skills' && method === 'GET') {
    return ok({ skills: db.skills });
  }
  if (path === '/api/v2/skills' && method === 'POST') {
    return saveSkill(db, hub, body, null, lang);
  }
  const skillMatch = /^\/api\/v2\/skills\/([^/]+)$/.exec(path);
  if (skillMatch && method === 'PATCH') {
    return saveSkill(db, hub, body, decodeURIComponent(skillMatch[1]), lang);
  }
  if (skillMatch && method === 'DELETE') {
    const id = decodeURIComponent(skillMatch[1]);
    const skill = db.skills.find((row) => row.id === id);
    if (!skill) return fail(404, lang === 'en' ? 'Skill not found' : '技能不存在');
    if (!skill.deletable) {
      return fail(400, lang === 'en' ? 'Built-in skills cannot be deleted' : '内置技能不能删除', 'err_skill_builtin');
    }
    db.skills = db.skills.filter((row) => row.id !== id);
    hub.publish('extensions', { event: 'remove', entity: 'skill', id });
    return ok({ ok: true, id });
  }
  if (path === '/api/v2/extensions') return ok({});

  /* ---- git connections ---- */
  if (path === '/api/v2/git/connections' && method === 'GET') {
    return ok({ connections: db.gitConnections });
  }
  if (path === '/api/v2/git/connections' && method === 'POST') {
    return saveGitConnection(db, hub, body, null, lang);
  }
  if (path === '/api/v2/git/connections/test' && method === 'POST') {
    const form = gitFormOf(body);
    const existing = str(body.id) ? db.gitConnections.find((row) => row.id === str(body.id)) : undefined;
    const token = form.token || (existing?.hasToken ? '__keep__' : '');
    return testGit(lang, { name: form.name || existing?.name || '', baseUrl: form.baseUrl || existing?.baseUrl || '', token });
  }
  const gitBranchesMatch = /^\/api\/v2\/git\/connections\/([^/]+)\/projects\/([^/]+)\/branches$/.exec(path);
  if (gitBranchesMatch && method === 'GET') {
    const connectionId = decodeURIComponent(gitBranchesMatch[1]);
    const projectId = decodeURIComponent(gitBranchesMatch[2]);
    const project = (db.gitProjects[connectionId] || []).find((row) => String(row.id) === projectId);
    if (!project) return fail(404, lang === 'en' ? 'Project not found' : '项目不存在');
    const branches = branchesOf(project);
    return ok({ branches, defaultBranch: project.defaultBranch });
  }
  const gitProjectsMatch = /^\/api\/v2\/git\/connections\/([^/]+)\/projects$/.exec(path);
  if (gitProjectsMatch && method === 'GET') {
    const connectionId = decodeURIComponent(gitProjectsMatch[1]);
    const search = (url.searchParams.get('search') || '').trim().toLowerCase();
    const all = db.gitProjects[connectionId] || [];
    const projects = search
      ? all.filter((row) => `${row.path} ${row.description}`.toLowerCase().includes(search))
      : all;
    return ok({ projects });
  }
  const gitTestMatch = /^\/api\/v2\/git\/connections\/([^/]+)\/test$/.exec(path);
  if (gitTestMatch && method === 'POST') {
    const id = decodeURIComponent(gitTestMatch[1]);
    const conn = db.gitConnections.find((row) => row.id === id);
    if (!conn) return fail(404, lang === 'en' ? 'Connection not found' : '连接不存在');
    const result = testGit(lang, {
      name: conn.name,
      baseUrl: conn.baseUrl,
      token: conn.lastTest?.error === 'auth_failed' ? 'bad-token' : 'kept',
    });
    const parsed = result.body as GitTestResult;
    conn.lastTest = {
      ok: parsed.ok,
      username: parsed.username,
      error: parsed.code,
      errorText: parsed.statusText,
      at: new Date().toISOString(),
    };
    publishExtensions(db, hub);
    return ok({ ...parsed, connection: conn });
  }
  const gitMatch = /^\/api\/v2\/git\/connections\/([^/]+)$/.exec(path);
  if (gitMatch) {
    const id = decodeURIComponent(gitMatch[1]);
    if (method === 'PATCH') return saveGitConnection(db, hub, body, id, lang);
    if (method === 'DELETE') {
      if (!db.gitConnections.some((row) => row.id === id)) {
        return fail(404, lang === 'en' ? 'Connection not found' : '连接不存在');
      }
      db.gitConnections = db.gitConnections.filter((row) => row.id !== id);
      delete db.gitProjects[id];
      hub.publish('extensions', { event: 'remove', entity: 'git_connection', id });
      return ok({ ok: true, id });
    }
    if (method === 'GET') {
      const conn = db.gitConnections.find((row) => row.id === id);
      return conn ? ok(conn) : fail(404, '连接不存在');
    }
  }

  /* ---- conversations ---- */
  const subagentMatch = /^\/api\/v2\/conversations\/([^/]+)\/subagents\/([^/]+)$/.exec(path);
  if (subagentMatch && method === 'GET') {
    const cid = decodeURIComponent(subagentMatch[1]);
    const agentId = decodeURIComponent(subagentMatch[2]);
    const thread = db.subagents.get(subagentKey(cid, agentId));
    if (!thread || !db.conversations.has(cid)) return fail(404, '子 Agent 不存在');
    return ok(subagentSnapshot(thread, lang));
  }
  const subMsgMatch = /^\/api\/v2\/conversations\/([^/]+)\/subagents\/([^/]+)\/messages$/.exec(path);
  if (subMsgMatch && method === 'POST') {
    const cid = decodeURIComponent(subMsgMatch[1]);
    const agentId = decodeURIComponent(subMsgMatch[2]);
    const thread = db.subagents.get(subagentKey(cid, agentId));
    if (!thread || !db.conversations.has(cid)) return fail(404, '子 Agent 不存在');
    const text = str(body.text).trim();
    if (!text) return fail(400, '消息不能为空', 'E_BAD_REQUEST');
    if (thread.view.status !== 'running' && thread.view.status !== 'stuck') {
      return fail(409, lang === 'en' ? 'Subagent is not running' : '子 Agent 不在运行中', 'E_SUBAGENT_IDLE');
    }
    void replyInSubThread(db, hub, thread, text);
    return accepted({ ok: true });
  }
  const subStopMatch = /^\/api\/v2\/conversations\/([^/]+)\/subagents\/([^/]+)\/stop$/.exec(path);
  if (subStopMatch && method === 'POST') {
    const cid = decodeURIComponent(subStopMatch[1]);
    const agentId = decodeURIComponent(subStopMatch[2]);
    const thread = db.subagents.get(subagentKey(cid, agentId));
    if (!thread || !db.conversations.has(cid)) return fail(404, '子 Agent 不存在');
    stopSubThread(db, hub, thread);
    return accepted({ stopping: true });
  }

  const convMatch = /^\/api\/v2\/conversations\/([^/]+)$/.exec(path);
  if (convMatch) {
    const cid = decodeURIComponent(convMatch[1]);
    const conv = getConv(db, cid);
    if (!conv) return fail(404, '对话不存在');
    if (method === 'GET') return ok(conversationSnapshot(conv, lang));
    if (method === 'PATCH') return patchConversation(db, hub, conv, body);
  }

  const imageMatch = /^\/api\/v2\/conversations\/([^/]+)\/messages\/([^/]+)\/images\/([^/]+)$/.exec(path);
  if (imageMatch && method === 'GET') {
    const cid = decodeURIComponent(imageMatch[1]);
    const messageId = decodeURIComponent(imageMatch[2]);
    const indexRaw = decodeURIComponent(imageMatch[3]);
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 0 || String(index) !== indexRaw) {
      return fail(404, 'not found');
    }
    const stored = db.messageImages.get(`${cid}\t${messageId}\t${index}`);
    if (!stored) return fail(404, 'not found');
    return {
      status: 200,
      bytes: stored.bytes,
      headers: {
        'content-type': stored.mediaType,
        'cache-control': 'private, max-age=31536000, immutable',
        etag: `"${stored.bytes.length}-${stored.mediaType}"`,
      },
    };
  }

  const msgMatch = /^\/api\/v2\/conversations\/([^/]+)\/messages$/.exec(path);
  if (msgMatch && method === 'POST') {
    const cid = decodeURIComponent(msgMatch[1]);
    const conv = getConv(db, cid);
    if (!conv) return fail(404, '对话不存在');
    if (body.text != null && typeof body.text !== 'string') {
      return fail(400, '消息不能为空', 'E_BAD_REQUEST');
    }
    const text = String(body.text ?? '').trim();
    const parsedImages = parseSendImages(body.images);
    if (!parsedImages.ok) return fail(400, parsedImages.error, parsedImages.code);
    if (!text && parsedImages.images.length === 0) return fail(400, '消息不能为空', 'E_BAD_REQUEST');
    const requestId = typeof body.requestId === 'string' && body.requestId
      ? body.requestId
      : nextId(db, 'req');
    const result = sendMessage(db, conv, hub, text, requestId, parsedImages.images);
    if (!result.ok) return fail(result.status, result.error);
    return accepted({ runId: result.runId });
  }
  const stopMatch = /^\/api\/v2\/conversations\/([^/]+)\/stop$/.exec(path);
  if (stopMatch && method === 'POST') {
    const conv = getConv(db, decodeURIComponent(stopMatch[1]));
    if (!conv) return fail(404, '对话不存在');
    stopConversation(db, conv, hub);
    return accepted({ stopping: true });
  }
  const continueMatch = /^\/api\/v2\/conversations\/([^/]+)\/continue$/.exec(path);
  if (continueMatch && method === 'POST') {
    const conv = getConv(db, decodeURIComponent(continueMatch[1]));
    if (!conv) return fail(404, '对话不存在');
    return accepted({ runId: continueConversation(db, conv, hub) });
  }
  const toolMatch = /^\/api\/v2\/conversations\/([^/]+)\/tools\/([^/]+)\/output$/.exec(path);
  if (toolMatch && method === 'GET') {
    const conv = getConv(db, decodeURIComponent(toolMatch[1]));
    const tool = conv?.tools[decodeURIComponent(toolMatch[2])];
    if (!conv || !tool) return fail(404, '工具调用不存在');
    return ok({ id: tool.id, text: tool.output, totalLines: tool.totalLines });
  }
  const diffMatch = /^\/api\/v2\/conversations\/([^/]+)\/diff$/.exec(path);
  if (diffMatch && method === 'GET') {
    const conv = getConv(db, decodeURIComponent(diffMatch[1]));
    const filePath = url.searchParams.get('path') || '';
    const diff = conv?.diffs[filePath];
    if (!conv || !diff) return fail(404, lang === 'en' ? 'No diff for this file' : '原型里没有这个文件的 diff');
    return ok(diff);
  }

  if (path === '/api/v2/events') return fail(400, '事件流要走 EventSource');

  return fail(404, `原型没有这个接口：${method} ${path}`);
}

/** Everything the prototype serves, wrapped in a real `Response`. */
export function mockResponse(db: MockDb, hub: MockHub, rawUrl: string, init?: RequestInit): Response {
  const reply = handleMockRequest(db, hub, rawUrl, init);
  if (reply.bytes) {
    const copy = new ArrayBuffer(reply.bytes.byteLength);
    new Uint8Array(copy).set(reply.bytes);
    return new Response(copy, {
      status: reply.status,
      headers: reply.headers,
    });
  }
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...reply.headers },
  });
}
