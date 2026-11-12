import type { components } from '../../../src/v2/contract.gen';
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
  publishTool,
  publishWorkspaces,
  recomputeContext,
  touch,
} from './db';
import {
  compactConversation,
  continueConversation,
  handoffConversation,
  sendMessage,
  stopConversation,
  withdrawMessage,
} from './run';
import { parseSendImages } from '../../../src/v2/views/message-images';
import { mockEffectiveTriggers } from './compaction';
import { inferCustomProviderBrand, inferModelBrand } from './brand';
import { mockProviderName } from './providerNames';
import { replyInSubThread, stopSubThread, subagentKey } from './subagents';
import { branchesOf, pluginForLang, tokenFails } from './extensions';
import { isBlockedPath, mockPickWorkspaceFolder } from './pickModal';
import {
  EXTERNAL_TOUCH_MS,
  createRepo,
  isRawFileHit,
  posixPath,
  queryRepoTree,
  readRepoFile,
  readRepoFileRaw,
  repoTree,
  saveRepoFile,
  textDiff,
  touchRepoFile,
} from './repo';
import { searchRepoFiles } from './file-search';
import {
  conversationValue,
  itemValue,
  summaryOf,
  toolValue,
} from './views';
import { mockPathname } from './mockPath';
import { buildMockReport } from './report';
import { MOCK_AVAILABLE_PROVIDERS, MOCK_CATALOG_MODELS } from './piCatalog';
import { sortAvailableProviders } from '../../src/data/providerFormat';
import { clampThinkingLevel, THINKING_LEVEL_ORDER, type ThinkingLevel } from '../../src/data/composerModel';
import type {
  CustomApiProtocol,
  ConversationSummary,
  EntityValue,
  GitConnection,
  GitTestResult,
  GlabBinaryInfo,
  GlabSettings,
  Lang,
  LoginSession,
  MockConv,
  MockDb,
  MockItem,
  MockTool,
  Model,
  Plugin,
  Provider,
  ResolvedModel,
  Schedule,
  ScheduleRun,
  ScheduleTarget,
  ScheduleRule,
  Skill,
  ThreadItem,
  MockSubThread,
  ToolCall,
  Workspace,
  WorkspaceDirEntry,
  WorkspaceDirs,
} from './types';
import { tr } from './types';

export type MockReply = {
  status: number;
  body?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
};

const SERVICE_VERSION = '0.1.0-prototype';
const STARTED_AT = Date.now();
const WORK_ROOT = 'D:\\work';

function ok(body: unknown): MockReply {
  return { status: 200, body };
}

function noContent(): MockReply {
  return { status: 204 };
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
  const query = url.searchParams.get('lang');
  if (query === 'en' || query === 'zh') return query;
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage?.getItem('weft_lang');
      if (stored === 'en' || stored === 'zh') return stored;
      if (document.documentElement.lang === 'en') return 'en';
    } catch {
      // ignore storage access errors
    }
  }
  return 'zh';
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

function requestHeader(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers;
  if (!headers) return '';
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) || '';
  if (Array.isArray(headers)) {
    const hit = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return hit ? String(hit[1]) : '';
  }
  const rec = headers as Record<string, string>;
  for (const key of Object.keys(rec)) {
    if (key.toLowerCase() === name.toLowerCase()) return String(rec[key] ?? '');
  }
  return '';
}

