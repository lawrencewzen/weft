import type { MockHub } from './hub';
import {
  getConv,
  nextId,
  publishConversationView,
  publishProviders,
  publishRemove,
  publishSummary,
  publishWorkspaces,
  recomputeContext,
  touch,
} from './db';
import { continueConversation, sendMessage, stopConversation } from './run';
import {
  conversationValue,
  itemValue,
  summaryOf,
  toolValue,
} from './views';
import type {
  ConversationSummary,
  EntityValue,
  Lang,
  MockConv,
  MockDb,
  Provider,
  ResolvedModel,
  ThreadItem,
  ToolCall,
  Workspace,
} from './types';

export type MockReply = { status: number; body: unknown };

const SERVICE_VERSION = '0.1.0-prototype';
const STARTED_AT = Date.now();

function ok(body: unknown): MockReply {
  return { status: 200, body };
}

function created(body: unknown): MockReply {
  return { status: 201, body };
}

function accepted(body: unknown): MockReply {
  return { status: 202, body };
}

function fail(status: number, error: string, code?: string): MockReply {
  return { status, body: code ? { error, code } : { error } };
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

function modelLabel(db: MockDb, model: ResolvedModel | null): string {
  if (!model) return '';
  const provider = db.providers.find((row) => row.id === model.providerId);
  const found = provider?.models.find((row) => row.id === model.modelId);
  return found?.displayName || model.modelId;
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

function providerView(provider: Provider): Provider {
  return { ...provider, models: provider.models.map((model) => ({ ...model })) };
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
      model: model
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
  const key = `${providerId}:${modelId}`;
  if (window == null) {
    model.contextWindow = db.defaultWindows.get(key) || model.contextWindow;
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

function patchProvider(
  db: MockDb,
  hub: MockHub,
  provider: Provider,
  body: Record<string, unknown>,
): MockReply {
  if (typeof body.name === 'string' && body.name.trim()) provider.name = body.name.trim();
  if (typeof body.baseUrl === 'string') provider.baseUrl = body.baseUrl;
  if (body.defaultModel === null) {
    if (db.defaultModel?.providerId === provider.id) db.defaultModel = null;
  } else if (typeof body.defaultModel === 'string' && body.defaultModel) {
    db.defaultModel = { providerId: provider.id, modelId: body.defaultModel };
  }
  for (const row of db.providers) row.isDefault = db.defaultModel?.providerId === row.id;
  publishProviders(db, hub);
  return ok(providerView(provider));
}

const GROK_SESSION = () => ({
  signedIn: true,
  account: 'demo@weft.local',
  email: null,
  expiresAt: STARTED_AT + 86_400_000,
  authMode: 'oidc',
  source: 'prototype',
  pending: null,
});

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

  if (path === '/api/v2/providers' && method === 'GET') {
    return ok({
      providers: db.providers.map((provider) => providerView(provider)),
      vendors: db.vendors,
      defaultModel: db.defaultModel,
    });
  }

  if (path === '/api/v2/providers/test' && method === 'POST') {
    return ok({ ok: true, models: ['grok-4.6', 'grok-4'], status: 'ok', statusText: '' });
  }

  if (path === '/api/v2/providers/grok/session' && method === 'GET') {
    return ok(GROK_SESSION());
  }
  if (path.startsWith('/api/v2/providers/grok/login') && method === 'POST') {
    if (path.endsWith('/cancel') || path.endsWith('/logout')) return ok(GROK_SESSION());
    return fail(400, '原型不联网，已视为登录 Grok');
  }

  const contextMatch = /^\/api\/v2\/providers\/([^/]+)\/models\/([^/]+)\/context-window$/.exec(path);
  if (contextMatch && method === 'PUT') {
    const providerId = decodeURIComponent(contextMatch[1]);
    const modelId = decodeURIComponent(contextMatch[2]);
    const window = body.window === null ? null : Number(body.window);
    return setContextWindow(db, hub, providerId, modelId, Number.isFinite(window as number) ? window as number : null);
  }

  const providerMatch = /^\/api\/v2\/providers\/([^/]+)$/.exec(path);
  if (providerMatch) {
    const id = decodeURIComponent(providerMatch[1]);
    const provider = db.providers.find((row) => row.id === id);
    if (!provider) return fail(404, 'Provider 不存在');
    if (method === 'PATCH') return patchProvider(db, hub, provider, body);
    if (method === 'DELETE') return fail(400, '原型暂不支持删除 Provider');
    if (method === 'GET') return ok(providerView(provider));
  }
  if (path === '/api/v2/providers' && method === 'POST') {
    return fail(400, '原型暂不支持添加 Provider');
  }

  if (path === '/api/v2/workspaces' && method === 'GET') {
    return ok({ workspaces: db.workspaces, conversations: [...db.conversations.values()].map(summaryOf) });
  }
  if (path === '/api/v2/workspaces' && method === 'POST') {
    return fail(400, '原型暂不支持新建工作区');
  }
  if (path === '/api/v2/workspace-root' && method === 'GET') {
    return ok({ root: 'D:\\work' });
  }
  if (path === '/api/v2/workspace-root/dirs' && method === 'GET') {
    const dir = url.searchParams.get('path') || 'D:\\work';
    return ok({
      root: 'D:\\work',
      path: dir,
      parent: null,
      selectable: false,
      git: false,
      entries: [],
      truncated: false,
    });
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
    return ok({ entries: [], truncated: false });
  }
  const wsFilesMatch = /^\/api\/v2\/workspaces\/([^/]+)\/files$/.exec(path);
  if (wsFilesMatch) {
    return fail(404, '原型暂不支持预览文件', 'E_PROTO');
  }
  const wsMatch = /^\/api\/v2\/workspaces\/([^/]+)$/.exec(path);
  if (wsMatch && method === 'DELETE') {
    return removeWorkspace(db, hub, decodeURIComponent(wsMatch[1]));
  }

  const convMatch = /^\/api\/v2\/conversations\/([^/]+)$/.exec(path);
  if (convMatch) {
    const cid = decodeURIComponent(convMatch[1]);
    const conv = getConv(db, cid);
    if (!conv) return fail(404, '对话不存在');
    if (method === 'GET') return ok(conversationSnapshot(conv, lang));
    if (method === 'PATCH') return patchConversation(db, hub, conv, body);
  }

  const msgMatch = /^\/api\/v2\/conversations\/([^/]+)\/messages$/.exec(path);
  if (msgMatch && method === 'POST') {
    const cid = decodeURIComponent(msgMatch[1]);
    const conv = getConv(db, cid);
    if (!conv) return fail(404, '对话不存在');
    const text = String(body.text ?? '').trim();
    if (!text) return fail(400, '消息不能为空', 'E_BAD_REQUEST');
    const requestId = typeof body.requestId === 'string' && body.requestId
      ? body.requestId
      : nextId(db, 'req');
    const result = sendMessage(db, conv, hub, text, requestId);
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
    if (!conv || !diff) return fail(404, '原型里没有这个文件的 diff');
    return ok(diff);
  }
  if (/^\/api\/v2\/conversations\/[^/]+\/subagents\//.test(path)) {
    return fail(404, '原型暂不支持子 Agent 详情');
  }

  if (path === '/api/v2/plugins' && method === 'GET') return ok({ plugins: [] });
  if (path === '/api/v2/skills' && method === 'GET') return ok({ skills: [] });
  if (path === '/api/v2/extensions') return ok({});
  if (path.startsWith('/api/v2/plugins')) return fail(400, '原型暂不支持插件操作');
  if (path.startsWith('/api/v2/skills')) return fail(400, '原型暂不支持技能操作');
  if (path === '/api/v2/git/connections' && method === 'GET') return ok({ connections: [] });
  if (path.startsWith('/api/v2/git/')) return fail(400, '原型暂不支持 Git 连接');
  if (path === '/api/v2/events') return fail(400, '事件流要走 EventSource');

  return fail(404, `原型暂不支持 ${method} ${path}`);
}

/** Everything the prototype serves, wrapped in a real `Response`. */
export function mockResponse(db: MockDb, hub: MockHub, rawUrl: string, init?: RequestInit): Response {
  const reply = handleMockRequest(db, hub, rawUrl, init);
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
