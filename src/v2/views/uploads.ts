/** Workspace file uploads and send-message files/pastes validation. */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkspace } from '../../core/paths.mjs';
import {
  basenamePosix,
  isWeftUploadRel,
  mediaTypeFromName,
  posixRel,
  sanitizeUploadName,
  WEFT_GITIGNORE,
  WEFT_UPLOADS_PREFIX,
} from '../../core/user-message-parts.mjs';
import { decodedBase64Bytes } from './message-images.ts';
import { posixPath } from './changes.ts';

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 20;
export const UPLOAD_BODY_MAX_BYTES = 28 * 1024 * 1024;
export const PASTE_MAX_COUNT = 10;
export const PASTE_MAX_BYTES = 1024 * 1024;

export { sanitizeUploadName, mediaTypeFromName, WEFT_GITIGNORE, WEFT_UPLOADS_PREFIX };

export type AttachedFile = {
  path: string;
  name: string;
  bytes: number;
};

export type ParseOk<T> = { ok: true } & T;
export type ParseErr = { ok: false; error: string; code: string; status?: number };
export type ParseUploadOk = ParseOk<{ name: string; data: string; bytes: number }>;
export type ParseFilesOk = ParseOk<{ files: Array<{ path: string; name?: string; bytes?: number }> }>;
export type ParsePastesOk = ParseOk<{ pastes: string[] }>;
export type ResolveFilesOk = ParseOk<{ files: AttachedFile[] }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function fail(error: string, code: string, status?: number): ParseErr {
  const out: ParseErr = { ok: false, error, code };
  if (status != null) out.status = status;
  return out;
}

export function formatUploadStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/** Validate POST /uploads body. Oversize → status 413. */
export function parseUploadBody(raw: unknown): ParseUploadOk | ParseErr {
  const row = asRecord(raw);
  if (!row) return fail('invalid body', 'E_BAD_REQUEST', 400);
  if (row.data != null && typeof row.data !== 'string') {
    return fail('data required', 'E_BAD_REQUEST', 400);
  }
  if (typeof row.data !== 'string' || !row.data) {
    return fail('data required', 'E_BAD_REQUEST', 400);
  }
  if (row.name != null && typeof row.name !== 'string') {
    return fail('invalid name', 'E_BAD_REQUEST', 400);
  }
  const bytes = decodedBase64Bytes(row.data);
  if (bytes == null) return fail('invalid data', 'E_BAD_REQUEST', 400);
  if (bytes > UPLOAD_MAX_BYTES) {
    return fail(`file exceeds ${UPLOAD_MAX_BYTES} bytes`, 'E_TOO_LARGE', 413);
  }
  return {
    ok: true,
    name: sanitizeUploadName(row.name),
    data: row.data,
    bytes,
  };
}

async function ensureWeftGitignore(root: string): Promise<void> {
  const weftDir = path.join(root, '.weft');
  await fs.mkdir(weftDir, { recursive: true });
  try {
    await fs.writeFile(path.join(weftDir, '.gitignore'), WEFT_GITIGNORE, { flag: 'wx' });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
    if (code !== 'EEXIST') throw err;
  }
}

export type SavedUpload = {
  path: string;
  name: string;
  bytes: number;
  mediaType: string;
};

export async function saveWorkspaceUpload(
  root: string,
  parsed: { name: string; data: string },
): Promise<SavedUpload> {
  const buf = Buffer.from(parsed.data.replace(/\s+/g, ''), 'base64');
  await ensureWeftGitignore(root);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stamp = `${formatUploadStamp()}-${randomSuffix()}`;
    const rel = `${WEFT_UPLOADS_PREFIX}${stamp}/${parsed.name}`;
    const abs = path.join(root, '.weft', 'uploads', stamp, parsed.name);
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buf, { flag: 'wx' });
      return {
        path: posixPath(rel),
        name: parsed.name,
        bytes: buf.length,
        mediaType: mediaTypeFromName(parsed.name),
      };
    } catch (err) {
      lastErr = err;
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
      if (code !== 'EEXIST') throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('upload failed');
}

