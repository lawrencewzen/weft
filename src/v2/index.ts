import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SECURITY_HEADERS } from '../core/auth.mjs';
import { formatSSE } from '../core/sse.mjs';
import {
  createV2Auth,
  generateLocalToken,
  handleNextLogin,
  resolveWebCodeTtlMs,
  type V2Auth,
} from './auth.ts';
import type { components } from './contract.gen.ts';
import { removeDiscoverySync, writeDiscoverySync } from './daemon/discovery.ts';
import { createIdleWatcher, type IdleWatcher } from './daemon/idle.ts';
import {
  createEventHub,
  normalizeLang,
  parseTopics,
  type EventHub,
  type SseFrame,
} from './stream/hub.ts';
import { contractMismatchLog, validateResponse } from './validate.ts';
import { PROTOCOL_VERSION } from './version.ts';
import { MANUAL_CONTINUE_TEXT } from './views/continuation.ts';
import {
  conversationSnapshot,
  findPresentedTool,
  toolOutputView,
  type ConversationSnapshotInput,
} from './views/conversation.ts';

type ServiceInfo = components['schemas']['ServiceInfo'];
type V2Error = components['schemas']['V2Error'];
type WebCode = components['schemas']['WebCode'];
type RestartAccepted = components['schemas']['RestartAccepted'];
type ConversationSnapshot = components['schemas']['ConversationSnapshot'];
type RunAccepted = components['schemas']['RunAccepted'];
type StopAccepted = components['schemas']['StopAccepted'];
type ToolOutput = components['schemas']['ToolOutput'];
type V2JsonBody =
  | ServiceInfo
  | WebCode
  | V2Error
  | RestartAccepted
  | ConversationSnapshot
  | RunAccepted
  | StopAccepted
  | ToolOutput;

export type ConversationRow = {
  id?: unknown;
  workspaceId?: unknown;
  [key: string]: unknown;
};

export type WorkspaceRow = {
  removedAt?: unknown;
  [key: string]: unknown;
};

export type GetConversation = (id: string) => Promise<ConversationRow | null | undefined>;
export type GetWorkspace = (id: string) => Promise<WorkspaceRow | null | undefined>;
export type PostMessage = (
  conv: ConversationRow,
  text: string,
  opts?: { requestId?: string },
) => Promise<{ status: number; body?: { runId?: unknown } }>;
export type StopConversationFn = (id: string) => Promise<{ status: number }>;

export type LoadConversation = (id: string) => Promise<Omit<ConversationSnapshotInput, 'lang' | 'exists'> | null>;

export type V2Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export type V2Runtime = {
  handleApi: V2Handler;
  handleLogin: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
  writeDiscoveryFile: (port: number) => void;
  removeDiscoveryFile: () => void;
  touch: IdleWatcher['touch'];
  trackConnection: IdleWatcher['trackConnection'];
  startIdleExit: IdleWatcher['start'];
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
  body: V2JsonBody,
  onSent?: () => void,
): void {
  if (process.env.WEFT_V2_VALIDATE === '1') {
    const result = validateResponse(requestPath, method, status, body);
    if (!result.ok) {
      console.error(contractMismatchLog(requestPath, method, status, result.errors));
      const errorBody: V2Error = { error: 'contract mismatch', code: 'E_CONTRACT' };
      writeJson(res, 500, errorBody);
      return;
    }
  }
  writeJson(res, status, body, onSent);
}

function unauthorized(res: ServerResponse, requestPath: string, method: string): void {
  sendV2(res, requestPath, method, 401, { error: 'unauthorized', code: 'E_UNAUTHORIZED' } satisfies V2Error);
}

async function readObjectBody(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): Promise<Record<string, unknown> | null> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) {
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

function serviceInfo(opts: { serviceVersion: string; startedAt: number; pid: number }): ServiceInfo {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serviceVersion: opts.serviceVersion,
    pid: opts.pid,
    startedAt: opts.startedAt,
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
  trackConnection: IdleWatcher['trackConnection'];
  loadConversation?: LoadConversation;
  getConversation?: GetConversation;
  getWorkspace?: GetWorkspace;
  postMessage?: PostMessage;
  stopConversation?: StopConversationFn;
}): V2Handler {
  const { serviceVersion, startedAt, auth, hub } = opts;
  const pid = opts.pid ?? process.pid;
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
      sendV2(res, pathname, method, 200, serviceInfo({ serviceVersion, startedAt, pid }));
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
        console.log('WEFT_SERVICE_RESTART');
        opts.onRestart?.();
      });
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

    const messagesMatch = /^\/api\/v2\/conversations\/([^/]+)\/messages$/.exec(pathname);
    const continueMatch = /^\/api\/v2\/conversations\/([^/]+)\/continue$/.exec(pathname);
    if (method === 'POST' && (messagesMatch || continueMatch)) {
      const id = decodeURIComponent((messagesMatch || continueMatch)![1]);
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      const parsedId = requestIdFrom(body);
      if (!parsedId.ok) {
        sendV2(res, pathname, method, 400, { error: 'invalid requestId', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      let text: string;
      if (continueMatch) {
        text = MANUAL_CONTINUE_TEXT;
      } else {
        if (body.text != null && typeof body.text !== 'string') {
          sendV2(res, pathname, method, 400, { error: 'text required', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
        text = String(body.text ?? '').trim();
        if (!text) {
          sendV2(res, pathname, method, 400, { error: 'text required', code: 'E_BAD_REQUEST' } satisfies V2Error);
          return true;
        }
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
      const requestId = parsedId.value || randomUUID();
      if (!opts.postMessage) {
        sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
        return true;
      }
      try {
        const posted = await opts.postMessage(conv, text, { requestId });
        if (posted.status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
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
        sendV2(res, pathname, method, 202, { runId: String(runId) } satisfies RunAccepted);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'send failed';
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
      const tool = findPresentedTool(loaded.presented, toolId);
      if (!tool) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      const output: ToolOutput = toolOutputView(tool, loaded.presented?.workspacePath);
      sendV2(res, pathname, method, 200, output);
      return true;
    }

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
      opts.trackConnection(req);
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
  onIdleExit?: () => void;
  onRestart?: () => void;
  loadConversation?: LoadConversation;
  getConversation?: GetConversation;
  getWorkspace?: GetWorkspace;
  postMessage?: PostMessage;
  stopConversation?: StopConversationFn;
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
        }),
      }];
    },
  });
  const idle = createIdleWatcher({
    hasActiveWork: opts.hasActiveWork ?? (() => false),
    shutdown: () => opts.onIdleExit?.(),
    env: opts.env,
    now: opts.now,
  });
  const handleApi = createV2Handler({
    serviceVersion: opts.serviceVersion,
    startedAt: opts.startedAt,
    auth,
    hub,
    pid,
    hasActiveWork: opts.hasActiveWork,
    onRestart: opts.onRestart,
    trackConnection: idle.trackConnection,
    loadConversation: opts.loadConversation,
    getConversation: opts.getConversation,
    getWorkspace: opts.getWorkspace,
    postMessage: opts.postMessage,
    stopConversation: opts.stopConversation,
  });

  return {
    handleApi,
    handleLogin(req, res, url) {
      return handleNextLogin(req, res, url, auth);
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
    touch: idle.touch,
    trackConnection: idle.trackConnection,
    startIdleExit: idle.start,
    dispose() {
      hub.dispose();
      idle.dispose();
      auth.dispose();
    },
  };
}
