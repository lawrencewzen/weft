/** POST /api/v2/workspaces/{id}/open-terminal — open a workspace directory in the host terminal. */

import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveInWorkspace } from '../../core/paths.mjs';
import { openInSystemTerminal } from '../../core/open-terminal.mjs';
import type { components } from '../contract.gen.ts';
import { phrase, type Lang } from '../phrases/index.ts';
import { normalizeLang } from '../stream/hub.ts';
import type { ReadObjectBodyFn, SendV2Fn } from './extensions.ts';

type V2Error = components['schemas']['V2Error'];
type OpenTerminalResult = components['schemas']['OpenTerminalResult'];

export type WorkspaceRow = {
  removedAt?: unknown;
  path?: unknown;
  [key: string]: unknown;
};

export type GetWorkspace = (id: string) => Promise<WorkspaceRow | null | undefined>;

function requestLang(url: URL): Lang {
  return normalizeLang(url.searchParams.get('lang')) === 'en' ? 'en' : 'zh';
}

function errCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code != null) {
    return String((err as { code?: unknown }).code);
  }
  return '';
}

function errStatus(err: unknown, fallback: number): number {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = Number((err as { status?: unknown }).status);
    if (Number.isFinite(status) && status >= 400) return status;
  }
  return fallback;
}

function workspacePathOf(ws: WorkspaceRow | null | undefined): string {
  if (!ws || ws.removedAt != null) return '';
  if (ws.path == null) return '';
  return String(ws.path);
}

function relativePathOf(body: Record<string, unknown>): { ok: true; path: string } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(body, 'path') || body.path == null || body.path === '') {
    return { ok: true, path: '.' };
  }
  if (typeof body.path !== 'string') return { ok: false };
  const trimmed = body.path.trim();
  return { ok: true, path: trimmed || '.' };
}

export async function handleOpenTerminalApi(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string;
  method: string;
  sendV2: SendV2Fn;
  readObjectBody: ReadObjectBodyFn;
  getWorkspace?: GetWorkspace;
}): Promise<boolean> {
  const match = /^\/api\/v2\/workspaces\/([^/]+)\/open-terminal$/.exec(opts.pathname);
  if (!match) return false;
  const { req, res, url, pathname, method, sendV2, readObjectBody } = opts;
  if (method !== 'POST') {
    sendV2(res, pathname, method, 405, { error: 'method not allowed', code: 'E_BAD_REQUEST' } satisfies V2Error);
    return true;
  }
  const workspaceId = decodeURIComponent(match[1]);
  const lang = requestLang(url);
  const body = await readObjectBody(req, res, pathname, method);
  if (!body) return true;
  const rel = relativePathOf(body);
  if (!rel.ok) {
    sendV2(res, pathname, method, 400, { error: 'invalid path', code: 'E_BAD_REQUEST' } satisfies V2Error);
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

  let abs: string;
  try {
    abs = await resolveInWorkspace(root, rel.path);
  } catch (err) {
    sendV2(res, pathname, method, 400, {
      error: phrase(lang, 'term_err_path'),
      code: 'E_PATH',
    } satisfies V2Error);
    return true;
  }

  try {
    const info = await stat(abs);
    if (!info.isDirectory()) {
      sendV2(res, pathname, method, 400, {
        error: phrase(lang, 'term_err_not_dir'),
        code: 'E_PATH',
      } satisfies V2Error);
      return true;
    }
  } catch (err) {
    const code = errCode(err);
    sendV2(res, pathname, method, 400, {
      error: phrase(lang, code === 'ENOENT' ? 'term_err_not_dir' : 'term_err_path'),
      code: 'E_PATH',
    } satisfies V2Error);
    return true;
  }

  try {
    await openInSystemTerminal(abs);
    sendV2(res, pathname, method, 200, { opened: true } satisfies OpenTerminalResult);
  } catch (err) {
    const code = errCode(err) || 'E_TERMINAL';
    const status = errStatus(err, code === 'E_NO_TERMINAL' ? 501 : 500);
    const message = err instanceof Error && err.message
      ? err.message
      : phrase(lang, 'term_err_spawn');
    sendV2(res, pathname, method, status, { error: message, code } satisfies V2Error);
  }
  return true;
}
