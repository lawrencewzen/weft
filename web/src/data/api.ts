import type { components } from '../../../src/v2/contract.gen';

export type ConversationSnapshot = components['schemas']['ConversationSnapshot'];
export type RunAccepted = components['schemas']['RunAccepted'];
export type StopAccepted = components['schemas']['StopAccepted'];
export type ToolOutput = components['schemas']['ToolOutput'];
export type V2Error = components['schemas']['V2Error'];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, opts: { status: number; code?: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
  }
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

function parseErrorBody(status: number, statusText: string, text: string): { error: string; code?: string } {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const json = JSON.parse(trimmed) as { error?: unknown; code?: unknown };
      const error = asText(json.error);
      const code = asText(json.code) || undefined;
      if (error) return { error, code };
    } catch {
      return { error: trimmed };
    }
    return { error: trimmed };
  }
  return { error: `${status} ${statusText}`.trim() || 'request failed' };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has('content-type')) {
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
    throw new ApiError(parsed.error, { status: res.status, code: parsed.code });
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
