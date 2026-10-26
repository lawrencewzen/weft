import type { components } from '../../../src/v2/contract.gen';

export type ConversationSnapshot = components['schemas']['ConversationSnapshot'];
export type ConversationSummary = components['schemas']['ConversationSummary'];
export type RunAccepted = components['schemas']['RunAccepted'];
export type StopAccepted = components['schemas']['StopAccepted'];
export type ToolOutput = components['schemas']['ToolOutput'];
export type V2Error = components['schemas']['V2Error'];
export type WorkspaceRemoved = components['schemas']['WorkspaceRemoved'];
export type Change = components['schemas']['Change'];
export type Diff = components['schemas']['Diff'];
export type DiffHunk = components['schemas']['DiffHunk'];
export type DiffLine = components['schemas']['DiffLine'];
export type FileNode = components['schemas']['FileNode'];
export type FileTree = components['schemas']['FileTree'];
export type FileContent = components['schemas']['FileContent'];
export type SaveResult = components['schemas']['SaveResult'];
export type SaveFileRequest = components['schemas']['SaveFileRequest'];
export type ConversationView = components['schemas']['ConversationView'];
export type Provider = components['schemas']['Provider'];
export type ProviderModel = components['schemas']['ProviderModel'];
export type Vendor = components['schemas']['Vendor'];
export type ProvidersSnapshot = components['schemas']['ProvidersSnapshot'];
export type ProviderProbeResult = components['schemas']['ProviderProbeResult'];
export type ResolvedModel = components['schemas']['ResolvedModel'];
export type CreateProviderRequest = components['schemas']['CreateProviderRequest'];
export type PatchProviderRequest = components['schemas']['PatchProviderRequest'];
export type TestProviderRequest = components['schemas']['TestProviderRequest'];
export type ProviderRemoved = components['schemas']['ProviderRemoved'];
export type GrokSession = components['schemas']['GrokSession'];
export type GrokLoginStart = components['schemas']['GrokLoginStart'];
export type GrokLoginPollResult = components['schemas']['GrokLoginPollResult'];
export type GrokLoginPollRequest = components['schemas']['GrokLoginPollRequest'];
export type GrokLoginCancelRequest = components['schemas']['GrokLoginCancelRequest'];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly current: FileContent | undefined;

  constructor(message: string, opts: { status: number; code?: string; current?: FileContent }) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.current = opts.current;
  }
}

export class ConflictError extends ApiError {
  declare readonly current: FileContent;

  constructor(message: string, current: FileContent) {
    super(message, { status: 409, code: 'E_CONFLICT', current });
    this.name = 'ConflictError';
  }
}

export function isConflictError(err: unknown): err is ConflictError {
  return err instanceof ConflictError
    || (err instanceof ApiError && err.status === 409 && err.code === 'E_CONFLICT' && err.current != null);
}

export class UnauthenticatedError extends ApiError {
  constructor(message = '未登录') {
    super(message, { status: 401, code: 'E_UNAUTHORIZED' });
    this.name = 'UnauthenticatedError';
  }
}

export function isUnauthenticatedError(err: unknown): err is UnauthenticatedError {
  return err instanceof UnauthenticatedError;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asFileContent(value: unknown): FileContent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.path !== 'string' || typeof rec.version !== 'string') return undefined;
  if (typeof rec.size !== 'number' || typeof rec.binary !== 'boolean' || typeof rec.tooLarge !== 'boolean') {
    return undefined;
  }
  if (rec.text != null && typeof rec.text !== 'string') return undefined;
  return {
    path: rec.path,
    size: rec.size,
    binary: rec.binary,
    tooLarge: rec.tooLarge,
    text: rec.text == null ? null : rec.text,
    version: rec.version,
  };
}

function parseErrorBody(
  status: number,
  statusText: string,
  text: string,
): { error: string; code?: string; current?: FileContent } {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const json = JSON.parse(trimmed) as { error?: unknown; code?: unknown; current?: unknown };
      const error = asText(json.error);
      const code = asText(json.code) || undefined;
      const current = asFileContent(json.current);
      if (error) return { error, code, current };
    } catch {
      return { error: trimmed };
    }
    return { error: trimmed };
  }
  return { error: `${status} ${statusText}`.trim() || 'request failed' };
}

