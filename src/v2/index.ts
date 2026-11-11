import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { SECURITY_HEADERS } from '../core/auth.mjs';
import { formatSSE } from '../core/sse.mjs';
import {
  createV2Auth,
  generateLocalToken,
  handleNextLogin,
  resolveStartupCodeTtlMs,
  resolveWebCodeTtlMs,
  type V2Auth,
} from './auth.ts';
import type { components } from './contract.gen.ts';
import { removeDiscoverySync, writeDiscoverySync } from './daemon/discovery.ts';
import {
  createEventHub,
  normalizeLang,
  parseTopics,
  type EventHub,
  type SseFrame,
} from './stream/hub.ts';
import { contractMismatchLog, validateResponse } from './validate.ts';
import { PROTOCOL_VERSION } from './version.ts';
import { handleProvidersApi, type ProviderServiceLike, type ProvidersHttpOpts, type ProvidersJsonBody } from './providers-http.ts';
import { attachConversationTopic, type KernelEvent } from './stream/conversation-topic.ts';
import { attachProvidersTopic } from './stream/providers-topic.ts';
import { attachWorkspacesTopic } from './stream/workspaces-topic.ts';
import { attachSubagentTopic, type LoadSubagent } from './stream/subagent-topic.ts';
import { createStuckWatch } from './stream/stuck-watch.ts';
import { createStallWatch } from './stream/stall-watch.ts';
import { attachExtensionsTopic } from './stream/extensions-topic.ts';
import { attachSchedulesTopic } from './stream/schedules-topic.ts';
import { handleSchedulesApi, lazySchedulesHost, type SchedulesHost } from './http/schedules.ts';
import { handleExtensionsApi, loadExtensionsSnapshot, type ExtensionsHost } from './http/extensions.ts';
import { handleOpenTerminalApi } from './http/open-terminal.ts';
import {
  diffView,
  findKernelChange,
  posixPath,
  type KernelChange,
  type KernelDiffBody,
} from './views/changes.ts';
import { compactionSettingsView, readTriggerPercent, validateCompactionPatch } from '../core/settings.mjs';
import {
  conversationSnapshot,
  findPresentedTool,
  toolOutputView,
  type LoadConversation,
} from './views/conversation.ts';
import {
  assembleUserContent,
  decodedBase64Bytes,
  MESSAGE_BODY_MAX_BYTES,
  normalizeMediaType,
  parseSendImages,
  type MessageImage,
} from './views/message-images.ts';
import {
  parseSendFiles,
  parseSendPastes,
  parseUploadBody,
  resolveSendFiles,
  saveWorkspaceUpload,
  UPLOAD_BODY_MAX_BYTES,
} from './views/uploads.ts';
import {
  openWorkspaceImage,
  readWorkspaceFile,
  saveWorkspaceFile,
  SVG_IMAGE_CSP,
  WORKSPACE_IMAGE_MAX_BYTES,
  workspaceTreeView,
  type FileOpError,
  type WorkspaceImageFile,
} from './views/files.ts';
import { searchWorkspaceFiles } from './views/file-search.ts';
import {
  buildWorkspacesSnapshot,
  conversationSummaryView,
  type SidebarLoader,
} from './views/sidebar.ts';
import { createGitStatusCache, type GitStatusCache } from './views/git-status.ts';
import { subagentSnapshot } from './views/subagents.ts';
import { log, logLine } from '../core/log.mjs';

type ServiceInfo = components['schemas']['ServiceInfo'];
type V2Error = components['schemas']['V2Error'];
type WebCode = components['schemas']['WebCode'];
type RestartAccepted = components['schemas']['RestartAccepted'];
type ConversationSnapshot = components['schemas']['ConversationSnapshot'];
type RunAccepted = components['schemas']['RunAccepted'];
type CompactionSettingsView = components['schemas']['CompactionSettingsView'];
type CompactAccepted = components['schemas']['CompactAccepted'];
type ForkConversationResponse = components['schemas']['ForkConversationResponse'];
type StopAccepted = components['schemas']['StopAccepted'];
type ToolOutput = components['schemas']['ToolOutput'];
type WorkspacesSnapshot = components['schemas']['WorkspacesSnapshot'];
type Workspace = components['schemas']['Workspace'];
type ConversationSummary = components['schemas']['ConversationSummary'];
type WorkspaceRemoved = components['schemas']['WorkspaceRemoved'];
type WorkspaceBusy = components['schemas']['WorkspaceBusy'];
type SubagentSnapshot = components['schemas']['SubagentSnapshot'];
type SubagentMessageAccepted = components['schemas']['SubagentMessageAccepted'];
type Diff = components['schemas']['Diff'];
type FileTree = components['schemas']['FileTree'];
type FileSearchResult = components['schemas']['FileSearchResult'];
type FileContent = components['schemas']['FileContent'];
type SaveResult = components['schemas']['SaveResult'];
type FileConflict = components['schemas']['FileConflict'];
type ConversationView = components['schemas']['ConversationView'];
type WorkspaceRoot = components['schemas']['WorkspaceRoot'];
type WorkspaceDirs = components['schemas']['WorkspaceDirs'];
type PathNotAllowed = components['schemas']['PathNotAllowed'];
type WorkspaceCreateError = components['schemas']['WorkspaceCreateError'];
type GitCloneFailure = components['schemas']['GitCloneFailure'];
type Plugin = components['schemas']['Plugin'];
type PluginList = components['schemas']['PluginList'];
type Skill = components['schemas']['Skill'];
type SkillList = components['schemas']['SkillList'];
type CatalogError = components['schemas']['CatalogError'];
type GitConnection = components['schemas']['GitConnection'];
type GitConnectionList = components['schemas']['GitConnectionList'];
type GitConnectionInvalid = components['schemas']['GitConnectionInvalid'];
type GitTestResult = components['schemas']['GitTestResult'];
type GitProjectList = components['schemas']['GitProjectList'];
type GitBranchList = components['schemas']['GitBranchList'];
type OkId = components['schemas']['OkId'];
type OpenTerminalResult = components['schemas']['OpenTerminalResult'];
type UploadResult = components['schemas']['UploadResult'];
type V2JsonBody =
  | ServiceInfo
  | WebCode
  | V2Error
  | RestartAccepted
  | ConversationSnapshot
  | ConversationView
  | RunAccepted
  | CompactionSettingsView
  | CompactAccepted
  | ForkConversationResponse
  | StopAccepted
  | ToolOutput
  | WorkspacesSnapshot
  | Workspace
  | ConversationSummary
  | WorkspaceRemoved
  | WorkspaceBusy
  | SubagentSnapshot
  | SubagentMessageAccepted
  | Diff
  | FileTree
  | FileSearchResult
  | FileContent
  | SaveResult
  | FileConflict
  | ProvidersJsonBody
  | WorkspaceRoot
  | WorkspaceDirs
  | PathNotAllowed
  | WorkspaceCreateError
  | GitCloneFailure
  | Plugin
  | PluginList
  | Skill
  | SkillList
  | CatalogError
  | GitConnection
  | GitConnectionList
  | GitConnectionInvalid
  | GitTestResult
  | GitProjectList
  | GitBranchList
  | OkId
  | OpenTerminalResult
  | UploadResult;

export type ConversationRow = {
  id?: unknown;
  workspaceId?: unknown;
  [key: string]: unknown;
};

export type WorkspaceRow = {
  removedAt?: unknown;
  path?: unknown;
  kind?: unknown;
  [key: string]: unknown;
};

export type GetConversation = (id: string) => Promise<ConversationRow | null | undefined>;
export type MessageImageRecord = {
  mediaType?: unknown;
  data?: unknown;
  name?: unknown;
};
export type GetMessageImage = (
  conversationId: string,
  messageId: string,
  index: number,
) => Promise<MessageImageRecord | null | undefined>;
export type GetMessagePaste = (
  conversationId: string,
  messageId: string,
  index: number,
) => Promise<string | null | undefined>;
export type GetWorkspace = (id: string) => Promise<WorkspaceRow | null | undefined>;
export type SendMode = 'steer' | 'queue';
export type PostMessage = (
  conv: ConversationRow,
  text: string,
  opts?: {
    requestId?: string;
    content?: unknown;
    mode?: SendMode;
    answer?: Record<string, unknown>;
    /** Pi Durable continue submission: no user message. Busy conversations return 409. */
    continue?: boolean;
  },
) => Promise<{ status: number; body?: { runId?: unknown; error?: unknown; code?: unknown } }>;
export type WithdrawMessageFn = (
  cid: string,
  requestId: string,
) => Promise<{ status: number; body?: { ok?: true; error?: unknown; code?: unknown } }>;
export type StopConversationFn = (id: string) => Promise<{ status: number }>;
export type ListWorkspacesFn = () => Promise<WorkspaceRow[]>;
export type ListConversationsFn = (workspaceId: string) => Promise<ConversationRow[]>;
export type StatusOfFn = (conv: ConversationRow) => Promise<unknown>;
export type SubagentDigestsFn = (
  convs: ConversationRow[],
) => Promise<Map<string, { total: number; live: number }>>;
export type CreateConversationFn = (
  workspaceId: string,
  fields?: { title?: string },
) => Promise<{ status: number; conv?: ConversationRow }>;
export type CreateChatConversationFn = (
  fields?: { title?: string; lang?: 'zh' | 'en' },
) => Promise<{ status: number; conv?: ConversationRow }>;
export type RemoveWorkspaceFn = (id: string) => Promise<void>;
export type SubscribeAllFn = (fn: (cid: string, ev: KernelEvent) => void) => () => void;