export function parseSendFiles(raw: unknown): ParseFilesOk | ParseErr {
  if (raw == null) return { ok: true, files: [] };
  if (!Array.isArray(raw)) return fail('files must be an array', 'E_BAD_REQUEST', 400);
  if (raw.length > UPLOAD_MAX_FILES) {
    return fail(`at most ${UPLOAD_MAX_FILES} files`, 'E_BAD_REQUEST', 400);
  }
  const files: Array<{ path: string; name?: string; bytes?: number }> = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = asRecord(raw[i]);
    if (!row) return fail(`files[${i}] invalid`, 'E_BAD_REQUEST', 400);
    if (typeof row.path !== 'string' || !row.path.trim()) {
      return fail(`files[${i}] path required`, 'E_BAD_REQUEST', 400);
    }
    const item: { path: string; name?: string; bytes?: number } = { path: row.path.trim() };
    if (row.name != null) {
      if (typeof row.name !== 'string') return fail(`files[${i}] invalid name`, 'E_BAD_REQUEST', 400);
      if (row.name.trim()) item.name = row.name.trim();
    }
    if (row.bytes != null) {
      if (typeof row.bytes !== 'number' || !Number.isFinite(row.bytes) || row.bytes < 0) {
        return fail(`files[${i}] invalid bytes`, 'E_BAD_REQUEST', 400);
      }
      item.bytes = Math.trunc(row.bytes);
    }
    files.push(item);
  }
  return { ok: true, files };
}

export function parseSendPastes(raw: unknown): ParsePastesOk | ParseErr {
  if (raw == null) return { ok: true, pastes: [] };
  if (!Array.isArray(raw)) return fail('pastes must be an array', 'E_BAD_REQUEST', 400);
  if (raw.length > PASTE_MAX_COUNT) {
    return fail(`at most ${PASTE_MAX_COUNT} pastes`, 'E_BAD_REQUEST', 400);
  }
  const pastes: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (typeof raw[i] !== 'string') {
      return fail(`pastes[${i}] must be a string`, 'E_BAD_REQUEST', 400);
    }
    const text = raw[i] as string;
    if (Buffer.byteLength(text, 'utf8') > PASTE_MAX_BYTES) {
      return fail(`pastes[${i}] exceeds 1MB`, 'E_BAD_REQUEST', 400);
    }
    pastes.push(text);
  }
  return { ok: true, pastes };
}

function errCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code != null) {
    return String((err as { code?: unknown }).code);
  }
  return '';
}

export async function resolveSendFiles(
  root: string,
  files: ReadonlyArray<{ path: string; name?: string; bytes?: number }>,
): Promise<ResolveFilesOk | ParseErr> {
  const out: AttachedFile[] = [];
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return fail('file not in uploads', 'E_BAD_REQUEST', 400);
  }
  for (let i = 0; i < files.length; i += 1) {
    const rel = posixRel(files[i].path).replace(/^\.\//, '');
    if (!isWeftUploadRel(rel)) {
      return fail(`files[${i}] path must be under ${WEFT_UPLOADS_PREFIX}`, 'E_BAD_REQUEST', 400);
    }
    let abs: string;
    try {
      abs = await resolveInWorkspace(root, rel);
    } catch (err) {
      const code = errCode(err);
      if (code === 'E_SANDBOX' || code === 'ENOENT') {
        return fail(`files[${i}] path must be under ${WEFT_UPLOADS_PREFIX}`, 'E_BAD_REQUEST', 400);
      }
      throw err;
    }
    let st;
    try {
      st = await fs.stat(abs);
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        return fail(`files[${i}] not found`, 'E_BAD_REQUEST', 400);
      }
      throw err;
    }
    if (!st.isFile()) {
      return fail(`files[${i}] not found`, 'E_BAD_REQUEST', 400);
    }
    const resolvedRel = posixPath(path.relative(rootReal, abs));
    if (!isWeftUploadRel(resolvedRel)) {
      return fail(`files[${i}] path must be under ${WEFT_UPLOADS_PREFIX}`, 'E_BAD_REQUEST', 400);
    }
    out.push({
      path: posixPath(rel),
      name: files[i].name?.trim() || basenamePosix(rel),
      bytes: st.size,
    });
  }
  return { ok: true, files: out };
}