function modelLabel(db: MockDb, model: ResolvedModel | null): string {
  if (!model) return '';
  const provider = db.providers.find((row) => row.id === model.providerId);
  const found = provider?.models.find((row) => row.id === model.modelId);
  return found?.name || found?.id || model.modelId;
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

function providerView(provider: Provider, lang: Lang): Provider {
  return {
    ...provider,
    name: provider.kind === 'custom'
      ? provider.name
      : mockProviderName(provider.id, provider.name, lang),
    models: provider.models.map((model) => ({ ...model })),
  };
}

function publishProviderGone(hub: MockHub, id: string): void {
  hub.publish('providers', { event: 'remove', entity: 'provider', id });
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

function deleteConversation(db: MockDb, hub: MockHub, conv: MockConv, lang: Lang): MockReply {
  if (conv.view.status === 'running') {
    return fail(409, lang === 'en' ? 'Conversation is running' : '对话正在运行', 'E_CONVERSATION_RUNNING');
  }
  const cid = conv.view.id;
  const workspaceId = conv.view.workspaceId;
  db.conversations.delete(cid);
  publishRemove(conv, hub, 'conversation', cid);
  hub.publish('workspaces', {
    event: 'remove',
    entity: 'conversation_summary',
    id: cid,
  });
  const ws = db.workspaces.find((row) => row.id === workspaceId);
  if (ws) {
    hub.publish('workspaces', {
      event: 'upsert',
      entity: 'workspace',
      id: ws.id,
      value: {
        ...ws,
        conversationCount: [...db.conversations.values()].filter((row) => row.view.workspaceId === ws.id && !row.archived).length,
        runningCount: [...db.conversations.values()].filter((row) => row.view.workspaceId === ws.id && !row.archived && row.view.status === 'running').length,
      },
    });
  }
  return noContent();
}

function createChatWorkspace(db: MockDb, convId: string, title: string): Workspace {
  const name = title || '对话';
  const ws: Workspace = {
    id: `ws-chat-${convId}`,
    name,
    path: `D:\\data\\chats\\${convId}`,
    source: 'local',
    gitUrl: null,
    branch: null,
    git: null,
    kind: 'chat',
    conversationCount: 0,
    runningCount: 0,
  };
  db.workspaces.push(ws);
  db.repos.set(ws.id, workspaceRepo(name));
  return ws;
}

function createConversation(db: MockDb, hub: MockHub, workspaceId: string | null, title: string): MockReply {
  let ws = workspaceId ? db.workspaces.find((row) => row.id === workspaceId) : undefined;
  if (workspaceId && !ws) return fail(404, '工作区不存在');
  const id = nextId(db, 'c');
  if (!ws) {
    ws = createChatWorkspace(db, id, title);
  }
  const model = db.defaultModel;
  const provider = db.providers.find((row) => row.id === model?.providerId);
  const found = provider?.models.find((row) => row.id === model?.modelId);
  const window = found?.contextWindow || 200_000;
  const conv: MockConv = {
    view: {
      id,
      workspaceId: ws.id,
      title: title || '新对话',
      updatedAt: Date.now(),
      status: 'idle',
      model: model && found
        ? { sourceId: model.providerId, modelId: model.modelId, label: modelLabel(db, model) }
        : null,
      thinkingLevel: found ? (found.defaultThinkingLevel ?? null) : null,
      run: {
        status: 'idle',
        startedAt: null,
        pendingText: null,
        canSend: true,
        canStop: false,
        lockedReason: null,
        error: null,
        lastActivityAt: null,
        stalledSince: null,
        activeTool: null,
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

function forkConversation(
  db: MockDb,
  hub: MockHub,
  conv: MockConv,
  body: Record<string, unknown>,
  lang: Lang,
): MockReply {
  const entryId = typeof body.entryId === 'string' ? body.entryId : '';
  if (!entryId) {
    return fail(400, 'entryId is required', 'E_BAD_REQUEST');
  }

  if (conv.forkFails) {
    const reason = typeof conv.forkFails === 'object'
      ? tr(conv.forkFails, lang)
      : (lang === 'en' ? 'Conversation history corrupted' : '对话历史已损坏');
    return fail(400, reason, 'E_FORK_FAILED');
  }

  if (entryId.includes('fail')) {
    return fail(400, lang === 'en' ? 'Snapshot corrupted' : '快照已损坏', 'E_FORK_FAILED');
  }

  const targetIndex = conv.items.findIndex((item) => {
    const it = item as { entryId?: string | null; id: string };
    return it.entryId === entryId || it.id === entryId;
  });

  if (targetIndex === -1) {
    return fail(400, lang === 'en' ? 'Entry not found' : '指定的消息不存在', 'E_ENTRY_NOT_FOUND');
  }

  const targetItem = conv.items[targetIndex];
  if ((targetItem as { streaming?: boolean }).streaming) {
    return fail(400, lang === 'en' ? 'Cannot fork from streaming message' : '不能从流式输出中的消息分叉', 'E_STREAMING');
  }

  let forkedItems: MockItem[];
  let prefill: { text: string } | null = null;

  if (targetItem.kind === 'assistant') {
    forkedItems = conv.items.slice(0, targetIndex + 1);
    prefill = null;
  } else if (targetItem.kind === 'user') {
    forkedItems = conv.items.slice(0, targetIndex);
    prefill = { text: targetItem.text };
  } else {
    forkedItems = conv.items.slice(0, targetIndex + 1);
    prefill = null;
  }

  const clonedItems: MockItem[] = forkedItems.map((item) => {
    if (item.kind === 'tool_group') {
      return { ...item, toolIds: [...item.toolIds] };
    }
    return { ...item };
  });

  const clonedTools: Record<string, MockTool> = {};
  for (const item of clonedItems) {
    if (item.kind === 'tool_group') {
      for (const tid of item.toolIds) {
        if (conv.tools[tid]) {
          clonedTools[tid] = { ...conv.tools[tid] };
        }
      }
    }
  }

  const newId = nextId(db, 'c');
  const now = Date.now();
  const title = `${conv.view.title} (fork)`;

  const newConv: MockConv = {
    view: {
      id: newId,
      workspaceId: conv.view.workspaceId,
      title,
      updatedAt: now,
      status: 'idle',
      model: conv.view.model ? { ...conv.view.model } : null,
      thinkingLevel: conv.view.thinkingLevel ?? null,
      run: {
        status: 'idle',
        startedAt: null,
        pendingText: null,
        canSend: true,
        canStop: false,
        lockedReason: null,
        error: null,
        lastActivityAt: null,
        stalledSince: null,
        activeTool: null,
      },
      context: { used: 0, window: conv.view.context.window, percent: 0, level: 'ok' },
      itemIds: clonedItems.map((it) => it.id),
      sends: [],
      forkedFrom: {
        conversationId: conv.view.id,
        title: conv.view.title,
      },
    },
    pending: null,
    items: clonedItems,
    tools: clonedTools,
    changes: [],
    diffs: {},
    subagents: [],
    run: null,
    requestRuns: new Map(),
  };

  recomputeContext(db, newConv);
  db.conversations.set(newId, newConv);
  publishSummary(db, hub, newId);
  publishWorkspaces(db, hub);

  return created({
    conversationId: newId,
    prefill,
  });
}

function patchConversation(
  db: MockDb,
  hub: MockHub,
  conv: MockConv,
  body: Record<string, unknown>,
): MockReply {
  const hasModel = Object.prototype.hasOwnProperty.call(body, 'model');
  const hasThinking = Object.prototype.hasOwnProperty.call(body, 'thinkingLevel');
  const hasArchived = Object.prototype.hasOwnProperty.call(body, 'archived');
  if (!hasModel && !hasThinking && !hasArchived) {
    return fail(400, 'model, thinkingLevel or archived required', 'E_BAD_REQUEST');
  }

  if (hasArchived) {
    if (typeof body.archived !== 'boolean') {
      return fail(400, 'archived must be a boolean', 'E_BAD_REQUEST');
    }
    conv.archived = body.archived;
    publishSummary(db, hub, conv.view.id);
  }

  if (hasModel) {
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
    } else {
      return fail(400, 'invalid model', 'E_BAD_REQUEST');
    }
  }

  const currentRef = conv.view.model
    ? { providerId: conv.view.model.sourceId, modelId: conv.view.model.modelId }
    : db.defaultModel;
  const currentProvider = db.providers.find((p) => p.id === currentRef?.providerId);
  const currentModel = currentProvider?.models.find((m) => m.id === currentRef?.modelId);
  const supportedLevels = currentModel?.thinkingLevels || [];

  if (hasThinking) {
    const rawThinking = body.thinkingLevel;
    if (rawThinking === null) {
      conv.view.thinkingLevel = currentModel?.defaultThinkingLevel ?? null;
    } else if (typeof rawThinking === 'string') {
      if (!THINKING_LEVEL_ORDER.includes(rawThinking as ThinkingLevel)) {
        return fail(400, 'invalid thinkingLevel', 'E_BAD_REQUEST');
      }
      conv.view.thinkingLevel = clampThinkingLevel(supportedLevels, rawThinking as ThinkingLevel);
    } else {
      return fail(400, 'invalid thinkingLevel', 'E_BAD_REQUEST');
    }
  } else if (hasModel) {
    conv.view.thinkingLevel = clampThinkingLevel(supportedLevels, conv.view.thinkingLevel);
  }

  recomputeContext(db, conv);
  touch(conv);
  publishConversationView(conv, hub);
  return ok(valueOf(conversationValue(conv), 'zh'));
}

function handleConnect(
  db: MockDb,
  hub: MockHub,
  id: string,
  body: Record<string, unknown>,
  lang: Lang,
): MockReply {
  const method = str(body.method);
  if (method === 'api_key') {
    const apiKey = str(body.apiKey).trim();
    if (!apiKey || apiKey.startsWith('bad')) {
      return fail(400, lang === 'en' ? 'Invalid API key' : '无效的 API Key', 'E_AUTH');
    }
    const avail = MOCK_AVAILABLE_PROVIDERS.find((p) => p.id === id);
    const catModels = MOCK_CATALOG_MODELS[id] || [];
    const provider: Provider = {
      id,
      kind: 'builtin',
      brand: id === 'xai' ? 'xai' : id === 'deepseek' ? 'DeepSeek' : id === 'anthropic' ? 'Anthropic' : id === 'openai' ? 'OpenAI' : id === 'zai' ? 'ZAI' : id === 'moonshotai-cn' ? 'Moonshot' : (avail?.name || null),
      name: avail?.name || id,
      auth: { type: 'api_key', keyTail: apiKey.slice(-4) },
      status: { state: 'ok', testedAt: Date.now() },
      models: catModels.map((m) => ({ ...m, enabled: true })),
    };
    const idx = db.providers.findIndex((p) => p.id === id);
    if (idx >= 0) db.providers[idx] = provider;
    else db.providers.push(provider);
    if (!db.defaultModel && provider.models.some((m) => m.enabled)) {
      const first = provider.models.find((m) => m.enabled);
      if (first) db.defaultModel = { providerId: id, modelId: first.id };
    }
    publishProviders(db, hub);
    return ok({ provider: providerView(provider, lang) });
  }

  if (method === 'env') {
    const avail = MOCK_AVAILABLE_PROVIDERS.find((p) => p.id === id);
    const catModels = MOCK_CATALOG_MODELS[id] || [];
    const provider: Provider = {
      id,
      kind: 'builtin',
      brand: id === 'moonshotai-cn' ? 'Moonshot' : (avail?.name || null),
      name: avail?.name || id,
      auth: { type: 'env', envVar: avail?.envVar || 'MOONSHOT_API_KEY' },
      status: { state: 'ok', testedAt: Date.now() },
      models: catModels.map((m) => ({ ...m, enabled: true })),
    };
    const idx = db.providers.findIndex((p) => p.id === id);
    if (idx >= 0) db.providers[idx] = provider;
    else db.providers.push(provider);
    if (!db.defaultModel && provider.models.some((m) => m.enabled)) {
      const first = provider.models.find((m) => m.enabled);
      if (first) db.defaultModel = { providerId: id, modelId: first.id };
    }
    publishProviders(db, hub);
    return ok({ provider: providerView(provider, lang) });
  }

  if (method === 'local_login') {
    if (id !== 'xai') return fail(400, 'local login not supported', 'E_BAD_REQUEST');
    const avail = MOCK_AVAILABLE_PROVIDERS.find((p) => p.id === id);
    const catModels = MOCK_CATALOG_MODELS[id] || [];
    const provider: Provider = {
      id,
      kind: 'builtin',
      brand: 'xai',
      name: avail?.name || 'Grok',
      auth: { type: 'oauth', account: avail?.localLogin?.account || 'lawrence@x.com' },
      status: { state: 'ok', testedAt: Date.now() },
      models: catModels.map((m) => ({ ...m, enabled: true })),
    };
    const idx = db.providers.findIndex((p) => p.id === id);
    if (idx >= 0) db.providers[idx] = provider;
    else db.providers.push(provider);
    if (!db.defaultModel && provider.models.some((m) => m.enabled)) {
      const first = provider.models.find((m) => m.enabled);
      if (first) db.defaultModel = { providerId: id, modelId: first.id };
    }
    publishProviders(db, hub);
    return ok({ provider: providerView(provider, lang) });
  }

  if (method === 'oauth') {
    const sid = nextId(db, 'session');
    const avail = MOCK_AVAILABLE_PROVIDERS.find((p) => p.id === id);
    const isXai = id === 'xai';
    const progressEvent = {
      type: 'progress' as const,
      message: lang === 'en' ? 'Waiting for authorization…' : '等待授权…',
    };
    const session: LoginSession = {
      id: sid,
      providerId: id,
      state: 'pending',
      events: isXai
        ? [progressEvent]
        : [
            {
              type: 'auth_url',
              url: `https://auth.${id}.com/oauth/authorize`,
              instructions: `用 ${avail?.name || id} 账号授权（订阅额度可直接用）`,
            },
            {
              type: 'device_code',
              userCode: 'WFT-7Q2K',
              verificationUri: `https://auth.${id}.com/device`,
            },
            progressEvent,
          ],
    };
    db.loginSessions.set(sid, { session, pollCount: 0 });
    return ok({ session });
  }

  return fail(400, 'Unsupported connect method', 'E_BAD_REQUEST');
}

function handleCustomProvider(
  db: MockDb,
  hub: MockHub,
  body: Record<string, unknown>,
  lang: Lang,
): MockReply {
  const name = str(body.name).trim() || (lang === 'en' ? 'Custom endpoint' : '自定义接口');
  const baseUrl = str(body.baseUrl).trim();
  const api = (str(body.api) as CustomApiProtocol) || 'openai-completions';
  const apiKey = str(body.apiKey).trim();

  if (!baseUrl) return fail(400, 'Base URL 不能为空', 'E_BAD_REQUEST');
  if (baseUrl.includes('bad') || apiKey.startsWith('bad')) {
    return fail(400, lang === 'en' ? 'Connection failed' : '连接失败', 'E_AUTH');
  }

  const customModels: Model[] = [
    {
      id: 'llama3.3:70b',
      name: 'llama3.3:70b',
      brand: inferModelBrand('llama3.3:70b'),
      enabled: true,
      contextWindow: 131072,
      maxTokens: 8192,
      images: false,
      reasoning: false,
      overridden: {},
    },
    {
      id: 'qwen3:32b',
      name: 'qwen3:32b',
      brand: inferModelBrand('qwen3:32b'),
      enabled: true,
      contextWindow: 40960,
      maxTokens: 8192,
      images: false,
      reasoning: true,
      overridden: {},
    },
    {
      id: 'nomic-embed-text',
      name: 'nomic-embed-text',
      brand: inferModelBrand('nomic-embed-text'),
      enabled: false,
      contextWindow: null,
      maxTokens: null,
      images: false,
      reasoning: false,
      overridden: {},
    },
  ];

  const id = `custom-${Math.random().toString(16).slice(2, 10)}`;
  const provider: Provider = {
    id,
    kind: 'custom',
    brand: inferCustomProviderBrand(customModels),
    name,
    baseUrl,
    api,
    auth: apiKey ? { type: 'api_key', keyTail: apiKey.slice(-4) } : { type: 'none' },
    status: { state: 'ok', testedAt: Date.now() },
    models: customModels,
  };
  db.providers.push(provider);
  if (!db.defaultModel && provider.models.some((m) => m.enabled)) {
    const first = provider.models.find((m) => m.enabled);
    if (first) db.defaultModel = { providerId: id, modelId: first.id };
  }
  publishProviders(db, hub);
  return ok({ provider: providerView(provider, lang) });
}

function handlePatchProvider(
  db: MockDb,
  hub: MockHub,
  provider: Provider,
  body: Record<string, unknown>,
  lang: Lang,
): MockReply {
  if (Array.isArray(body.enabled)) {
    const set = new Set(body.enabled.map(String));
    for (const m of provider.models) {
      m.enabled = set.has(m.id);
    }
  }
  if (body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)) {
    for (const [mid, rawOv] of Object.entries(body.overrides as Record<string, unknown>)) {
      const ov = rawOv && typeof rawOv === 'object' ? (rawOv as Record<string, unknown>) : null;
      if (!ov) continue;
      const m = provider.models.find((x) => x.id === mid);
      if (!m) continue;
      if (ov.contextWindow !== undefined) {
        if (ov.contextWindow === null) {
          m.overridden = { ...m.overridden, contextWindow: false };
          const cat = MOCK_CATALOG_MODELS[provider.id]?.find((x) => x.id === mid);
          m.contextWindow = m.defaultContextWindow ?? (cat ? cat.contextWindow : (mid === 'glm-5.2-fp8' ? null : 128_000));
        } else if (Number.isFinite(ov.contextWindow)) {
          if (m.defaultContextWindow === undefined) {
            const cat = MOCK_CATALOG_MODELS[provider.id]?.find((x) => x.id === mid);
            m.defaultContextWindow = cat ? cat.contextWindow : m.contextWindow;
          }
          m.contextWindow = Number(ov.contextWindow);
          m.overridden = { ...m.overridden, contextWindow: true };
        }
      }
      if (ov.maxTokens !== undefined) {
        if (ov.maxTokens === null) {
          m.overridden = { ...m.overridden, maxTokens: false };
          const cat = MOCK_CATALOG_MODELS[provider.id]?.find((x) => x.id === mid);
          m.maxTokens = cat ? cat.maxTokens : null;
        } else if (Number.isFinite(ov.maxTokens)) {
          m.maxTokens = Number(ov.maxTokens);
          m.overridden = { ...m.overridden, maxTokens: true };
        }
      }
    }
  }
  if (body.defaultModel !== undefined) {
    if (body.defaultModel === null) {
      if (db.defaultModel?.providerId === provider.id) db.defaultModel = null;
    } else if (typeof body.defaultModel === 'string' && body.defaultModel) {
      db.defaultModel = { providerId: provider.id, modelId: body.defaultModel };
    }
  }
  if (typeof body.name === 'string' && body.name.trim()) provider.name = body.name.trim();
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) provider.baseUrl = body.baseUrl.trim();
  if (typeof body.api === 'string') provider.api = body.api as CustomApiProtocol;
  if (typeof body.apiKey === 'string') {
    provider.auth = { ...provider.auth, type: 'api_key', keyTail: body.apiKey.slice(-4) };
    provider.status = { state: 'ok', testedAt: Date.now() };
  }
  publishProviders(db, hub);
  if (body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)) {
    const patchedModelIds = new Set(Object.keys(body.overrides as Record<string, unknown>));
    for (const conv of db.conversations.values()) {
      const sourceId = conv.view.model?.sourceId || db.defaultModel?.providerId;
      const modelId = conv.view.model?.modelId || db.defaultModel?.modelId;
      if (sourceId === provider.id && modelId && patchedModelIds.has(modelId)) {
        recomputeContext(db, conv);
        publishConversationView(conv, hub);
      }
    }
  }
  return ok({ provider: providerView(provider, lang) });
}

/* ---------- workspace directory browser ---------- */

type MockDir = { entries: WorkspaceDirEntry[]; git: boolean };

const DIRS: Record<string, MockDir> = {
  'C:\\': {
    git: false,
    entries: [{ name: 'Users', path: 'C:\\Users', git: false }],
  },
  'C:\\Users': {
    git: false,
    entries: [{ name: 'demo', path: 'C:\\Users\\demo', git: false }],
  },
  'C:\\Users\\demo': {
    git: false,
    entries: [{ name: 'Projects', path: 'C:\\Users\\demo\\Projects', git: false }],
  },
  'C:\\Users\\demo\\Projects': {
    git: false,
    entries: [
      { name: 'billing-api', path: 'C:\\Users\\demo\\Projects\\billing-api', git: true },
      { name: 'docs-site', path: 'C:\\Users\\demo\\Projects\\docs-site', git: false },
    ],
  },
  'C:\\Users\\demo\\Projects\\billing-api': { git: true, entries: [] },
  'C:\\Users\\demo\\Projects\\docs-site': { git: false, entries: [] },
  'D:\\': {
    git: false,
    entries: [
      { name: 'work', path: 'D:\\work', git: false },
      { name: 'Users', path: 'D:\\Users', git: false },
    ],
  },
  'D:\\Users': {
    git: false,
    entries: [
      { name: 'user', path: 'D:\\Users\\user', git: false },
    ],
  },
  'D:\\Users\\user': {
    git: false,
    entries: [
      { name: '.ssh', path: 'D:\\Users\\user\\.ssh', git: false },
    ],
  },
  'D:\\Users\\user\\.ssh': {
    git: false,
    entries: [],
  },
  '~': {
    git: false,
    entries: [
      { name: '.ssh', path: '~\\.ssh', git: false },
    ],
  },
  '~\\.ssh': {
    git: false,
    entries: [],
  },
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

/** 目录表按小写键查，盘符大小写、末尾分隔符不影响命中；返回表里的规范写法。 */
const DIR_KEYS = new Map(Object.keys(DIRS).map((key) => [key.toLowerCase(), key]));

function canonicalDir(raw: string): string | null {
  let text = normalizeDir(raw);
  if (/^[a-zA-Z]:$/.test(text)) text += '\\';
  return DIR_KEYS.get(text.toLowerCase()) ?? null;
}

function parentDir(path: string): string | null {
  const norm = path.replaceAll('/', '\\').replace(/\\+$/, '');
  if (!norm) return null;
  if (/^[a-zA-Z]:$/.test(norm)) return null;
  if (norm === '~' || norm === '\\' || norm === '/') return null;
  const at = norm.lastIndexOf('\\');
  if (at < 0) return null;
  if (at === 2 && norm[1] === ':') {
    return `${norm.slice(0, 2)}\\`;
  }
  if (at === 0) {
    return '\\';
  }
  return norm.slice(0, at);
}

function dirsView(path: string, lang: Lang): MockReply {
  const normalized = canonicalDir(path);
  const hit = normalized ? DIRS[normalized] : null;
  if (!normalized || !hit) {
    return fail(404, lang === 'en' ? 'Directory not found in the prototype' : '原型里没有这个目录', 'E_PATH');
  }
  const blocked = isBlockedPath(normalized);
  const isFsRoot = normalized === 'D:\\' || normalized === 'C:\\' || normalized === '\\' || normalized === '/' || normalized === '~';
  const view: WorkspaceDirs = {
    root: WORK_ROOT,
    path: normalized,
    parent: parentDir(normalized),
    selectable: !blocked && !isFsRoot,
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
  if (isBlockedPath(wsPath)) {
    return fail(400, lang === 'en' ? 'Path is not allowed' : '目录不允许访问', 'E_PATH');
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
    kind: 'project',
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

function evaluateGlabBinary(customPath: string): GlabBinaryInfo {
  if (customPath) {
    if (customPath.toLowerCase().includes('missing')) {
      return {
        source: 'missing',
        version: '',
        path: customPath,
      };
    }
    return {
      source: 'custom',
      version: '1.46.1',
      path: customPath,
    };
  }
  return {
    source: 'bundled',
    version: '1.46.1',
    path: '/usr/local/bin/glab',
  };
}

function persistProtoGlab(glab: GlabSettings): void {
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem('weft_proto_glab', JSON.stringify(glab));
    } catch {
      // ignore
    }
  }
}

function computeNextRun(rule: ScheduleRule, from = Date.now()): number | null {
  if (rule.kind === 'once') {
    return rule.at > from ? rule.at : null;
  }
  if (rule.kind === 'interval') {
    return from + rule.everyMinutes * 60 * 1000;
  }
  if (rule.kind === 'daily') {
    const parts = rule.time.split(':').map(Number);
    const h = parts[0] || 0;
    const m = parts[1] || 0;
    const target = new Date(from);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= from) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }
  if (rule.kind === 'weekly') {
    const parts = rule.time.split(':').map(Number);
    const h = parts[0] || 0;
    const m = parts[1] || 0;
    const days = rule.days || [];
    for (let offset = 0; offset <= 7; offset++) {
      const d = new Date(from + offset * 86400000);
      d.setHours(h, m, 0, 0);
      const dayOfWeek = d.getDay() === 0 ? 7 : d.getDay();
      if (days.includes(dayOfWeek) && d.getTime() > from) {
        return d.getTime();
      }
    }
    return from + 86400000;
  }
  return null;
}

function validateScheduleInput(
  input: {
    name?: unknown;
    message?: unknown;
    target?: unknown;
    rule?: unknown;
  },
  isPatch = false,
  lang: Lang = 'zh',
): { valid: boolean; fields: string[]; error: string } {
  const fields: string[] = [];
  const errors: string[] = [];

  if (!isPatch || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      fields.push('name');
      errors.push(lang === 'en' ? 'Name is required' : '任务名称不能为空');
    }
  }

  if (!isPatch || input.message !== undefined) {
    if (typeof input.message !== 'string' || !input.message.trim()) {
      fields.push('message');
      errors.push(lang === 'en' ? 'Message is required' : '消息内容不能为空');
    }
  }

  if (!isPatch || input.target !== undefined) {
    const target = input.target as Record<string, unknown> | undefined;
    if (!target || typeof target !== 'object') {
      fields.push('target');
      errors.push(lang === 'en' ? 'Target is required' : '目标不能为空');
    } else if (target.kind === 'conversation') {
      if (typeof target.conversationId !== 'string' || !target.conversationId) {
        fields.push('target.conversationId');
        errors.push(lang === 'en' ? 'Conversation is required' : '请选择目标对话');
      }
    } else if (target.kind === 'new') {
      if (typeof target.workspaceId !== 'string' || !target.workspaceId) {
        fields.push('target.workspaceId');
        errors.push(lang === 'en' ? 'Workspace is required' : '请选择工作区');
      }
    } else {
      fields.push('target.kind');
      errors.push(lang === 'en' ? 'Invalid target kind' : '无效的目标类型');
    }
  }

  if (!isPatch || input.rule !== undefined) {
    const rule = input.rule as Record<string, unknown> | undefined;
    if (!rule || typeof rule !== 'object') {
      fields.push('rule');
      errors.push(lang === 'en' ? 'Rule is required' : '时间规则不能为空');
    } else if (rule.kind === 'interval') {
      const minutes = Number(rule.everyMinutes);
      if (isNaN(minutes) || minutes < 5) {
        fields.push('rule.everyMinutes');
        errors.push(lang === 'en' ? 'Interval must be at least 5 minutes' : '间隔不能少于 5 分钟');
      }
    } else if (rule.kind === 'weekly') {
      if (!Array.isArray(rule.days) || rule.days.length === 0) {
        fields.push('rule.days');
        errors.push(lang === 'en' ? 'Please select at least one day' : '每周请至少选择一天');
      }
      if (typeof rule.time !== 'string' || !/^\d{2}:\d{2}$/.test(rule.time)) {
        fields.push('rule.time');
        errors.push(lang === 'en' ? 'Time is required' : '时间格式无效');
      }
    } else if (rule.kind === 'daily') {
      if (typeof rule.time !== 'string' || !/^\d{2}:\d{2}$/.test(rule.time)) {
        fields.push('rule.time');
        errors.push(lang === 'en' ? 'Time is required' : '时间格式无效');
      }
    } else if (rule.kind === 'once') {
      const at = Number(rule.at);
      if (isNaN(at) || at <= 0) {
        fields.push('rule.at');
        errors.push(lang === 'en' ? 'Invalid timestamp' : '时间戳无效');
      }
    } else {
      fields.push('rule.kind');
      errors.push(lang === 'en' ? 'Invalid rule kind' : '无效的时间规则类型');
    }
  }

  return {
    valid: fields.length === 0,
    fields,
    error: errors.join('; ') || (lang === 'en' ? 'Invalid schedule fields' : '字段校验失败'),
  };
}

function executeSchedule(
  db: MockDb,
  hub: MockHub,
  schedule: Schedule,
  lang: Lang,
): ScheduleRun {
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const run: ScheduleRun = {
    id: runId,
    at: Date.now(),
    status: 'ok',
    conversationId: null,
    error: null,
  };

  const target = schedule.target;
  if (target.kind === 'conversation') {
    const conv = db.conversations.get(target.conversationId);
    if (conv) {
      run.conversationId = conv.view.id;
      sendMessage(db, conv, hub, schedule.message, `req-sched-${Date.now()}`);
    } else {
      run.status = 'failed';
      run.error = lang === 'en' ? 'Target conversation not found' : '目标对话不存在';
    }
  } else if (target.kind === 'new') {
    const ws = db.workspaces.find((w) => w.id === target.workspaceId) || db.workspaces[0];
    const wsId = ws ? ws.id : 'ws-weft';
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const title = `${schedule.name} · ${mm}/${dd} ${hh}:${min}`;
    const newCid = `c-sched-${Date.now()}`;

    const model = target.model || db.defaultModel;
    const provider = db.providers.find((row) => row.id === model?.providerId);
    const found = provider?.models.find((row) => row.id === model?.modelId);
    const window = found?.contextWindow || 200_000;

    const conv: MockConv = {
      view: {
        id: newCid,
        workspaceId: wsId,
        title,
        updatedAt: Date.now(),
        status: 'idle',
        model: model && found
          ? { sourceId: model.providerId, modelId: model.modelId, label: modelLabel(db, model) }
          : null,
        thinkingLevel: found ? (found.defaultThinkingLevel ?? null) : null,
        run: {
          status: 'idle',
          startedAt: null,
          pendingText: null,
          canSend: true,
          canStop: false,
          lockedReason: null,
          error: null,
          lastActivityAt: null,
          stalledSince: null,
          activeTool: null,
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

    db.conversations.set(newCid, conv);
    publishSummary(db, hub, newCid);
    run.conversationId = newCid;
    sendMessage(db, conv, hub, schedule.message, `req-sched-${Date.now()}`);
  }

  schedule.lastRun = run;
  const runs = db.scheduleRuns.get(schedule.id) || [];
  runs.unshift(run);
  if (runs.length > 20) runs.length = 20;
  db.scheduleRuns.set(schedule.id, runs);
  hub.publish('schedules', { event: 'upsert', entity: 'schedule', id: schedule.id, value: schedule });

  return run;
}

/* ---------- routing ---------- */

/** Route one mock HTTP call. Unknown `/api` paths answer 404 so the UI can show a message. */
export function handleMockRequest(
  db: MockDb,
  hub: MockHub,
  rawUrl: string,
  init?: RequestInit,
): MockReply | Promise<MockReply> {
  let url: URL;
  try {
    url = new URL(rawUrl, 'file:///');
  } catch {
    return fail(400, 'bad url');
  }
  const path = mockPathname(url).replace(/\/+$/, '') || '/';
  const method = String(init?.method || 'GET').toUpperCase();
  const body = readBody(init);
  const lang = langOf(url);

  if (path === '/api/settings') {
    if (method === 'PUT') return ok({ ok: true });
    return ok({});
  }

  if (path === '/api/v2/settings') {
    if (method === 'PUT') {
      const next = body.compaction as { triggerPercent?: unknown } | undefined;
      if (next !== undefined) {
        const n = next?.triggerPercent;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 60 || n > 90) {
          return fail(
            400,
            lang === 'en' ? 'triggerPercent must be an integer from 60 to 90' : 'triggerPercent 必须是 60 到 90 的整数',
            'E_BAD_REQUEST',
          );
        }
        db.settings.compaction.triggerPercent = n;
      }
    }
    return ok({
      compaction: {
        ...db.settings.compaction,
        effective: mockEffectiveTriggers(db.providers, db.settings.compaction.triggerPercent),
      },
    });
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

  if (path === '/api/v2/diagnostics/report' && method === 'POST') {
    const req = body as unknown as components['schemas']['DiagnosticsReportRequest'];
    if (req.conversationId && !getConv(db, req.conversationId)) {
      return fail(404, lang === 'en' ? 'Conversation not found' : '对话不存在', 'E_NOT_FOUND');
    }
    return {
      status: 200,
      bytes: buildMockReport(db, req, SERVICE_VERSION),
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="weft-report.zip"',
      },
    };
  }

  /* ---- providers ---- */
  if (path === '/api/v2/providers' && method === 'GET') {
    return ok({
      providers: db.providers.map((provider) => providerView(provider, lang)),
      defaultModel: db.defaultModel,
    });
  }
  if (path === '/api/v2/providers/available' && method === 'GET') {
    const connectedIds = new Set(db.providers.map((p) => p.id));
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const noLocalGrok = search.includes('no-local-grok') || search.includes('grok=oauth');
    const list = MOCK_AVAILABLE_PROVIDERS.map((item) => {
      let localLogin = item.localLogin;
      if (item.id === 'xai' && noLocalGrok) {
        localLogin = { detected: false };
      }
      return {
        ...item,
        localLogin,
        name: mockProviderName(item.id, item.name, lang),
        connected: connectedIds.has(item.id),
      };
    });
    return ok({
      providers: sortAvailableProviders(list),
    });
  }
  if (path === '/api/v2/providers/custom' && method === 'POST') {
    return handleCustomProvider(db, hub, body, lang);
  }

  const connectMatch = /^\/api\/v2\/providers\/([^/]+)\/connect$/.exec(path);
  if (connectMatch && method === 'POST') {
    const id = decodeURIComponent(connectMatch[1]);
    return handleConnect(db, hub, id, body, lang);
  }

  const loginSessionMatch = /^\/api\/v2\/login-sessions\/([^/]+)$/.exec(path);
  if (loginSessionMatch && method === 'GET') {
    const sid = decodeURIComponent(loginSessionMatch[1]);
    const sessionRec = db.loginSessions.get(sid);
    if (!sessionRec) return fail(404, 'Login session not found');
    sessionRec.pollCount += 1;
    if (sessionRec.session.providerId === 'xai') {
      const hasDevice = sessionRec.session.events?.some((e) => e.type === 'device_code');
      if (!hasDevice) {
        sessionRec.session.events = [
          {
            type: 'device_code',
            userCode: 'WFT-7Q2K',
            verificationUri: 'https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K',
          },
          ...(sessionRec.session.events || []),
        ];
      }
    }
    if (sessionRec.pollCount >= 3 && sessionRec.session.state === 'pending') {
      sessionRec.session.state = 'done';
      const id = sessionRec.session.providerId;
      const avail = MOCK_AVAILABLE_PROVIDERS.find((p) => p.id === id);
      const catModels = MOCK_CATALOG_MODELS[id] || [];
      const autoEnable = catModels.length <= 6;
      const provider: Provider = {
        id,
        kind: 'builtin',
        brand: avail?.name || id,
        name: avail?.name || id,
        auth: { type: 'oauth', account: 'user@example.com' },
        status: { state: 'ok', testedAt: Date.now() },
        models: catModels.map((m) => ({ ...m, enabled: autoEnable })),
      };
      const idx = db.providers.findIndex((p) => p.id === id);
      if (idx >= 0) db.providers[idx] = provider;
      else db.providers.push(provider);
      if (!db.defaultModel && provider.models.some((m) => m.enabled)) {
        const first = provider.models.find((m) => m.enabled);
        if (first) db.defaultModel = { providerId: id, modelId: first.id };
      }
      publishProviders(db, hub);
    }
    return ok({ session: sessionRec.session });
  }

  const loginAnswerMatch = /^\/api\/v2\/login-sessions\/([^/]+)\/answer$/.exec(path);
  if (loginAnswerMatch && method === 'POST') {
    const sid = decodeURIComponent(loginAnswerMatch[1]);
    const sessionRec = db.loginSessions.get(sid);
    if (!sessionRec) return fail(404, 'Login session not found');
    return ok({ session: sessionRec.session });
  }

  const loginCancelMatch = /^\/api\/v2\/login-sessions\/([^/]+)\/cancel$/.exec(path);
  if (loginCancelMatch && method === 'POST') {
    const sid = decodeURIComponent(loginCancelMatch[1]);
    const sessionRec = db.loginSessions.get(sid);
    if (!sessionRec) return fail(404, 'Login session not found');
    sessionRec.session.state = 'cancelled';
    return ok({ session: sessionRec.session });
  }

  const providerTestMatch = /^\/api\/v2\/providers\/([^/]+)\/test$/.exec(path);
  if (providerTestMatch && method === 'POST') {
    const id = decodeURIComponent(providerTestMatch[1]);
    const provider = db.providers.find((row) => row.id === id);
    if (!provider) return fail(404, 'Provider 不存在');
    let fails = false;
    if (provider.auth.type === 'api_key' && (provider.auth.keyTail?.includes('9f01') || provider.auth.keyTail?.includes('bad'))) {
      fails = true;
    }
    if (provider.baseUrl && (provider.baseUrl.includes('10.8.0.12') || provider.baseUrl.includes('bad'))) {
      fails = true;
    }
    if (provider.auth.type === 'api_key' && provider.auth.keyTail && /bad/i.test(provider.auth.keyTail)) {
      fails = true;
    }
    if (fails) {
      provider.status = {
        state: 'error',
        error: lang === 'en' ? '401 Unauthorized: Invalid API key or endpoint' : '401 未授权：API Key 或接口地址无效',
        testedAt: Date.now(),
      };
      publishProviders(db, hub);
      return ok({ ok: false, error: provider.status.error });
    }
    provider.status = { state: 'ok', testedAt: Date.now() };
    publishProviders(db, hub);
    return ok({ ok: true, models: provider.models });
  }

  const providerMatch = /^\/api\/v2\/providers\/([^/]+)$/.exec(path);
  if (providerMatch) {
    const id = decodeURIComponent(providerMatch[1]);
    const provider = db.providers.find((row) => row.id === id);
    if (!provider) return fail(404, 'Provider 不存在');
    if (method === 'PATCH') return handlePatchProvider(db, hub, provider, body, lang);
    if (method === 'GET') return ok({ provider: providerView(provider, lang) });
    if (method === 'DELETE') {
      db.providers = db.providers.filter((row) => row.id !== id);
      publishProviderGone(hub, id);
      if (db.defaultModel?.providerId === id) {
        const next = db.providers.find((row) => row.models.some((m) => m.enabled));
        const nextModel = next?.models.find((m) => m.enabled);
        db.defaultModel = next && nextModel ? { providerId: next.id, modelId: nextModel.id } : null;
      }
      publishProviders(db, hub);
      return noContent();
    }
  }

  /* ---- schedules ---- */
  if (path === '/api/v2/schedules' && method === 'GET') {
    return ok({ schedules: [...db.schedules.values()] });
  }

  if (path === '/api/v2/schedules' && method === 'POST') {
    const val = validateScheduleInput(body, false, lang);
    if (!val.valid) {
      return fail(400, val.error, 'E_INVALID_SCHEDULE', { fields: val.fields });
    }
    const id = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const enabled = body.enabled !== false;
    const rule = body.rule as ScheduleRule;
    const target = body.target as ScheduleTarget;
    const schedule: Schedule = {
      id,
      name: String(body.name).trim(),
      message: String(body.message).trim(),
      target,
      rule,
      enabled,
      createdBy: 'user',
      nextRunAt: enabled ? computeNextRun(rule) : null,
      lastRun: null,
    };
    db.schedules.set(id, schedule);
    db.scheduleRuns.set(id, []);
    hub.publish('schedules', { event: 'upsert', entity: 'schedule', id, value: schedule });
    return created(schedule);
  }

  const schedRunsMatch = /^\/api\/v2\/schedules\/([^/]+)\/runs$/.exec(path);
  if (schedRunsMatch && method === 'GET') {
    const id = decodeURIComponent(schedRunsMatch[1]);
    const schedule = db.schedules.get(id);
    if (!schedule) return fail(404, lang === 'en' ? 'Schedule not found' : '定时任务不存在');
    const runs = db.scheduleRuns.get(id) || [];
    return ok({ runs });
  }

  const schedRunMatch = /^\/api\/v2\/schedules\/([^/]+)\/run$/.exec(path);
  if (schedRunMatch && method === 'POST') {
    const id = decodeURIComponent(schedRunMatch[1]);
    const schedule = db.schedules.get(id);
    if (!schedule) return fail(404, lang === 'en' ? 'Schedule not found' : '定时任务不存在');
    const run = executeSchedule(db, hub, schedule, lang);
    return ok(run);
  }

  const schedMatch = /^\/api\/v2\/schedules\/([^/]+)$/.exec(path);
  if (schedMatch) {
    const id = decodeURIComponent(schedMatch[1]);
    const schedule = db.schedules.get(id);
    if (!schedule) return fail(404, lang === 'en' ? 'Schedule not found' : '定时任务不存在');

    if (method === 'PATCH') {
      const val = validateScheduleInput(body, true, lang);
      if (!val.valid) {
        return fail(400, val.error, 'E_INVALID_SCHEDULE', { fields: val.fields });
      }
      if (body.name !== undefined) schedule.name = String(body.name).trim();
      if (body.message !== undefined) schedule.message = String(body.message).trim();
      if (body.target !== undefined) schedule.target = body.target as ScheduleTarget;
      if (body.rule !== undefined) schedule.rule = body.rule as ScheduleRule;
      if (body.enabled !== undefined) schedule.enabled = Boolean(body.enabled);
      schedule.nextRunAt = schedule.enabled ? computeNextRun(schedule.rule) : null;

      hub.publish('schedules', { event: 'upsert', entity: 'schedule', id: schedule.id, value: schedule });
      return ok(schedule);
    }

    if (method === 'DELETE') {
      db.schedules.delete(id);
      db.scheduleRuns.delete(id);
      hub.publish('schedules', { event: 'remove', entity: 'schedule', id });
      return ok({ ok: true, id });
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
  if (path === '/api/v2/workspace-root/pick' && method === 'POST') {
    return mockPickWorkspaceFolder(lang);
  }
  if (path === '/api/v2/workspace-root/dirs' && method === 'GET') {
    return dirsView(url.searchParams.get('path') || WORK_ROOT, lang);
  }

  if (path === '/api/v2/conversations' && method === 'POST') {
    return createConversation(db, hub, null, String(body.title || ''));
  }
  const wsConvMatch = /^\/api\/v2\/workspaces\/([^/]+)\/conversations$/.exec(path);
  if (wsConvMatch && method === 'POST') {
    const workspaceId = decodeURIComponent(wsConvMatch[1]);
    return createConversation(db, hub, workspaceId, String(body.title || ''));
  }
  const wsOpenTermMatch = /^\/api\/v2\/workspaces\/([^/]+)\/open-terminal$/.exec(path);
  if (wsOpenTermMatch && method === 'POST') {
    const workspaceId = decodeURIComponent(wsOpenTermMatch[1]);
    const ws = db.workspaces.find((row) => row.id === workspaceId);
    const repo = db.repos.get(workspaceId);
    if (!ws || !repo) return fail(404, lang === 'en' ? 'Workspace not found' : '工作区不存在');
    const raw = typeof body.path === 'string' ? body.path : '';
    const rel = posixPath(raw);
    if (
      rel.split('/').includes('..')
      || rel.includes('..')
      || /^[a-zA-Z]:/.test(raw.trim())
      || raw.trim().startsWith('/')
      || raw.trim().startsWith('\\')
    ) {
      return fail(400, lang === 'en' ? 'Path is outside the workspace' : '路径超出工作区', 'E_PATH');
    }
    if (rel) {
      const node = repoTree(repo).entries.find((row) => row.path === rel);
      if (!node || node.type !== 'dir') {
        return fail(400, lang === 'en' ? 'Only directories can be opened' : '只能打开目录', 'E_PATH');
      }
    }
    return ok({
      opened: true,
      message: lang === 'en'
        ? 'Opened in the system terminal (prototype does not launch it)'
        : '已在系统终端中打开（原型不会真的打开）',
    });
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
    const dir = url.searchParams.get('dir');
    if (dir == null || dir.trim() === '') return ok(repoTree(repo));
    const listed = queryRepoTree(repo, dir);
    if (!listed.ok) return fail(listed.status, listed.error, listed.code);
    return ok(listed.tree);
  }
  const wsSearchMatch = /^\/api\/v2\/workspaces\/([^/]+)\/file-search$/.exec(path);
  if (wsSearchMatch && method === 'GET') {
    const workspaceId = decodeURIComponent(wsSearchMatch[1]);
    const repo = db.repos.get(workspaceId);
    if (!repo) return fail(404, '工作区不存在');
    return ok(searchRepoFiles(repo, url.searchParams.get('q') ?? '', url.searchParams.get('limit')));
  }
  const wsRawMatch = /^\/api\/v2\/workspaces\/([^/]+)\/files\/raw$/.exec(path);
  if (wsRawMatch && method === 'GET') {
    const workspaceId = decodeURIComponent(wsRawMatch[1]);
    const repo = db.repos.get(workspaceId);
    if (!repo) return fail(404, lang === 'en' ? 'Workspace not found' : '工作区不存在');
    const raw = url.searchParams.get('path');
    if (raw == null || raw === '') return fail(400, 'path required', 'E_BAD_REQUEST');
    const result = readRepoFileRaw(repo, raw);
    if (!isRawFileHit(result)) return fail(result.status, result.error, result.code);
    const headers: Record<string, string> = {
      'content-type': result.mediaType,
      'content-disposition': 'inline',
      'cache-control': 'private, no-cache',
      etag: result.etag,
      'x-content-type-options': 'nosniff',
    };
    if (result.mediaType === 'image/svg+xml') {
      headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }
    const inm = requestHeader(init, 'if-none-match');
    if (inm && inm.split(',').map((part) => part.trim()).includes(result.etag)) {
      return { status: 304, headers };
    }
    return { status: 200, bytes: result.bytes, headers };
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
        const next = {
          path: saved.path,
          added: saved.added,
          removed: saved.removed,
          error: null,
          by: change?.by ?? null,
        };
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

  const wsUploadMatch = /^\/api\/v2\/workspaces\/([^/]+)\/uploads$/.exec(path);
  if (wsUploadMatch && method === 'POST') {
    const workspaceId = decodeURIComponent(wsUploadMatch[1]);
    const ws = db.workspaces.find((row) => row.id === workspaceId);
    if (!ws) return fail(404, '工作区不存在');
    const { name, data } = body as { name?: string; data?: unknown };
    if (!data || typeof data !== 'string') return fail(400, 'data required', 'E_BAD_REQUEST');
    let decodedLen = 0;
    try {
      decodedLen = atob(data).length;
    } catch {
      return fail(400, 'invalid base64 data', 'E_BAD_REQUEST');
    }
    if (decodedLen > 20 * 1024 * 1024) {
      return fail(413, `file exceeds ${20 * 1024 * 1024} bytes`, 'E_TOO_LARGE');
    }
    const cleanName = (typeof name === 'string' && name ? name : 'file')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/^\.+/, '') || 'file';
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 8);
    const uploadPath = `.weft/uploads/${stamp}-${rand}/${cleanName}`;
    const mediaType = 'application/octet-stream';
    const uploadResult = {
      path: uploadPath,
      name: cleanName,
      bytes: decodedLen,
      mediaType,
    };
    db.workspaceUploads.set(`${workspaceId}\t${uploadPath}`, uploadResult);
    return created(uploadResult);
  }

  const wsMatch = /^\/api\/v2\/workspaces\/([^/]+)$/.exec(path);
  if (wsMatch && method === 'DELETE') {
    return removeWorkspace(db, hub, decodeURIComponent(wsMatch[1]));
  }

  /* ---- extensions ---- */
  if (path === '/api/v2/plugins' && method === 'GET') {
    return ok({ plugins: db.plugins.map((plugin) => pluginForLang(plugin, lang)) });
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

  /* ---- glab ---- */
  if (path === '/api/v2/glab' && method === 'GET') {
    return ok(db.glab);
  }
  if (path === '/api/v2/glab' && method === 'PATCH') {
    if (typeof body.enabled === 'boolean') {
      db.glab.enabled = body.enabled;
    }
    if (typeof body.customPath === 'string') {
      db.glab.customPath = body.customPath.trim();
      db.glab.binary = evaluateGlabBinary(db.glab.customPath);
    }
    if (Array.isArray(body.connectionIds)) {
      db.glab.connectionIds = body.connectionIds.filter((id): id is string => typeof id === 'string');
    }
    if ('defaultConnectionId' in body) {
      db.glab.defaultConnectionId = typeof body.defaultConnectionId === 'string' ? body.defaultConnectionId : null;
    }
    if (db.glab.connectionIds.length > 0) {
      if (!db.glab.defaultConnectionId || !db.glab.connectionIds.includes(db.glab.defaultConnectionId)) {
        db.glab.defaultConnectionId = db.glab.connectionIds[0];
      }
    } else {
      db.glab.defaultConnectionId = null;
    }
    persistProtoGlab(db.glab);
    return ok(db.glab);
  }
  if (path === '/api/v2/glab/detect' && method === 'POST') {
    if (typeof body.customPath === 'string') {
      db.glab.customPath = body.customPath.trim();
    }
    db.glab.binary = evaluateGlabBinary(db.glab.customPath);
    persistProtoGlab(db.glab);
    return ok(db.glab);
  }
  if (path === '/api/v2/glab/test' && method === 'POST') {
    const connId = db.glab.defaultConnectionId || db.glab.connectionIds[0];
    const conn = connId ? db.gitConnections.find((c) => c.id === connId) : null;
    if (!conn) {
      return ok({
        ok: false,
        host: '',
        username: '',
        output: lang === 'en' ? 'No connection selected' : '未选择连接',
      });
    }
    if (conn.lastTest && conn.lastTest.ok === false) {
      return ok({
        ok: false,
        host: conn.baseUrl,
        username: conn.lastTest.username || '',
        output: conn.lastTest.errorText || (lang === 'en' ? 'Authentication failed' : '认证失败'),
      });
    }
    let host = conn.baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!host) host = 'gitlab.intra.local';
    const username = conn.lastTest?.username || 'lawrence';
    return ok({
      ok: true,
      host,
      username,
      output: `Logged in to ${host} as ${username} (/etc/glab-cli/config.yml)`,
    });
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
    if (!conv) return fail(404, lang === 'en' ? 'Conversation not found' : '对话不存在');
    if (method === 'GET') return ok(conversationSnapshot(conv, lang));
    if (method === 'PATCH') return patchConversation(db, hub, conv, body);
    if (method === 'DELETE') return deleteConversation(db, hub, conv, lang);
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

  const pasteMatch = /^\/api\/v2\/conversations\/([^/]+)\/messages\/([^/]+)\/pastes\/([^/]+)$/.exec(path);
  if (pasteMatch && method === 'GET') {
    const cid = decodeURIComponent(pasteMatch[1]);
    const messageId = decodeURIComponent(pasteMatch[2]);
    const indexRaw = decodeURIComponent(pasteMatch[3]);
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 0 || String(index) !== indexRaw) {
      return fail(404, 'not found');
    }
    const text = db.messagePastes.get(`${cid}\t${messageId}\t${index}`);
    if (text == null) return fail(404, 'not found');
    return {
      status: 200,
      bytes: new TextEncoder().encode(text),
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'private, max-age=31536000, immutable',
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
    const files = Array.isArray(body.files) ? (body.files as components['schemas']['SendMessageFile'][]) : undefined;
    const pastes = Array.isArray(body.pastes) ? (body.pastes as string[]) : undefined;

    const answer = body.answer as components['schemas']['AskAnswerRequest'] | undefined;
    if (answer != null) {
      if (typeof answer !== 'object' || Array.isArray(answer)) {
        return fail(400, 'invalid answer', 'E_BAD_REQUEST');
      }
      if (parsedImages.images.length || (files && files.length > 0) || (pastes && pastes.length > 0)) {
        return fail(400, 'answer cannot include attachments', 'E_BAD_REQUEST');
      }
      const tool = conv.tools[answer.toolCallId];
      if (!tool || !tool.ask) {
        return fail(400, '提问不存在', 'E_BAD_REQUEST');
      }
      if (tool.ask.answer != null) {
        return fail(409, 'already answered', 'E_ASK_ANSWERED');
      }
      const skipped = Boolean(answer.skipped);
      tool.ask.answer = {
        answers: skipped ? [] : (answer.answers || []),
        skipped,
      };
      if (skipped) {
        tool.hint = { zh: '已跳过', en: 'Skipped' };
      } else {
        const parts: string[] = [];
        for (const ans of tool.ask.answer.answers) {
          const items = [...ans.selected, ...(ans.other ? [ans.other] : [])];
          if (items.length) parts.push(items.join(', '));
        }
        const summary = parts.join('；') || '已回答';
        tool.hint = { zh: summary, en: summary };
      }
      const group = conv.items.find((item) => item.kind === 'tool_group' && item.toolIds.includes(tool.id));
      const groupId = group && group.kind === 'tool_group' ? group.id : `group:${tool.id}`;
      publishTool(conv, hub, tool, groupId);
      touch(conv);
      publishConversationView(conv, hub);
      publishSummary(db, hub, conv.view.id);
      return accepted({ runId: nextId(db, 'run') });
    }

    if (!text && parsedImages.images.length === 0 && (!files || files.length === 0) && (!pastes || pastes.length === 0)) {
      return fail(400, '消息不能为空', 'E_BAD_REQUEST');
    }

    for (const t of Object.values(conv.tools)) {
      if (t.ask && t.ask.answer === null) {
        t.ask.answer = { answers: [], skipped: true };
        t.hint = { zh: '已跳过', en: 'Skipped' };
        const g = conv.items.find((item) => item.kind === 'tool_group' && item.toolIds.includes(t.id));
        const gid = g && g.kind === 'tool_group' ? g.id : `group:${t.id}`;
        publishTool(conv, hub, t, gid);
      }
    }

    const requestId = typeof body.requestId === 'string' && body.requestId
      ? body.requestId
      : nextId(db, 'req');
    const mode = body.mode === 'queue' ? 'queue' : body.mode === 'steer' || body.mode == null || body.mode === ''
      ? 'steer'
      : null;
    if (mode == null) return fail(400, 'invalid mode', 'E_BAD_REQUEST');
    if (conv.archived) {
      conv.archived = false;
      publishSummary(db, hub, conv.view.id);
    }
    const result = sendMessage(db, conv, hub, text, requestId, parsedImages.images, mode, files, pastes);
    if (!result.ok) return fail(result.status, result.error);
    return accepted({ runId: result.runId });
  }
  const withdrawMatch = /^\/api\/v2\/conversations\/([^/]+)\/messages\/([^/]+)$/.exec(path);
  if (withdrawMatch && method === 'DELETE') {
    const cid = decodeURIComponent(withdrawMatch[1]);
    const requestId = decodeURIComponent(withdrawMatch[2]);
    const conv = getConv(db, cid);
    if (!conv) return fail(404, '对话不存在');
    const result = withdrawMessage(db, conv, hub, requestId);
    if (result === 'missing') return fail(404, 'not found');
    if (result === 'landed') return fail(409, 'already landed', 'E_ALREADY_LANDED');
    return ok({ ok: true });
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
    if (!conv) return fail(404, lang === 'en' ? 'Conversation not found' : '对话不存在');
    const result = continueConversation(db, conv, hub, lang);
    if (!result.ok) {
      return fail(result.status, result.error, result.code);
    }
    return accepted({ runId: result.runId });
  }
  const compactMatch = /^\/api\/v2\/conversations\/([^/]+)\/compact$/.exec(path);
  if (compactMatch && method === 'POST') {
    const conv = getConv(db, decodeURIComponent(compactMatch[1]));
    if (!conv) return fail(404, lang === 'en' ? 'Conversation not found' : '对话不存在');
    if (body.instructions !== undefined && typeof body.instructions !== 'string') {
      return fail(400, 'instructions must be a string', 'E_BAD_REQUEST');
    }
    const result = compactConversation(db, conv, hub);
    if (!result.ok) return fail(result.status, result.error, result.code);
    return accepted({ taskId: result.taskId });
  }
  const handoffMatch = /^\/api\/v2\/conversations\/([^/]+)\/handoff$/.exec(path);
  if (handoffMatch && method === 'POST') {
    const conv = getConv(db, decodeURIComponent(handoffMatch[1]));
    if (!conv) return fail(404, lang === 'en' ? 'Conversation not found' : '对话不存在');
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    const instructions = typeof body.instructions === 'string' && body.instructions.trim()
      ? body.instructions.trim()
      : undefined;
    const result = handoffConversation(db, conv, hub, requestId, lang, instructions);
    if (!result.ok) return fail(result.status, result.error, result.code);
    return accepted({ ok: true });
  }
  const forkMatch = /^\/api\/v2\/conversations\/([^/]+)\/fork$/.exec(path);
  if (forkMatch && method === 'POST') {
    const conv = getConv(db, decodeURIComponent(forkMatch[1]));
    if (!conv) return fail(404, lang === 'en' ? 'Conversation not found' : '对话不存在');
    return forkConversation(db, hub, conv, body, lang);
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

  if (path === '/api/v2/client-log' && method === 'POST') return noContent();

  if (path === '/api/v2/events') return fail(400, '事件流要走 EventSource');

  return fail(404, `原型没有这个接口：${method} ${path}`);
}

/** Everything the prototype serves, wrapped in a real `Response`. */
export async function mockResponse(db: MockDb, hub: MockHub, rawUrl: string, init?: RequestInit): Promise<Response> {
  const reply = await handleMockRequest(db, hub, rawUrl, init);
  if (reply.status === 204 || reply.status === 304) {
    return new Response(null, {
      status: reply.status,
      headers: reply.headers,
    });
  }
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