export type SendToAgentFn = (
  cid: string,
  agentId: string,
  text: string,
) => Promise<{ status: number; body?: { ok?: unknown; error?: unknown } }>;
export type StopAgentFn = (cid: string, agentId: string) => Promise<{ status: number }>;

export type ChangesConversationFn = (cid: string) => Promise<KernelChange[]>;
export type DiffConversationFn = (
  cid: string,
  filePath: string,
) => Promise<{ status: number; body?: KernelDiffBody }>;
export type NotifyConversationFn = (cid: string) => void;
export type PatchConversationFn = (
  id: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; body?: { errors?: unknown; error?: unknown } }>;
export type ForkConversationFn = (
  id: string,
  body: { entryId?: string; requestId?: string; lang?: 'zh' | 'en' },
) => Promise<{
  status: number;
  body?: {
    conversationId?: unknown;
    prefill?: { text?: unknown } | null;
    error?: unknown;
    code?: unknown;
  };
}>;

export type DeleteConversationFn = (
  id: string,
) => Promise<{ status: number; body?: { error?: unknown; code?: unknown } }>;

export type { LoadConversation, LoadSubagent, KernelEvent, KernelChange };

export type V2Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export type V2Runtime = {
  handleApi: V2Handler;
  handleLogin: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
  issueStartupLoginUrl: (port: number) => string;
  writeDiscoveryFile: (port: number) => void;
  removeDiscoveryFile: () => void;
  notifySidebarChanged: () => void;
  notifyProvidersChanged: () => void;
  notifyConversation: NotifyConversationFn;
  notifyExtensionsChanged: () => void;
  notifySchedulesChanged: () => void;
  dispose: () => void;
};

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

function v2Headers(): Record<string, string> {
  return {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'Weft-Protocol': PROTOCOL_VERSION,
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown, onSent?: () => void): void {
  res.writeHead(status, v2Headers());
  res.end(JSON.stringify(body), () => {
    onSent?.();
  });
}

function sendV2(
  res: ServerResponse,
  requestPath: string,
  method: string,
  status: number,
  body: V2JsonBody | null,
  onSent?: () => void,
): void {
  if (process.env.WEFT_V2_VALIDATE === '1') {
    const result = validateResponse(requestPath, method, status, body);
    if (!result.ok) {
      logLine('error', contractMismatchLog(requestPath, method, status, result.errors));
      const errorBody: V2Error = { error: 'contract mismatch', code: 'E_CONTRACT' };
      writeJson(res, 500, errorBody);
      return;
    }
  }
  if (status === 204) {
    const headers = { ...SECURITY_HEADERS, 'cache-control': 'no-store', 'Weft-Protocol': PROTOCOL_VERSION };
    res.writeHead(204, headers);
    res.end(() => {
      onSent?.();
    });
    return;
  }
  writeJson(res, status, body, onSent);
}

function unauthorized(res: ServerResponse, requestPath: string, method: string): void {
  sendV2(res, requestPath, method, 401, { error: 'unauthorized', code: 'E_UNAUTHORIZED' } satisfies V2Error);
}

const IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable';

function imageEtag(buf: Buffer): string {
  return `"${createHash('sha256').update(buf).digest('hex')}"`;
}

function sendCachedBytes(
  req: IncomingMessage,
  res: ServerResponse,
  mediaType: string,
  buf: Buffer,
): void {
  const etag = imageEtag(buf);
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'content-type': mediaType,
    'cache-control': IMAGE_CACHE_CONTROL,
    etag,
    'Weft-Protocol': PROTOCOL_VERSION,
  };
  const noneMatch = String(req.headers['if-none-match'] || '');
  if (noneMatch && noneMatch.split(',').map((part) => part.trim()).includes(etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(buf.length);
  res.writeHead(200, headers);
  res.end(buf);
}

function sendImageBytes(req: IncomingMessage, res: ServerResponse, mediaType: string, buf: Buffer): void {
  sendCachedBytes(req, res, mediaType, buf);
}

const WORKSPACE_IMAGE_CACHE_CONTROL = 'private, no-cache';

function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(',') : String(header || '');
  if (!raw) return false;
  return raw.split(',').map((part) => part.trim()).includes(etag);
}

/** Stream a workspace image. The body is not buffered. */
async function sendWorkspaceImage(
  req: IncomingMessage,
  res: ServerResponse,
  image: WorkspaceImageFile,
): Promise<void> {
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'content-type': image.mediaType,
    'content-disposition': 'inline',
    'cache-control': WORKSPACE_IMAGE_CACHE_CONTROL,
    etag: image.etag,
    'Weft-Protocol': PROTOCOL_VERSION,
  };
  if (image.mediaType === 'image/svg+xml') {
    headers['Content-Security-Policy'] = SVG_IMAGE_CSP;
  }
  if (ifNoneMatchHits(req.headers['if-none-match'], image.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(image.size);
  res.writeHead(200, headers);
  try {
    await pipeline(createReadStream(image.abs), res);
  } catch (err) {
    if (!res.writableEnded) res.destroy(err instanceof Error ? err : undefined);
  }
}

async function readObjectBody(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  maxBytes = 1_000_000,
): Promise<Record<string, unknown> | null> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req, maxBytes);
  } catch (err) {
    const status = Number((err as { status?: number })?.status) || 400;
    const message = status === 413 ? 'payload too large' : 'invalid JSON';
    const code = status === 413 ? 'E_PAYLOAD' : 'E_BAD_REQUEST';
    sendV2(res, pathname, method, status, { error: message, code } satisfies V2Error);
    return null;
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    sendV2(res, pathname, method, 400, { error: 'invalid body', code: 'E_BAD_REQUEST' } satisfies V2Error);
    return null;
  }
  return raw as Record<string, unknown>;
}

function requestIdFrom(body: Record<string, unknown>): { ok: true; value?: string } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(body, 'requestId') || body.requestId == null) {
    return { ok: true };
  }
  if (typeof body.requestId !== 'string') return { ok: false };
  const value = body.requestId.trim();
  return value ? { ok: true, value } : { ok: true };
}

function sendModeFrom(body: Record<string, unknown>): { ok: true; value: SendMode } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(body, 'mode') || body.mode == null || body.mode === '') {
    return { ok: true, value: 'steer' };
  }
  if (body.mode === 'steer' || body.mode === 'queue') return { ok: true, value: body.mode };
  return { ok: false };
}

function workspaceIdOf(conv: { workspaceId?: unknown } | null | undefined): string {
  if (conv?.workspaceId == null) return '';
  return String(conv.workspaceId);
}

async function workspaceReady(
  conv: { workspaceId?: unknown } | null | undefined,
  getWorkspace?: GetWorkspace,
): Promise<boolean> {
  const wid = workspaceIdOf(conv);
  if (!wid) return false;
  if (!getWorkspace) return true;
  const ws = await getWorkspace(wid);
  if (!ws) return false;
  return ws.removedAt == null;
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      const err = new Error('payload too large');
      (err as Error & { status?: number }).status = 413;
      throw err;
    }
    chunks.push(buf);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('invalid JSON');
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
}

function headerOrQueryLastEventId(req: IncomingMessage, url: URL): string | null {
  const header = req.headers['last-event-id'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader != null && String(fromHeader).length > 0) return String(fromHeader);
  return url.searchParams.get('lastEventId');
}

function sseHeaders(): Record<string, string> {
  return {
    ...SECURITY_HEADERS,
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
    'Weft-Protocol': PROTOCOL_VERSION,
  };
}

function writeSseFrame(res: ServerResponse, frame: SseFrame): void {
  if (!res.writable || res.writableEnded) return;
  const chunk = formatSSE(frame) as string;
  try {
    res.write(chunk);
  } catch {
    /* client gone */
  }
}

function errCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code != null) {
    return String((err as { code?: unknown }).code);
  }
  return '';
}

function sendFileOpError(
  res: ServerResponse,
  pathname: string,
  method: string,
  err: unknown,
): boolean {
  const code = errCode(err);
  if (code === 'E_SANDBOX') {
    sendV2(res, pathname, method, 403, { error: 'path outside workspace', code: 'E_SANDBOX' } satisfies V2Error);
    return true;
  }
  if (code === 'ENOENT') {
    sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
    return true;
  }
  if (code === 'EISDIR') {
    sendV2(res, pathname, method, 400, { error: 'is a directory', code: 'E_BAD_REQUEST' } satisfies V2Error);
    return true;
  }
  if (code === 'ENOTDIR') {
    sendV2(res, pathname, method, 400, { error: 'not a directory', code: 'E_BAD_REQUEST' } satisfies V2Error);
    return true;
  }
  if (code === 'E_NOT_READABLE') {
    sendV2(res, pathname, method, 403, { error: '.git is not readable', code: 'E_NOT_READABLE' } satisfies V2Error);
    return true;
  }
  if (code === 'E_CONFLICT') {
    const current = (err as FileOpError).current;
    if (!current) return false;
    sendV2(res, pathname, method, 409, {
      error: 'conflict',
      code: 'E_CONFLICT',
      current,
    } satisfies FileConflict);
    return true;
  }
  return false;
}

