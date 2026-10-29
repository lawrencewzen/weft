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
/** Local shapes for the Grok login UI. T59-2 dropped these from the contract; T59-3 removes the UI. */
export type GrokPending = {
  loginId: string;
  verificationUri: string;
  userCode: string;
  interval: number;
  expiresAt: number;
};
export type GrokSession = {
  signedIn: boolean;
  account: null | string;
  email: null | string;
  expiresAt: null | number;
  authMode: null | string;
  source: null | string;
  pending: null | GrokPending;
};
export type GrokLoginStart = GrokPending;
export type GrokLoginPollRequest = { loginId: string };
export type GrokLoginCancelRequest = { loginId?: string };
export type GrokLoginPollResult =
  | { status: 'pending'; interval: number; expiresAt: number }
  | { status: 'done'; grok: GrokSession };
export type CreateWorkspaceRequest = components['schemas']['CreateWorkspaceRequest'];
export type Workspace = components['schemas']['Workspace'];
export type WorkspaceRoot = components['schemas']['WorkspaceRoot'];
export type WorkspaceDirs = components['schemas']['WorkspaceDirs'];
export type WorkspaceDirEntry = components['schemas']['WorkspaceDirEntry'];
export type Plugin = components['schemas']['Plugin'];
export type PluginList = components['schemas']['PluginList'];
export type InstallPluginRequest = components['schemas']['InstallPluginRequest'];
export type PatchPluginRequest = components['schemas']['PatchPluginRequest'];
export type Skill = components['schemas']['Skill'];
export type SkillList = components['schemas']['SkillList'];
export type SkillWriteRequest = components['schemas']['SkillWriteRequest'];
export type GitConnection = components['schemas']['GitConnection'];
export type GitConnectionList = components['schemas']['GitConnectionList'];
export type GitConnectionWrite = components['schemas']['GitConnectionWrite'];
export type GitTestResult = components['schemas']['GitTestResult'];
export type GitProject = components['schemas']['GitProject'];
export type GitProjectList = components['schemas']['GitProjectList'];
export type GitBranch = components['schemas']['GitBranch'];
export type GitBranchList = components['schemas']['GitBranchList'];
export type OkId = components['schemas']['OkId'];
export type OpenTerminalRequest = components['schemas']['OpenTerminalRequest'];
export type OpenTerminalResult = components['schemas']['OpenTerminalResult'];

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

export type SendMode = components['schemas']['SendMessageRequest']['mode'];
export type UploadResult = components['schemas']['UploadResult'];
export type SendMessageFile = components['schemas']['SendMessageFile'];