function isMutating(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const method = String(init?.method || 'GET');
  if (isMutating(method) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers,
  });
  const text = await res.text();
  if (res.status === 401) throw new UnauthenticatedError();
  if (!res.ok) {
    const parsed = parseErrorBody(res.status, res.statusText, text);
    if (res.status === 409 && parsed.code === 'E_CONFLICT' && parsed.current) {
      throw new ConflictError(parsed.error, parsed.current);
    }
    throw new ApiError(parsed.error, { status: res.status, code: parsed.code, current: parsed.current });
  }
  if (!text) {
    throw new ApiError('empty response', { status: res.status });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('invalid json', { status: res.status });
  }
}

function conversationPath(cid: string, suffix = ''): string {
  return `/api/v2/conversations/${encodeURIComponent(cid)}${suffix}`;
}

export function sendMessage(cid: string, text: string, requestId?: string): Promise<RunAccepted> {
  const id = requestId ?? crypto.randomUUID();
  return requestJson<RunAccepted>(conversationPath(cid, '/messages'), {
    method: 'POST',
    body: JSON.stringify({ text, requestId: id }),
  });
}

export function stop(cid: string): Promise<StopAccepted> {
  return requestJson<StopAccepted>(conversationPath(cid, '/stop'), {
    method: 'POST',
    body: '{}',
  });
}

export function continueRun(cid: string, requestId?: string): Promise<RunAccepted> {
  const id = requestId ?? crypto.randomUUID();
  return requestJson<RunAccepted>(conversationPath(cid, '/continue'), {
    method: 'POST',
    body: JSON.stringify({ requestId: id }),
  });
}

export function toolOutput(cid: string, toolId: string): Promise<ToolOutput> {
  return requestJson<ToolOutput>(
    conversationPath(cid, `/tools/${encodeURIComponent(toolId)}/output`),
  );
}

export function getSnapshot(cid: string, lang: string): Promise<ConversationSnapshot> {
  const params = new URLSearchParams({ lang });
  return requestJson<ConversationSnapshot>(`${conversationPath(cid)}?${params.toString()}`);
}

export function patchConversationModel(
  cid: string,
  model: ResolvedModel | null,
): Promise<ConversationView> {
  return requestJson<ConversationView>(conversationPath(cid), {
    method: 'PATCH',
    body: JSON.stringify({ model }),
  });
}