function workspacePathOf(ws: WorkspaceRow | null | undefined): string {
  if (!ws || ws.removedAt != null) return '';
  if (ws.path == null) return '';
  return String(ws.path);
}

function workspaceKindOf(ws: WorkspaceRow | null | undefined): 'project' | 'chat' {
  return ws && ws.kind === 'chat' ? 'chat' : 'project';
}

function sidebarLoader(opts: {
  listWorkspaces?: ListWorkspacesFn;
  listConversations?: ListConversationsFn;
  statusOf?: StatusOfFn;
  subagentDigests?: SubagentDigestsFn;
}): SidebarLoader {
  return {
    async listWorkspaces() {
      return opts.listWorkspaces ? opts.listWorkspaces() : [];
    },
    async listConversations(workspaceId) {
      return opts.listConversations ? opts.listConversations(workspaceId) : [];
    },
    async statusOf(conv) {
      return opts.statusOf ? opts.statusOf(conv) : 'idle';
    },
    async subagentDigests(convs) {
      return opts.subagentDigests ? opts.subagentDigests(convs) : new Map();
    },
  };
}

function serviceInfo(opts: { serviceVersion: string; startedAt: number; pid: number; demo: boolean }): ServiceInfo {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serviceVersion: opts.serviceVersion,
    pid: opts.pid,
    startedAt: opts.startedAt,
    demo: opts.demo,
  };
}