export function sendMessage(
  cid: string,
  text: string,
  requestId?: string,
  images?: components['schemas']['MessageImage'][],
  mode?: SendMode,
  files?: components['schemas']['SendMessageFile'][],
  pastes?: string[],
): Promise<RunAccepted> {
  const id = requestId ?? crypto.randomUUID();
  const body: {
    text: string;
    requestId: string;
    images?: components['schemas']['MessageImage'][];
    mode?: SendMode;
    files?: components['schemas']['SendMessageFile'][];
    pastes?: string[];
  } = {
    text,
    requestId: id,
  };
  if (images?.length) body.images = images;
  if (mode === 'steer' || mode === 'queue') body.mode = mode;
  if (files?.length) body.files = files;
  if (pastes?.length) body.pastes = pastes;
  return requestJson<RunAccepted>(conversationPath(cid, '/messages'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function uploadWorkspaceFile(
  workspaceId: string,
  input: { name?: string; data: string },
): Promise<UploadResult> {
  return requestJson<UploadResult>(`/api/v2/workspaces/${encodeURIComponent(workspaceId)}/uploads`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getMessagePaste(
  cid: string,
  messageId: string,
  index: number,
): Promise<string> {
  const url = conversationPath(cid, `/messages/${encodeURIComponent(messageId)}/pastes/${encodeURIComponent(index)}`);
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json() as { error?: string };
      if (err?.error) msg = err.error;
    } catch {}
    throw new ApiError(msg, { status: res.status });
  }
  return res.text();
}

export function withdrawMessage(cid: string, requestId: string): Promise<{ ok: true }> {
  return requestJson<{ ok: true }>(
    conversationPath(cid, `/messages/${encodeURIComponent(requestId)}`),
    { method: 'DELETE' },
  );
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

export function refreshWorkspaceGit(workspaceId: string): Promise<Workspace> {
  return requestJson<Workspace>(
    `/api/v2/workspaces/${encodeURIComponent(workspaceId)}/git/refresh`,
    { method: 'POST', body: '{}' },
  );
}

export function openWorkspaceTerminal(
  workspaceId: string,
  dirPath?: string,
): Promise<OpenTerminalResult> {
  const body: OpenTerminalRequest = {};
  if (dirPath != null && dirPath !== '') body.path = dirPath;
  return requestJson<OpenTerminalResult>(
    `/api/v2/workspaces/${encodeURIComponent(workspaceId)}/open-terminal`,
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

export function createWorkspace(body: CreateWorkspaceRequest, lang?: string): Promise<Workspace> {
  return requestJson<Workspace>(withLang('/api/v2/workspaces', lang), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function getWorkspaceRoot(lang?: string): Promise<WorkspaceRoot> {
  return requestJson<WorkspaceRoot>(withLang('/api/v2/workspace-root', lang));
}

export function listWorkspaceDirs(dirPath?: string, lang?: string): Promise<WorkspaceDirs> {
  const params = new URLSearchParams();
  if (dirPath) params.set('path', dirPath);
  if (lang) params.set('lang', lang);
  const query = params.toString();
  return requestJson<WorkspaceDirs>(`/api/v2/workspace-root/dirs${query ? `?${query}` : ''}`);
}

function gitPath(id?: string, suffix = ''): string {
  if (!id) return `/api/v2/git/connections${suffix}`;
  return `/api/v2/git/connections/${encodeURIComponent(id)}${suffix}`;
}

export function listGitConnections(lang?: string): Promise<GitConnectionList> {
  return requestJson<GitConnectionList>(withLang(gitPath(), lang));
}

export function createGitConnection(body: GitConnectionWrite, lang?: string): Promise<GitConnection> {
  return requestJson<GitConnection>(withLang(gitPath(), lang), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function patchGitConnection(id: string, body: GitConnectionWrite, lang?: string): Promise<GitConnection> {
  return requestJson<GitConnection>(withLang(gitPath(id), lang), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteGitConnection(id: string): Promise<OkId> {
  return requestJson<OkId>(gitPath(id), {
    method: 'DELETE',
    body: '{}',
  });
}

export function testGitConnectionDraft(body: GitConnectionWrite, lang?: string): Promise<GitTestResult> {
  return requestJson<GitTestResult>(withLang('/api/v2/git/connections/test', lang), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function testGitConnection(id: string, lang?: string): Promise<GitTestResult> {
  return requestJson<GitTestResult>(withLang(gitPath(id, '/test'), lang), {
    method: 'POST',
    body: '{}',
  });
}

export function listGitProjects(connectionId: string, search?: string, lang?: string): Promise<GitProjectList> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (lang) params.set('lang', lang);
  const query = params.toString();
  return requestJson<GitProjectList>(`${gitPath(connectionId, '/projects')}${query ? `?${query}` : ''}`);
}

export function listGitBranches(connectionId: string, projectId: string | number, lang?: string): Promise<GitBranchList> {
  return requestJson<GitBranchList>(
    withLang(`${gitPath(connectionId, `/projects/${encodeURIComponent(String(projectId))}/branches`)}`, lang),
  );
}

export function listPlugins(lang?: string): Promise<PluginList> {
  return requestJson<PluginList>(withLang('/api/v2/plugins', lang));
}

export function installPlugin(body: InstallPluginRequest, lang?: string): Promise<Plugin> {
  return requestJson<Plugin>(withLang('/api/v2/plugins', lang), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function patchPlugin(id: string, body: PatchPluginRequest, lang?: string): Promise<Plugin> {
  return requestJson<Plugin>(withLang(`/api/v2/plugins/${encodeURIComponent(id)}`, lang), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function listSkills(lang?: string): Promise<SkillList> {
  return requestJson<SkillList>(withLang('/api/v2/skills', lang));
}

export function createSkill(body: SkillWriteRequest, lang?: string): Promise<Skill> {
  return requestJson<Skill>(withLang('/api/v2/skills', lang), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function patchSkill(id: string, body: SkillWriteRequest, lang?: string): Promise<Skill> {
  return requestJson<Skill>(withLang(`/api/v2/skills/${encodeURIComponent(id)}`, lang), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteSkill(id: string): Promise<OkId> {
  return requestJson<OkId>(`/api/v2/skills/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: '{}',
  });
}