export function createConversation(workspaceId: string, title?: string): Promise<ConversationSummary> {
  const body: { title?: string } = {};
  if (title != null && title !== '') body.title = title;
  return requestJson<ConversationSummary>(
    `/api/v2/workspaces/${encodeURIComponent(workspaceId)}/conversations`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export function removeWorkspace(workspaceId: string): Promise<WorkspaceRemoved> {
  return requestJson<WorkspaceRemoved>(
    `/api/v2/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: 'DELETE' },
  );
}

function subagentPath(cid: string, agentId: string, suffix = ''): string {
  return `/api/v2/conversations/${encodeURIComponent(cid)}/subagents/${encodeURIComponent(agentId)}${suffix}`;
}

export function sendSubagentMessage(cid: string, agentId: string, text: string): Promise<{ ok: true }> {
  return requestJson<{ ok: true }>(subagentPath(cid, agentId, '/messages'), {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function stopSubagent(cid: string, agentId: string): Promise<StopAccepted> {
  return requestJson<StopAccepted>(subagentPath(cid, agentId, '/stop'), {
    method: 'POST',
    body: '{}',
  });
}

export function conversationDiffUrl(cid: string, filePath: string): string {
  const params = new URLSearchParams({ path: filePath });
  return `/api/v2/conversations/${encodeURIComponent(cid)}/diff?${params.toString()}`;
}

export function workspaceTreeUrl(workspaceId: string): string {
  return `/api/v2/workspaces/${encodeURIComponent(workspaceId)}/tree`;
}

export function workspaceFileUrl(workspaceId: string, filePath: string): string {
  const params = new URLSearchParams({ path: filePath });
  return `/api/v2/workspaces/${encodeURIComponent(workspaceId)}/files?${params.toString()}`;
}

export function getConversationDiff(cid: string, filePath: string): Promise<Diff> {
  return requestJson<Diff>(conversationDiffUrl(cid, filePath));
}

export function getWorkspaceTree(workspaceId: string): Promise<FileTree> {
  return requestJson<FileTree>(workspaceTreeUrl(workspaceId));
}

export function getWorkspaceFile(workspaceId: string, filePath: string): Promise<FileContent> {
  return requestJson<FileContent>(workspaceFileUrl(workspaceId, filePath));
}

export function saveWorkspaceFile(
  workspaceId: string,
  body: SaveFileRequest,
): Promise<SaveResult> {
  return requestJson<SaveResult>(
    `/api/v2/workspaces/${encodeURIComponent(workspaceId)}/files`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

function withLang(url: string, lang?: string): string {
  if (!lang) return url;
  const join = url.includes('?') ? '&' : '?';
  return `${url}${join}lang=${encodeURIComponent(lang)}`;
}

function providerPath(id: string, suffix = ''): string {
  return `/api/v2/providers/${encodeURIComponent(id)}${suffix}`;
}

export function getProviders(lang?: string): Promise<ProvidersSnapshot> {
  return requestJson<ProvidersSnapshot>(withLang('/api/v2/providers', lang));
}

export function createProvider(body: CreateProviderRequest, lang?: string): Promise<Provider> {
  return requestJson<Provider>(withLang('/api/v2/providers', lang), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function patchProvider(id: string, body: PatchProviderRequest, lang?: string): Promise<Provider> {
  return requestJson<Provider>(withLang(providerPath(id), lang), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteProvider(id: string): Promise<ProviderRemoved> {
  return requestJson<ProviderRemoved>(providerPath(id), {
    method: 'DELETE',
    body: '{}',
  });
}

export function testProviderDraft(body: TestProviderRequest, lang?: string): Promise<ProviderProbeResult> {
  return requestJson<ProviderProbeResult>(withLang('/api/v2/providers/test', lang), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function testProvider(id: string, lang?: string): Promise<Provider> {
  return requestJson<Provider>(withLang(providerPath(id, '/test'), lang), {
    method: 'POST',
    body: '{}',
  });
}

export function putModelContextWindow(
  providerId: string,
  modelId: string,
  window: number | null,
  lang?: string,
): Promise<Provider> {
  return requestJson<Provider>(
    withLang(`${providerPath(providerId)}/models/${encodeURIComponent(modelId)}/context-window`, lang),
    { method: 'PUT', body: JSON.stringify({ window }) },
  );
}

export function getGrokSession(): Promise<GrokSession> {
  return requestJson<GrokSession>('/api/v2/providers/grok/session');
}

export function startGrokLogin(): Promise<GrokLoginStart> {
  return requestJson<GrokLoginStart>('/api/v2/providers/grok/login', {
    method: 'POST',
    body: '{}',
  });
}

export function pollGrokLogin(loginId: string): Promise<GrokLoginPollResult> {
  return requestJson<GrokLoginPollResult>('/api/v2/providers/grok/login/poll', {
    method: 'POST',
    body: JSON.stringify({ loginId } satisfies GrokLoginPollRequest),
  });
}

export function cancelGrokLogin(loginId?: string): Promise<GrokSession> {
  const body: GrokLoginCancelRequest = {};
  if (loginId) body.loginId = loginId;
  return requestJson<GrokSession>('/api/v2/providers/grok/login/cancel', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function logoutGrok(): Promise<GrokSession> {
  return requestJson<GrokSession>('/api/v2/providers/grok/logout', {
    method: 'POST',
    body: '{}',
  });
}