export function createV2Handler(opts: {
  serviceVersion: string;
  startedAt: number;
  auth: V2Auth;
  hub: EventHub;
  pid?: number;
  hasActiveWork?: () => boolean | Promise<boolean>;
  onRestart?: () => void;
  loadConversation?: LoadConversation;
  getConversation?: GetConversation;
  getMessageImage?: GetMessageImage;
  getMessagePaste?: GetMessagePaste;
  getWorkspace?: GetWorkspace;
  postMessage?: PostMessage;
  withdrawMessage?: WithdrawMessageFn;
  stopConversation?: StopConversationFn;
  listWorkspaces?: ListWorkspacesFn;
  listConversations?: ListConversationsFn;
  statusOf?: StatusOfFn;
  subagentDigests?: SubagentDigestsFn;
  createConversation?: CreateConversationFn;
  createChatConversation?: CreateChatConversationFn;
  removeWorkspace?: RemoveWorkspaceFn;
  onSidebarChanged?: () => void;
  loadSubagent?: LoadSubagent;
  sendToAgent?: SendToAgentFn;
  stopAgent?: StopAgentFn;
  demo?: boolean;
  changesConversation?: ChangesConversationFn;
  diffConversation?: DiffConversationFn;
  notifyConversation?: NotifyConversationFn;
  patchConversation?: PatchConversationFn;
  providers?: ProvidersHttpOpts;
  extensions?: ExtensionsHost;
  onExtensionsChanged?: () => void;
  schedules?: SchedulesHost;
  onSchedulesChanged?: () => void;
  gitStatus?: GitStatusCache;
  getSettings?: () => Promise<unknown>;
  putSettings?: (patch: Record<string, unknown>) => Promise<unknown>;
  compactionEffective?: (percent: number) => Promise<CompactionSettingsView['compaction']['effective']>;
  compactConversation?: (
    id: string,
    instructions?: string,
  ) => Promise<{ status: number; body?: { taskId?: unknown; error?: unknown; code?: unknown } }>;
  handoffConversation?: (
    id: string,
    body: { requestId?: unknown; instructions?: unknown },
  ) => Promise<{ status: number; body?: { ok?: unknown; error?: unknown; code?: unknown } }>;
  forkConversation?: ForkConversationFn;
  deleteConversation?: DeleteConversationFn;
}): V2Handler {
  const { serviceVersion, startedAt, auth, hub } = opts;
  const pid = opts.pid ?? process.pid;
  const demo = Boolean(opts.demo);
  const hasActiveWork = opts.hasActiveWork ?? (() => false);
  return async (req, res, url) => {
    if (url.pathname !== '/api/v2' && !url.pathname.startsWith('/api/v2/')) return false;
    const pathname = normalizePath(url.pathname);
    const method = req.method || 'GET';

    if (method === 'POST' && pathname === '/api/v2/auth/web-code') {
      if (!auth.hasBearer(req)) {
        unauthorized(res, pathname, method);
        return true;
      }
      try {
        const body = await readJsonBody(req);
        if (body == null || typeof body !== 'object' || Array.isArray(body)) {
          sendV2(res, pathname, method, 400, { error: 'invalid body', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
      } catch (err) {
        const status = Number((err as { status?: number })?.status) || 400;
        const message = status === 413 ? 'payload too large' : 'invalid JSON';
        const code = status === 413 ? 'E_PAYLOAD' : 'E_BAD_REQUEST';
        sendV2(res, pathname, method, status, { error: message, code } satisfies V2Error);
        return true;
      }
      const issued = auth.issueWebCode();
      sendV2(res, pathname, method, 200, issued satisfies WebCode);
      return true;
    }

    if (!auth.isAuthorized(req)) {
      unauthorized(res, pathname, method);
      return true;
    }

    if (method === 'GET' && pathname === '/api/v2/service') {
      sendV2(res, pathname, method, 200, serviceInfo({ serviceVersion, startedAt, pid, demo }));
      return true;
    }

    if (await handleProvidersApi({
      req,
      res,
      url,
      pathname,
      method,
      sendV2,
      readObjectBody,
    }, opts.providers || {})) {
      return true;
    }

    if (method === 'POST' && pathname === '/api/v2/service/restart') {
      let busy = false;
      try {
        busy = Boolean(await hasActiveWork());
      } catch (err) {
        const message = err instanceof Error ? err.message : 'active work check failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      if (busy) {
        sendV2(res, pathname, method, 409, { error: 'busy', code: 'E_BUSY' } satisfies V2Error);
        return true;
      }
      sendV2(res, pathname, method, 202, { exiting: true } satisfies RestartAccepted, () => {
        log.info('WEFT_SERVICE_RESTART', 'restart requested');
        opts.onRestart?.();
      });
      return true;
    }

    const settingsView = async (stored: unknown): Promise<CompactionSettingsView> => {
      const percent = readTriggerPercent(stored);
      const effective = opts.compactionEffective ? await opts.compactionEffective(percent) : [];
      return compactionSettingsView(stored, effective) as CompactionSettingsView;
    };

    if (method === 'GET' && pathname === '/api/v2/settings') {
      if (!opts.getSettings) {
        sendV2(res, pathname, method, 500, { error: 'settings not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const stored = await opts.getSettings();
        sendV2(res, pathname, method, 200, await settingsView(stored) satisfies components['schemas']['CompactionSettingsView']);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'read settings failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    if (method === 'PUT' && pathname === '/api/v2/settings') {
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      const extra = Object.keys(body).filter((key) => key !== 'compaction');
      if (extra.length) {
        sendV2(res, pathname, method, 400, { error: 'invalid body', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      const patch: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(body, 'compaction')) patch.compaction = body.compaction;
      const invalid = validateCompactionPatch(patch);
      if (invalid) {
        sendV2(res, pathname, method, 400, { error: invalid, code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      if (!opts.putSettings || !opts.getSettings) {
        sendV2(res, pathname, method, 500, { error: 'settings not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        if (Object.keys(patch).length) await opts.putSettings(patch);
        const stored = await opts.getSettings();
        sendV2(res, pathname, method, 200, await settingsView(stored) satisfies components['schemas']['CompactionSettingsView']);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'save settings failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/v2/workspaces') {
      try {
        let snapshot = await buildWorkspacesSnapshot(sidebarLoader(opts));
        if (opts.gitStatus) snapshot = await opts.gitStatus.overlay(snapshot);
        sendV2(res, pathname, method, 200, snapshot);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'list workspaces failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/v2/conversations') {
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      let title: string | undefined;
      if (Object.prototype.hasOwnProperty.call(body, 'title') && body.title != null) {
        if (typeof body.title !== 'string') {
          sendV2(res, pathname, method, 400, { error: 'invalid title', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        const trimmed = body.title.trim();
        if (trimmed) title = trimmed;
      }
      if (!opts.createChatConversation) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      const lang = normalizeLang(url.searchParams.get('lang')) === 'en' ? 'en' : 'zh';
      try {
        const created = await opts.createChatConversation(title ? { title, lang } : { lang });
        if (created.status !== 201 || !created.conv) {
          sendV2(res, pathname, method, created.status >= 400 ? created.status : 500, {
            error: 'create failed',
            code: 'E_INTERNAL',
          } satisfies V2Error);
          return true;
        }
        const conv = created.conv;
        const status = opts.statusOf ? await opts.statusOf(conv) : 'idle';
        const digests = opts.subagentDigests ? await opts.subagentDigests([conv]) : new Map();
        const cid = conv.id == null ? '' : String(conv.id);
        const summary = conversationSummaryView({
          conv,
          status,
          digest: cid ? digests.get(cid) : undefined,
        });
        opts.onSidebarChanged?.();
        sendV2(res, pathname, method, 201, summary);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'create failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const createConvMatch = /^\/api\/v2\/workspaces\/([^/]+)\/conversations$/.exec(pathname);
    if (method === 'POST' && createConvMatch) {
      const workspaceId = decodeURIComponent(createConvMatch[1]);
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      let title: string | undefined;
      if (Object.prototype.hasOwnProperty.call(body, 'title') && body.title != null) {
        if (typeof body.title !== 'string') {
          sendV2(res, pathname, method, 400, { error: 'invalid title', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        const trimmed = body.title.trim();
        if (trimmed) title = trimmed;
      }
      if (!opts.createConversation) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const created = await opts.createConversation(workspaceId, title ? { title } : {});
        if (created.status === 404 || !created.conv) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        if (created.status !== 201) {
          sendV2(res, pathname, method, created.status >= 400 ? created.status : 500, {
            error: 'create failed',
            code: 'E_INTERNAL',
          } satisfies V2Error);
          return true;
        }
        const conv = created.conv;
        const status = opts.statusOf ? await opts.statusOf(conv) : 'idle';
        const digests = opts.subagentDigests ? await opts.subagentDigests([conv]) : new Map();
        const cid = conv.id == null ? '' : String(conv.id);
        const summary = conversationSummaryView({
          conv,
          status,
          digest: cid ? digests.get(cid) : undefined,
        });
        opts.onSidebarChanged?.();
        sendV2(res, pathname, method, 201, summary);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'create failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    if (await handleOpenTerminalApi({
      req,
      res,
      url,
      pathname,
      method,
      sendV2: (response, requestPath, requestMethod, status, body) => {
        sendV2(response, requestPath, requestMethod, status, body as V2JsonBody);
      },
      readObjectBody,
      getWorkspace: opts.getWorkspace,
    })) return true;

    const uploadMatch = /^\/api\/v2\/workspaces\/([^/]+)\/uploads$/.exec(pathname);
    if (method === 'POST' && uploadMatch) {
      const workspaceId = decodeURIComponent(uploadMatch[1]);
      const body = await readObjectBody(req, res, pathname, method, UPLOAD_BODY_MAX_BYTES);
      if (!body) return true;
      const parsed = parseUploadBody(body);
      if (!parsed.ok) {
        sendV2(res, pathname, method, parsed.status || 400, {
          error: parsed.error,
          code: parsed.code,
        } satisfies V2Error);
        return true;
      }
      let ws: WorkspaceRow | null | undefined = null;
      try {
        ws = opts.getWorkspace ? await opts.getWorkspace(workspaceId) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'workspace check failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      const root = workspacePathOf(ws);
      if (!root) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      try {
        const saved = await saveWorkspaceUpload(root, parsed);
        sendV2(res, pathname, method, 201, saved satisfies UploadResult);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'upload failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const gitRefreshMatch = /^\/api\/v2\/workspaces\/([^/]+)\/git\/refresh$/.exec(pathname);
    if (method === 'POST' && gitRefreshMatch) {
      const workspaceId = decodeURIComponent(gitRefreshMatch[1]);
      let ws: WorkspaceRow | null | undefined = null;
      try {
        ws = opts.getWorkspace ? await opts.getWorkspace(workspaceId) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'workspace check failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      const root = workspacePathOf(ws);
      if (!root) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      try {
        if (opts.gitStatus && workspaceKindOf(ws) !== 'chat') {
          await opts.gitStatus.refresh(workspaceId, root);
        }
        let snapshot = await buildWorkspacesSnapshot(sidebarLoader(opts));
        if (opts.gitStatus) snapshot = await opts.gitStatus.overlay(snapshot);
        const view = snapshot.workspaces.find((row) => row.id === workspaceId);
        if (!view) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        opts.onSidebarChanged?.();
        sendV2(res, pathname, method, 200, view);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'git refresh failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const removeWsMatch = /^\/api\/v2\/workspaces\/([^/]+)$/.exec(pathname);
    if (method === 'DELETE' && removeWsMatch) {
      const workspaceId = decodeURIComponent(removeWsMatch[1]);
      let ws: WorkspaceRow | null | undefined = null;
      try {
        ws = opts.getWorkspace ? await opts.getWorkspace(workspaceId) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'workspace check failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      if (!ws || ws.removedAt != null) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      if (workspaceKindOf(ws) === 'chat') {
        sendV2(res, pathname, method, 400, {
          error: 'chat workspace cannot be removed',
          code: 'E_BAD_REQUEST',
        } satisfies V2Error);
        return true;
      }
      try {
        const convs = opts.listConversations ? await opts.listConversations(workspaceId) : [];
        const busy: string[] = [];
        for (const conv of convs) {
          const status = opts.statusOf ? String(await opts.statusOf(conv) || '') : '';
          if (status === 'running') busy.push(String(conv.id || ''));
        }
        if (busy.length) {
          sendV2(res, pathname, method, 409, {
            error: 'workspace has active conversations',
            code: 'E_WS_BUSY',
            conversations: busy,
          } satisfies WorkspaceBusy);
          return true;
        }
        if (!opts.removeWorkspace) {
          sendV2(res, pathname, method, 500, { error: 'store not ready', code: 'E_INTERNAL' } satisfies V2Error);
          return true;
        }
        await opts.removeWorkspace(workspaceId);
        opts.onSidebarChanged?.();
        sendV2(res, pathname, method, 200, { removed: true } satisfies WorkspaceRemoved);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'remove failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const treeMatch = /^\/api\/v2\/workspaces\/([^/]+)\/tree$/.exec(pathname);
    if (method === 'GET' && treeMatch) {
      const workspaceId = decodeURIComponent(treeMatch[1]);
      let ws: WorkspaceRow | null | undefined = null;
      try {
        ws = opts.getWorkspace ? await opts.getWorkspace(workspaceId) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'workspace check failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      const root = workspacePathOf(ws);
      if (!root) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      try {
        const dir = url.searchParams.get('dir');
        const tree = await workspaceTreeView(root, dir == null ? {} : { dir });
        sendV2(res, pathname, method, 200, tree);
      } catch (err) {
        if (sendFileOpError(res, pathname, method, err)) return true;
        const message = err instanceof Error ? err.message : 'tree failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const searchMatch = /^\/api\/v2\/workspaces\/([^/]+)\/file-search$/.exec(pathname);
    if (method === 'GET' && searchMatch) {
      const workspaceId = decodeURIComponent(searchMatch[1]);
      let ws: WorkspaceRow | null | undefined = null;
      try {
        ws = opts.getWorkspace ? await opts.getWorkspace(workspaceId) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'workspace check failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      const root = workspacePathOf(ws);
      if (!root) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      try {
        const found = await searchWorkspaceFiles(root, url.searchParams.get('q'), {
          limit: url.searchParams.get('limit'),
        });
        sendV2(res, pathname, method, 200, found satisfies FileSearchResult);
      } catch (err) {
        if (sendFileOpError(res, pathname, method, err)) return true;
        const message = err instanceof Error ? err.message : 'file search failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const rawMatch = /^\/api\/v2\/workspaces\/([^/]+)\/files\/raw$/.exec(pathname);
    if (method === 'GET' && rawMatch) {
      const workspaceId = decodeURIComponent(rawMatch[1]);
      const rel = url.searchParams.get('path');
      if (rel == null || rel === '') {
        sendV2(res, pathname, method, 400, { error: 'path required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      let ws: WorkspaceRow | null | undefined = null;
      try {
        ws = opts.getWorkspace ? await opts.getWorkspace(workspaceId) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'workspace check failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      const root = workspacePathOf(ws);
      if (!root) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      try {
        const image = await openWorkspaceImage(root, rel);
        await sendWorkspaceImage(req, res, image);
      } catch (err) {
        const code = errCode(err);
        if (code === 'E_MEDIA') {
          sendV2(res, pathname, method, 415, { error: 'unsupported media type', code: 'E_MEDIA' } satisfies V2Error);
          return true;
        }
        if (code === 'E_TOO_LARGE') {
          sendV2(res, pathname, method, 413, {
            error: `image exceeds ${WORKSPACE_IMAGE_MAX_BYTES} bytes`,
            code: 'E_TOO_LARGE',
          } satisfies V2Error);
          return true;
        }
        if (sendFileOpError(res, pathname, method, err)) return true;
        const message = err instanceof Error ? err.message : 'read failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const filesMatch = /^\/api\/v2\/workspaces\/([^/]+)\/files$/.exec(pathname);
    if (method === 'GET' && filesMatch) {
      const workspaceId = decodeURIComponent(filesMatch[1]);
      const rel = url.searchParams.get('path');
      if (rel == null || rel === '') {
        sendV2(res, pathname, method, 400, { error: 'path required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      let ws: WorkspaceRow | null | undefined = null;
      try {
        ws = opts.getWorkspace ? await opts.getWorkspace(workspaceId) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'workspace check failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      const root = workspacePathOf(ws);
      if (!root) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      try {
        const file = await readWorkspaceFile(root, rel);
        sendV2(res, pathname, method, 200, file);
      } catch (err) {
        if (sendFileOpError(res, pathname, method, err)) return true;
        const message = err instanceof Error ? err.message : 'read failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }
    if (method === 'PUT' && filesMatch) {
      const workspaceId = decodeURIComponent(filesMatch[1]);
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      if (typeof body.path !== 'string' || body.path === '') {
        sendV2(res, pathname, method, 400, { error: 'path required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      if (typeof body.text !== 'string') {
        sendV2(res, pathname, method, 400, { error: 'text required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      let baseVersion: string | undefined;
      if (Object.prototype.hasOwnProperty.call(body, 'baseVersion') && body.baseVersion != null) {
        if (typeof body.baseVersion !== 'string') {
          sendV2(res, pathname, method, 400, { error: 'invalid baseVersion', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        baseVersion = body.baseVersion;
      }
      let ws: WorkspaceRow | null | undefined = null;
      try {
        ws = opts.getWorkspace ? await opts.getWorkspace(workspaceId) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'workspace check failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      const root = workspacePathOf(ws);
      if (!root) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      try {
        const saved = await saveWorkspaceFile({
          root,
          path: body.path,
          text: body.text,
          baseVersion,
        });
        try {
          const convs = opts.listConversations ? await opts.listConversations(workspaceId) : [];
          for (const conv of convs) {
            const cid = conv.id == null ? '' : String(conv.id);
            if (cid) opts.notifyConversation?.(cid);
          }
        } catch (err) {
          log.error('WEFT_V2_FILE_NOTIFY', '', err);
        }
        sendV2(res, pathname, method, 200, saved);
      } catch (err) {
        if (sendFileOpError(res, pathname, method, err)) return true;
        const message = err instanceof Error ? err.message : 'save failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const convMatch = /^\/api\/v2\/conversations\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && convMatch) {
      const id = decodeURIComponent(convMatch[1]);
      let loaded: Awaited<ReturnType<LoadConversation>> = null;
      try {
        loaded = opts.loadConversation ? await opts.loadConversation(id) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'load conversation failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      if (!loaded) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      const lang = normalizeLang(url.searchParams.get('lang')) === 'en' ? 'en' : 'zh';
      try {
        const snapshot = await conversationSnapshot({ ...loaded, lang });
        sendV2(res, pathname, method, 200, snapshot);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'snapshot failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }
    if (method === 'PATCH' && convMatch) {
      const id = decodeURIComponent(convMatch[1]);
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      const hasModel = Object.prototype.hasOwnProperty.call(body, 'model');
      const hasThinking = Object.prototype.hasOwnProperty.call(body, 'thinkingLevel');
      const hasArchived = Object.prototype.hasOwnProperty.call(body, 'archived');
      if (!hasModel && !hasThinking && !hasArchived) {
        sendV2(res, pathname, method, 400, { error: 'model, thinkingLevel or archived required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      if (hasArchived && typeof body.archived !== 'boolean') {
        sendV2(res, pathname, method, 400, { error: 'archived must be a boolean', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      const kernelBody: Record<string, unknown> = {};
      if (hasModel) {
        if (body.model === null) {
          kernelBody.modelSourceId = null;
          kernelBody.modelId = null;
        } else if (body.model && typeof body.model === 'object' && !Array.isArray(body.model)) {
          const model = body.model as Record<string, unknown>;
          kernelBody.modelSourceId = model.providerId;
          kernelBody.modelId = model.modelId;
        } else {
          sendV2(res, pathname, method, 400, { error: 'invalid model', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
      }
      if (hasThinking) kernelBody.thinkingLevel = body.thinkingLevel;
      if (hasArchived) kernelBody.archived = body.archived;
      if (!opts.patchConversation) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const patched = await opts.patchConversation(id, kernelBody);
        if (patched.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        if (patched.status === 409) {
          sendV2(res, pathname, method, 409, {
            error: String(patched.body?.error || 'conversation is running'),
            code: 'E_CONVERSATION_RUNNING',
          } satisfies V2Error);
          return true;
        }
        if (patched.status === 400) {
          const errors = patched.body?.errors;
          const first = Array.isArray(errors) && errors.length ? String(errors[0]) : String(patched.body?.error || 'invalid model');
          sendV2(res, pathname, method, 400, { error: first, code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        if (patched.status >= 400) {
          sendV2(res, pathname, method, patched.status, {
            error: String(patched.body?.error || 'patch failed'),
            code: 'E_INTERNAL',
          } satisfies V2Error);
          return true;
        }
        let loaded: Awaited<ReturnType<LoadConversation>> = null;
        loaded = opts.loadConversation ? await opts.loadConversation(id) : null;
        if (!loaded) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        const lang = normalizeLang(url.searchParams.get('lang')) === 'en' ? 'en' : 'zh';
        const snapshot = await conversationSnapshot({ ...loaded, lang });
        opts.notifyConversation?.(id);
        opts.onSidebarChanged?.();
        sendV2(res, pathname, method, 200, snapshot.conversation);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'patch failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    if (method === 'DELETE' && convMatch) {
      const id = decodeURIComponent(convMatch[1]);
      if (!opts.deleteConversation) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const removed = await opts.deleteConversation(id);
        if (removed.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        if (removed.status === 409) {
          sendV2(res, pathname, method, 409, {
            error: String(removed.body?.error || 'conversation is running'),
            code: 'E_CONVERSATION_RUNNING',
          } satisfies V2Error);
          return true;
        }
        if (removed.status !== 204) {
          sendV2(res, pathname, method, removed.status >= 400 ? removed.status : 500, {
            error: String(removed.body?.error || 'delete failed'),
            code: 'E_INTERNAL',
          } satisfies V2Error);
          return true;
        }
        // The conversation topic recomputes against a missing conversation and removes every entity.
        opts.notifyConversation?.(id);
        opts.onSidebarChanged?.();
        sendV2(res, pathname, method, 204, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'delete failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const diffMatch = /^\/api\/v2\/conversations\/([^/]+)\/diff$/.exec(pathname);
    if (method === 'GET' && diffMatch) {
      const id = decodeURIComponent(diffMatch[1]);
      const filePath = url.searchParams.get('path');
      if (filePath == null || filePath === '') {
        sendV2(res, pathname, method, 400, { error: 'path required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      if (!opts.getConversation) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      let conv: ConversationRow | null | undefined = null;
      try {
        conv = await opts.getConversation(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'load conversation failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      if (!conv) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      try {
        const rows = opts.changesConversation ? await opts.changesConversation(id) : [];
        const hit = findKernelChange(rows, filePath);
        if (!hit) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        const originalPath = hit.path == null ? posixPath(filePath) : String(hit.path);
        const result = opts.diffConversation
          ? await opts.diffConversation(id, originalPath)
          : { status: 404, body: undefined };
        if (result.status === 404 || result.body == null) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        sendV2(res, pathname, method, 200, diffView(result.body, originalPath));
      } catch (err) {
        if (sendFileOpError(res, pathname, method, err)) return true;
        const message = err instanceof Error ? err.message : 'diff failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const imageMatch = /^\/api\/v2\/conversations\/([^/]+)\/messages\/([^/]+)\/images\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && imageMatch) {
      const id = decodeURIComponent(imageMatch[1]);
      const messageId = decodeURIComponent(imageMatch[2]);
      const indexRaw = decodeURIComponent(imageMatch[3]);
      const index = Number(indexRaw);
      if (!Number.isInteger(index) || index < 0 || String(index) !== indexRaw) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      if (!opts.getMessageImage) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const image = await opts.getMessageImage(id, messageId, index);
        const mediaType = normalizeMediaType(image?.mediaType);
        const data = typeof image?.data === 'string' ? image.data : '';
        if (!image || !mediaType || !data || decodedBase64Bytes(data) == null) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        sendImageBytes(req, res, mediaType, Buffer.from(data.replace(/\s+/g, ''), 'base64'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'load image failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const pasteMatch = /^\/api\/v2\/conversations\/([^/]+)\/messages\/([^/]+)\/pastes\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && pasteMatch) {
      const id = decodeURIComponent(pasteMatch[1]);
      const messageId = decodeURIComponent(pasteMatch[2]);
      const indexRaw = decodeURIComponent(pasteMatch[3]);
      const index = Number(indexRaw);
      if (!Number.isInteger(index) || index < 0 || String(index) !== indexRaw) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      if (!opts.getMessagePaste) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const paste = await opts.getMessagePaste(id, messageId, index);
        if (paste == null || typeof paste !== 'string') {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        sendCachedBytes(req, res, 'text/plain; charset=utf-8', Buffer.from(paste, 'utf8'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'load paste failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const messagesMatch = /^\/api\/v2\/conversations\/([^/]+)\/messages$/.exec(pathname);
    const continueMatch = /^\/api\/v2\/conversations\/([^/]+)\/continue$/.exec(pathname);
    if (method === 'POST' && (messagesMatch || continueMatch)) {
      const id = decodeURIComponent((messagesMatch || continueMatch)![1]);
      const body = await readObjectBody(
        req,
        res,
        pathname,
        method,
        messagesMatch ? MESSAGE_BODY_MAX_BYTES : 1_000_000,
      );
      if (!body) return true;
      const parsedId = requestIdFrom(body);
      if (!parsedId.ok) {
        sendV2(res, pathname, method, 400, { error: 'invalid requestId', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      let text = '';
      let content: unknown = '';
      let answer: Record<string, unknown> | undefined;
      let sendImages: MessageImage[] = [];
      let sendPastes: string[] = [];
      let sendFiles: Array<{ path: string; name?: string; bytes?: number }> = [];
      const continuing = Boolean(continueMatch);
      if (!continuing) {
        if (body.text != null && typeof body.text !== 'string') {
          sendV2(res, pathname, method, 400, { error: 'text required', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        text = String(body.text ?? '').trim();
        const parsedImages = parseSendImages(body.images);
        if (!parsedImages.ok) {
          sendV2(res, pathname, method, 400, {
            error: parsedImages.error,
            code: parsedImages.code,
          } satisfies V2Error);
          return true;
        }
        const parsedPastes = parseSendPastes(body.pastes);
        if (!parsedPastes.ok) {
          sendV2(res, pathname, method, 400, {
            error: parsedPastes.error,
            code: parsedPastes.code,
          } satisfies V2Error);
          return true;
        }
        const parsedFiles = parseSendFiles(body.files);
        if (!parsedFiles.ok) {
          sendV2(res, pathname, method, 400, {
            error: parsedFiles.error,
            code: parsedFiles.code,
          } satisfies V2Error);
          return true;
        }
        if (body.answer != null) {
          if (typeof body.answer !== 'object' || Array.isArray(body.answer)) {
            sendV2(res, pathname, method, 400, { error: 'invalid answer', code: 'E_BAD_REQUEST' } satisfies V2Error);
            return true;
          }
          answer = body.answer as Record<string, unknown>;
          if (
            parsedImages.images.length > 0
            || parsedPastes.pastes.length > 0
            || parsedFiles.files.length > 0
          ) {
            sendV2(res, pathname, method, 400, {
              error: 'answer cannot include attachments',
              code: 'E_BAD_REQUEST',
            } satisfies V2Error);
            return true;
          }
        }
        if (
          !answer
          && !text
          && parsedImages.images.length === 0
          && parsedPastes.pastes.length === 0
          && parsedFiles.files.length === 0
        ) {
          sendV2(res, pathname, method, 400, { error: 'text required', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        sendImages = parsedImages.images;
        sendPastes = parsedPastes.pastes;
        sendFiles = parsedFiles.files;
      }
      let conv: ConversationRow | null | undefined = null;
      try {
        conv = opts.getConversation ? await opts.getConversation(id) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'load conversation failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      if (!conv) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      let ready = false;
      try {
        ready = await workspaceReady(conv, opts.getWorkspace);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'workspace check failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      if (!ready) {
        sendV2(res, pathname, method, 409, { error: 'no workspace', code: 'E_NO_WORKSPACE' } satisfies V2Error);
        return true;
      }
      if (messagesMatch) {
        let attached: Array<{ path: string; name: string; bytes: number }> = [];
        if (sendFiles.length) {
          let ws: WorkspaceRow | null | undefined = null;
          try {
            ws = opts.getWorkspace ? await opts.getWorkspace(workspaceIdOf(conv)) : null;
          } catch (err) {
            const message = err instanceof Error ? err.message : 'workspace check failed';
            sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
            return true;
          }
          const root = workspacePathOf(ws);
          if (!root) {
            sendV2(res, pathname, method, 409, { error: 'no workspace', code: 'E_NO_WORKSPACE' } satisfies V2Error);
            return true;
          }
          let resolved;
          try {
            resolved = await resolveSendFiles(root, sendFiles);
          } catch (err) {
            const message = err instanceof Error ? err.message : 'resolve files failed';
            sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
            return true;
          }
          if (!resolved.ok) {
            sendV2(res, pathname, method, 400, {
              error: resolved.error,
              code: resolved.code,
            } satisfies V2Error);
            return true;
          }
          attached = resolved.files;
        }
        content = assembleUserContent(text, sendImages, {
          pastes: sendPastes,
          files: attached,
        });
      }
      const requestId = parsedId.value || randomUUID();
      if (!opts.postMessage) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      let mode: SendMode = 'steer';
      if (messagesMatch) {
        const parsedMode = sendModeFrom(body);
        if (!parsedMode.ok) {
          sendV2(res, pathname, method, 400, { error: 'invalid mode', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        mode = parsedMode.value;
      }
      try {
        const posted = await opts.postMessage(conv, text, {
          requestId,
          content,
          mode,
          answer,
          continue: continuing,
        });
        if (posted.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        if (posted.status === 400 || posted.status === 409) {
          const code = typeof posted.body?.code === 'string' && posted.body.code
            ? posted.body.code
            : (posted.status === 409 ? 'E_ASK_ANSWERED' : 'E_BAD_REQUEST');
          const error = typeof posted.body?.error === 'string' && posted.body.error
            ? posted.body.error
            : (posted.status === 409 ? 'already answered' : 'bad request');
          sendV2(res, pathname, method, posted.status, { error, code } satisfies V2Error);
          return true;
        }
        const runId = posted.body?.runId;
        if (posted.status !== 202 || runId == null || String(runId) === '') {
          const message = posted.status >= 400 ? 'send failed' : 'missing runId';
          sendV2(res, pathname, method, posted.status >= 400 ? posted.status : 500, {
            error: message,
            code: posted.status === 409 ? 'E_NO_WORKSPACE' : 'E_INTERNAL',
          } satisfies V2Error);
          return true;
        }
        opts.notifyConversation?.(id);
        if (conv.archived) opts.onSidebarChanged?.();
        sendV2(res, pathname, method, 202, { runId: String(runId) } satisfies RunAccepted);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'send failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const withdrawMatch = /^\/api\/v2\/conversations\/([^/]+)\/messages\/([^/]+)$/.exec(pathname);
    if (method === 'DELETE' && withdrawMatch) {
      const id = decodeURIComponent(withdrawMatch[1]);
      const requestId = decodeURIComponent(withdrawMatch[2]);
      if (!requestId) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      if (!opts.withdrawMessage) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const withdrawn = await opts.withdrawMessage(id, requestId);
        if (withdrawn.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        if (withdrawn.status === 409) {
          sendV2(res, pathname, method, 409, {
            error: 'already landed',
            code: 'E_ALREADY_LANDED',
          } satisfies V2Error);
          return true;
        }
        if (withdrawn.status !== 200) {
          sendV2(res, pathname, method, withdrawn.status >= 400 ? withdrawn.status : 500, {
            error: 'withdraw failed',
            code: 'E_INTERNAL',
          } satisfies V2Error);
          return true;
        }
        opts.notifyConversation?.(id);
        sendV2(res, pathname, method, 200, { ok: true } satisfies components['schemas']['WithdrawAccepted']);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'withdraw failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const stopMatch = /^\/api\/v2\/conversations\/([^/]+)\/stop$/.exec(pathname);
    if (method === 'POST' && stopMatch) {
      const id = decodeURIComponent(stopMatch[1]);
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      if (!opts.stopConversation) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const stopped = await opts.stopConversation(id);
        if (stopped.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        sendV2(res, pathname, method, 202, { stopping: true } satisfies StopAccepted);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'stop failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const forkMatch = /^\/api\/v2\/conversations\/([^/]+)\/fork$/.exec(pathname);
    if (method === 'POST' && forkMatch) {
      const id = decodeURIComponent(forkMatch[1]);
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      if (!Object.prototype.hasOwnProperty.call(body, 'entryId') || typeof body.entryId !== 'string') {
        sendV2(res, pathname, method, 400, { error: 'entryId is required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      const entryId = body.entryId.trim();
      if (!entryId) {
        sendV2(res, pathname, method, 400, { error: 'entryId is required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      const parsedId = requestIdFrom(body);
      if (!parsedId.ok) {
        sendV2(res, pathname, method, 400, { error: 'invalid requestId', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      if (!opts.forkConversation) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      let lang: 'zh' | 'en' = normalizeLang(url.searchParams.get('lang')) === 'en' ? 'en' : 'zh';
      if (!url.searchParams.has('lang') && opts.getSettings) {
        try {
          const stored = await opts.getSettings();
          if (stored && typeof stored === 'object' && (stored as { language?: unknown }).language === 'en') lang = 'en';
        } catch { /* keep zh */ }
      }
      try {
        const forked = await opts.forkConversation(id, {
          entryId,
          requestId: parsedId.value,
          lang,
        });
        if (forked.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        if (forked.status === 400) {
          const code = typeof forked.body?.code === 'string' && forked.body.code
            ? forked.body.code
            : 'E_BAD_REQUEST';
          const error = typeof forked.body?.error === 'string' && forked.body.error
            ? forked.body.error
            : 'bad request';
          sendV2(res, pathname, method, 400, { error, code } satisfies V2Error);
          return true;
        }
        const conversationId = forked.body?.conversationId == null ? '' : String(forked.body.conversationId);
        const prefill = forked.body?.prefill == null
          ? null
          : { text: forked.body.prefill.text == null ? '' : String(forked.body.prefill.text) };
        if (forked.status !== 201 || !conversationId) {
          const message = typeof forked.body?.error === 'string' && forked.body.error
            ? forked.body.error
            : 'fork failed';
          const code = typeof forked.body?.code === 'string' && forked.body.code
            ? forked.body.code
            : 'E_INTERNAL';
          sendV2(res, pathname, method, forked.status >= 400 ? forked.status : 500, {
            error: message,
            code,
          } satisfies V2Error);
          return true;
        }
        opts.onSidebarChanged?.();
        sendV2(res, pathname, method, 201, {
          conversationId,
          prefill,
        } satisfies ForkConversationResponse);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'fork failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const compactMatch = /^\/api\/v2\/conversations\/([^/]+)\/compact$/.exec(pathname);
    if (method === 'POST' && compactMatch) {
      const id = decodeURIComponent(compactMatch[1]);
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      let instructions: string | undefined;
      if (Object.prototype.hasOwnProperty.call(body, 'instructions') && body.instructions != null) {
        if (typeof body.instructions !== 'string') {
          sendV2(res, pathname, method, 400, { error: 'invalid instructions', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        const trimmed = body.instructions.trim();
        if (trimmed) instructions = trimmed;
      }
      if (!opts.compactConversation) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const compacted = await opts.compactConversation(id, instructions);
        if (compacted.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found', code: 'E_NOT_FOUND' } satisfies V2Error);
          return true;
        }
        if (compacted.status === 409) {
          sendV2(res, pathname, method, 409, { error: 'busy', code: 'E_BUSY' } satisfies V2Error);
          return true;
        }
        const taskId = compacted.body?.taskId == null ? '' : String(compacted.body.taskId);
        if (compacted.status !== 202 || !taskId) {
          const message = typeof compacted.body?.error === 'string' && compacted.body.error
            ? compacted.body.error
            : 'compact failed';
          const code = typeof compacted.body?.code === 'string' && compacted.body.code
            ? compacted.body.code
            : 'E_INTERNAL';
          sendV2(res, pathname, method, compacted.status >= 400 ? compacted.status : 500, {
            error: message,
            code,
          } satisfies V2Error);
          return true;
        }
        opts.notifyConversation?.(id);
        sendV2(res, pathname, method, 202, { taskId } satisfies components['schemas']['CompactAccepted']);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'compact failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const handoffMatch = /^\/api\/v2\/conversations\/([^/]+)\/handoff$/.exec(pathname);
    if (method === 'POST' && handoffMatch) {
      const id = decodeURIComponent(handoffMatch[1]);
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      if (typeof body.requestId !== 'string' || !body.requestId.trim()) {
        sendV2(res, pathname, method, 400, { error: 'requestId required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'instructions') && body.instructions != null) {
        if (typeof body.instructions !== 'string') {
          sendV2(res, pathname, method, 400, { error: 'invalid instructions', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        if (body.instructions.length > 4000) {
          sendV2(res, pathname, method, 400, { error: 'instructions too long', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
      }
      if (!opts.handoffConversation) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      const requestId = body.requestId.trim();
      const instructions = typeof body.instructions === 'string' && body.instructions.trim()
        ? body.instructions.trim()
        : undefined;
      try {
        const handed = await opts.handoffConversation(id, { requestId, instructions });
        if (handed.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found', code: 'E_NOT_FOUND' } satisfies V2Error);
          return true;
        }
        if (handed.status === 409) {
          sendV2(res, pathname, method, 409, { error: 'busy', code: 'E_BUSY' } satisfies V2Error);
          return true;
        }
        if (handed.status === 400) {
          const message = typeof handed.body?.error === 'string' && handed.body.error
            ? handed.body.error
            : 'bad request';
          sendV2(res, pathname, method, 400, { error: message, code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        if (handed.status !== 202) {
          const message = typeof handed.body?.error === 'string' && handed.body.error
            ? handed.body.error
            : 'handoff failed';
          const code = typeof handed.body?.code === 'string' && handed.body.code
            ? handed.body.code
            : 'E_INTERNAL';
          sendV2(res, pathname, method, handed.status >= 400 ? handed.status : 500, {
            error: message,
            code,
          } satisfies V2Error);
          return true;
        }
        opts.notifyConversation?.(id);
        sendV2(res, pathname, method, 202, { ok: true } satisfies components['schemas']['HandoffAccepted']);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'handoff failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const toolOutMatch = /^\/api\/v2\/conversations\/([^/]+)\/tools\/([^/]+)\/output$/.exec(pathname);
    if (method === 'GET' && toolOutMatch) {
      const id = decodeURIComponent(toolOutMatch[1]);
      const toolId = decodeURIComponent(toolOutMatch[2]);
      let loaded: Awaited<ReturnType<LoadConversation>> = null;
      try {
        loaded = opts.loadConversation ? await opts.loadConversation(id) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'load conversation failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      if (!loaded) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      let tool = findPresentedTool(loaded.presented, toolId);
      if (!tool && opts.loadSubagent) {
        const agents = Array.isArray(loaded.subagents) ? loaded.subagents : [];
        for (const agent of agents) {
          const agentId = agent?.id == null ? '' : String(agent.id);
          if (!agentId) continue;
          try {
            const child = await opts.loadSubagent(id, agentId);
            tool = findPresentedTool({ messages: child?.messages }, toolId);
          } catch (err) {
            log.error('WEFT_V2_TOOL_OUTPUT', `${id} ${agentId}`, err);
            continue;
          }
          if (tool) break;
        }
      }
      if (!tool) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      const output: ToolOutput = toolOutputView(tool, loaded.presented?.workspacePath);
      sendV2(res, pathname, method, 200, output);
      return true;
    }

    const subGetMatch = /^\/api\/v2\/conversations\/([^/]+)\/subagents\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && subGetMatch) {
      const id = decodeURIComponent(subGetMatch[1]);
      const agentId = decodeURIComponent(subGetMatch[2]);
      let loaded: Awaited<ReturnType<LoadSubagent>> = null;
      try {
        loaded = opts.loadSubagent ? await opts.loadSubagent(id, agentId) : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'load subagent failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      if (!loaded) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      const lang = normalizeLang(url.searchParams.get('lang')) === 'en' ? 'en' : 'zh';
      try {
        const snapshot = await subagentSnapshot({ ...loaded, lang });
        sendV2(res, pathname, method, 200, snapshot);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'snapshot failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const subMsgMatch = /^\/api\/v2\/conversations\/([^/]+)\/subagents\/([^/]+)\/messages$/.exec(pathname);
    if (method === 'POST' && subMsgMatch) {
      const id = decodeURIComponent(subMsgMatch[1]);
      const agentId = decodeURIComponent(subMsgMatch[2]);
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      if (body.text != null && typeof body.text !== 'string') {
        sendV2(res, pathname, method, 400, { error: 'text required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      const text = String(body.text ?? '').trim();
      if (!text) {
        sendV2(res, pathname, method, 400, { error: 'text required', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      if (!opts.sendToAgent) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const posted = await opts.sendToAgent(id, agentId, text);
        if (posted.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        if (posted.status === 400) {
          sendV2(res, pathname, method, 400, { error: 'text required', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        if (posted.status === 409) {
          sendV2(res, pathname, method, 409, { error: 'agent not running' } satisfies V2Error);
          return true;
        }
        if (posted.status !== 200 && posted.status !== 202) {
          sendV2(res, pathname, method, posted.status >= 400 ? posted.status : 500, {
            error: 'send failed',
            code: 'E_INTERNAL',
          } satisfies V2Error);
          return true;
        }
        sendV2(res, pathname, method, 202, { ok: true } satisfies SubagentMessageAccepted);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'send failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    const subStopMatch = /^\/api\/v2\/conversations\/([^/]+)\/subagents\/([^/]+)\/stop$/.exec(pathname);
    if (method === 'POST' && subStopMatch) {
      const id = decodeURIComponent(subStopMatch[1]);
      const agentId = decodeURIComponent(subStopMatch[2]);
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      if (!opts.stopAgent) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const stopped = await opts.stopAgent(id, agentId);
        if (stopped.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        sendV2(res, pathname, method, 202, { stopping: true } satisfies StopAccepted);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'stop failed';
        sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
      }
      return true;
    }

    if (await handleSchedulesApi({
      req,
      res,
      url,
      pathname,
      method,
      sendV2: (response, requestPath, requestMethod, status, body) => {
        sendV2(response, requestPath, requestMethod, status, body as V2JsonBody);
      },
      readObjectBody,
      host: opts.schedules,
      onChanged: opts.onSchedulesChanged,
    })) return true;

    if (await handleExtensionsApi({
      req,
      res,
      url,
      pathname,
      method,
      sendV2: (response, requestPath, requestMethod, status, body) => {
        sendV2(response, requestPath, requestMethod, status, body as V2JsonBody);
      },
      readObjectBody,
      host: opts.extensions,
      onSidebarChanged: opts.onSidebarChanged,
      onExtensionsChanged: opts.onExtensionsChanged,
    })) return true;

    if (method === 'GET' && pathname === '/api/v2/events') {
      const topics = parseTopics(url.searchParams.get('topics'));
      const unknown = topics.filter((topic) => !hub.hasTopic(topic));
      if (!topics.length || unknown.length) {
        sendV2(res, pathname, method, 400, {
          error: topics.length ? `unknown topic: ${unknown.join(',')}` : 'topics required',
          code: 'E_BAD_REQUEST',
        } satisfies V2Error);
        return true;
      }
      const lang = normalizeLang(url.searchParams.get('lang'));
      const lastEventId = headerOrQueryLastEventId(req, url);
      res.writeHead(200, sseHeaders());
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const session = hub.connect({
        topics,
        lang,
        lastEventId,
        send(frame) {
          writeSseFrame(res, frame);
        },
      });
      let closed = false;
      const onClose = () => {
        if (closed) return;
        closed = true;
        session.close();
      };
      req.on('close', onClose);
      res.on('close', onClose);
      return true;
    }

    sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
    return true;
  };
}

export function createV2Runtime(opts: {
  serviceVersion: string;
  startedAt: number;
  dataDir: string;
  pid?: number;
  now?: () => number;
  webCodeTtlMs?: number;
  env?: NodeJS.ProcessEnv;
  hasActiveWork?: () => boolean | Promise<boolean>;
  onRestart?: () => void;
  loadConversation?: LoadConversation;
  getConversation?: GetConversation;
  getMessageImage?: GetMessageImage;
  getMessagePaste?: GetMessagePaste;
  getWorkspace?: GetWorkspace;
  postMessage?: PostMessage;
  withdrawMessage?: WithdrawMessageFn;
  stopConversation?: StopConversationFn;
  subscribeConversation?: (cid: string, fn: (ev: KernelEvent) => void) => () => void;
  listWorkspaces?: ListWorkspacesFn;
  listConversations?: ListConversationsFn;
  statusOf?: StatusOfFn;
  subagentDigests?: SubagentDigestsFn;
  createConversation?: CreateConversationFn;
  createChatConversation?: CreateChatConversationFn;
  removeWorkspace?: RemoveWorkspaceFn;
  subscribeAll?: SubscribeAllFn;
  loadSubagent?: LoadSubagent;
  sendToAgent?: SendToAgentFn;
  stopAgent?: StopAgentFn;
  demo?: boolean;
  changesConversation?: ChangesConversationFn;
  diffConversation?: DiffConversationFn;
  patchConversation?: PatchConversationFn;
  providerService?: ProviderServiceLike | null;
  extensions?: ExtensionsHost;
  getSettings?: () => Promise<unknown>;
  putSettings?: (patch: Record<string, unknown>) => Promise<unknown>;
  compactionEffective?: (percent: number) => Promise<CompactionSettingsView['compaction']['effective']>;
  compactConversation?: (
    id: string,
    instructions?: string,
  ) => Promise<{ status: number; body?: { taskId?: unknown; error?: unknown; code?: unknown } }>;
  handoffConversation?: (
    id: string,
    body: { requestId?: unknown; instructions?: unknown },
  ) => Promise<{ status: number; body?: { ok?: unknown; error?: unknown; code?: unknown } }>;
  forkConversation?: ForkConversationFn;
  schedules?: SchedulesHost;
  deleteConversation?: DeleteConversationFn;
}): V2Runtime {
  const pid = opts.pid ?? process.pid;
  const auth = createV2Auth({
    localToken: generateLocalToken(),
    now: opts.now,
    webCodeTtlMs: opts.webCodeTtlMs ?? resolveWebCodeTtlMs(),
  });
  const hub = createEventHub({ protocolVersion: PROTOCOL_VERSION });
  hub.register('service', {
    snapshot() {
      return [{
        entity: 'service',
        id: 'self',
        value: serviceInfo({
          serviceVersion: opts.serviceVersion,
          startedAt: opts.startedAt,
          pid,
          demo: Boolean(opts.demo),
        }),
      }];
    },
  });
  const stuck = createStuckWatch({ now: opts.now });
  const stall = createStallWatch({ now: opts.now });
  const conversationTopic = attachConversationTopic(hub, {
    loadConversation: opts.loadConversation,
    loadChanges: opts.changesConversation,
    subscribe: opts.subscribeConversation,
    now: opts.now,
    stuck,
    stall,
  });
  const subagentTopic = attachSubagentTopic(hub, {
    loadSubagent: opts.loadSubagent,
    subscribe: opts.subscribeConversation,
    now: opts.now,
    stuck,
  });
  const gitStatus = createGitStatusCache();
  const workspacesTopic = attachWorkspacesTopic(hub, {
    loader: sidebarLoader(opts),
    subscribeAll: opts.subscribeAll,
    gitStatus,
    getConversation: opts.getConversation,
    getWorkspace: opts.getWorkspace,
  });
  const providersTopic = attachProvidersTopic(hub, {
    loader: {
      listProviders: () => (opts.providerService
        ? opts.providerService.listProviders()
        : Promise.resolve([])),
      getDefaultModel: () => (opts.providerService
        ? opts.providerService.getDefaultModel()
        : Promise.resolve(null)),
    },
  });
  async function notifyAllConversations(): Promise<void> {
    try {
      const workspaces = opts.listWorkspaces ? await opts.listWorkspaces() : [];
      for (const ws of workspaces) {
        const wid = ws.id == null ? '' : String(ws.id);
        if (!wid) continue;
        const convs = opts.listConversations ? await opts.listConversations(wid) : [];
        for (const conv of convs) {
          const cid = conv.id == null ? '' : String(conv.id);
          if (cid) conversationTopic.notify(cid);
        }
      }
    } catch (err) {
      log.error('WEFT_V2_PROVIDERS_CONV_NOTIFY', '', err);
    }
  }
  function notifyProvidersChanged(): void {
    providersTopic.notify();
    void notifyAllConversations();
  }
  const extensionsTopic = attachExtensionsTopic(hub, {
    load: opts.extensions ? () => loadExtensionsSnapshot(opts.extensions as ExtensionsHost) : undefined,
  });
  const schedulesHost = lazySchedulesHost(() => opts.schedules);
  const schedulesTopic = attachSchedulesTopic(hub, { load: () => schedulesHost.list() });
  const handleApi = createV2Handler({
    serviceVersion: opts.serviceVersion,
    startedAt: opts.startedAt,
    auth,
    hub,
    pid,
    hasActiveWork: opts.hasActiveWork,
    onRestart: opts.onRestart,
    loadConversation: opts.loadConversation,
    getConversation: opts.getConversation,
    getMessageImage: opts.getMessageImage,
    getMessagePaste: opts.getMessagePaste,
    getWorkspace: opts.getWorkspace,
    postMessage: opts.postMessage,
    withdrawMessage: opts.withdrawMessage,
    stopConversation: opts.stopConversation,
    listWorkspaces: opts.listWorkspaces,
    listConversations: opts.listConversations,
    statusOf: opts.statusOf,
    subagentDigests: opts.subagentDigests,
    createConversation: opts.createConversation,
    createChatConversation: opts.createChatConversation,
    removeWorkspace: opts.removeWorkspace,
    onSidebarChanged: () => workspacesTopic.notify(),
    loadSubagent: opts.loadSubagent,
    sendToAgent: opts.sendToAgent,
    stopAgent: opts.stopAgent,
    demo: opts.demo,
    changesConversation: opts.changesConversation,
    diffConversation: opts.diffConversation,
    notifyConversation: (cid) => conversationTopic.notify(cid),
    patchConversation: opts.patchConversation,
    providers: {
      get service() {
        return opts.providerService;
      },
      onProvidersChanged: notifyProvidersChanged,
    },
    extensions: opts.extensions,
    onExtensionsChanged: () => extensionsTopic.notify(),
    schedules: schedulesHost,
    onSchedulesChanged: () => schedulesTopic.notify(),
    gitStatus,
    getSettings: opts.getSettings,
    putSettings: opts.putSettings,
    compactionEffective: opts.compactionEffective,
    compactConversation: opts.compactConversation,
    handoffConversation: opts.handoffConversation,
    forkConversation: opts.forkConversation,
    deleteConversation: opts.deleteConversation,
  });

  return {
    handleApi,
    handleLogin(req, res, url) {
      return handleNextLogin(req, res, url, auth);
    },
    issueStartupLoginUrl(port: number) {
      const issued = auth.issueWebCode(resolveStartupCodeTtlMs(opts.env));
      return `http://127.0.0.1:${port}/auth?code=${encodeURIComponent(issued.code)}`;
    },
    writeDiscoveryFile(port: number) {
      writeDiscoverySync(opts.dataDir, {
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion: opts.serviceVersion,
        pid,
        port,
        startedAt: opts.startedAt,
        token: auth.localToken,
      });
    },
    removeDiscoveryFile() {
      removeDiscoverySync(opts.dataDir, pid);
    },
    notifySidebarChanged() {
      workspacesTopic.notify();
    },
    notifyProvidersChanged,
    notifyConversation(cid) {
      conversationTopic.notify(cid);
    },
    notifyExtensionsChanged() {
      extensionsTopic.notify();
    },
    notifySchedulesChanged() {
      schedulesTopic.notify();
    },
    dispose() {
      schedulesTopic.dispose();
      workspacesTopic.dispose();
      providersTopic.dispose();
      extensionsTopic.dispose();
      conversationTopic.dispose();
      subagentTopic.dispose();
      stuck.dispose();
      stall.dispose();
      hub.dispose();
      auth.dispose();
    },
  };
}
