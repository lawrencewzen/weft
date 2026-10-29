/** Workspace file tree, file content, and save views. */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { diffStats } from '../../core/diff.mjs';
import { resolveInWorkspace } from '../../core/paths.mjs';
import {
  listWorkspaceTree,
  WORKSPACE_TREE_MAX_ENTRIES,
} from '../../core/workspace-tree.mjs';
import type { components } from '../contract.gen.ts';
import { posixPath } from './changes.ts';

export { WORKSPACE_TREE_MAX_ENTRIES };

export type FileNode = components['schemas']['FileNode'];
export type FileTree = components['schemas']['FileTree'];
export type FileContent = components['schemas']['FileContent'];
export type SaveResult = components['schemas']['SaveResult'];

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const BINARY_SAMPLE_BYTES = 8 * 1024;

export type FileOpError = Error & { code?: string; current?: FileContent };

function tagged(message: string, code: string): FileOpError {
  const err = new Error(message) as FileOpError;
  err.code = code;
  return err;
}

export function maxFileBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WEFT_V2_MAX_FILE_BYTES;
  if (raw == null || raw === '') return DEFAULT_MAX_FILE_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_MAX_FILE_BYTES;
}

export function contentVersion(buf: Buffer | string): string {
  const bytes = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES));
  if (sample.includes(0)) return true;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(sample, { stream: sample.length < buf.length });
    return false;
  } catch {
    return true;
  }
}

export function fileNodeView(entry: { path?: unknown; type?: unknown }): FileNode {
  return {
    path: posixPath(entry.path),
    type: entry.type === 'dir' ? 'dir' : 'file',
  };
}

export async function hashFile(abs: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(abs);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex').slice(0, 16);
}

export function emptyFileContent(rel: string): FileContent {
  return {
    path: posixPath(rel),
    size: 0,
    binary: false,
    tooLarge: false,
    text: '',
    version: contentVersion(Buffer.alloc(0)),
  };
}

type TreeEntry = { path?: unknown; type?: unknown };

export async function workspaceTreeView(root: string): Promise<FileTree> {
  const raw = await listWorkspaceTree(root) as TreeEntry[];
  const entries = raw.map(fileNodeView);
  return {
    entries,
    truncated: entries.length >= WORKSPACE_TREE_MAX_ENTRIES,
  };
}

export async function readWorkspaceFile(
  root: string,
  rel: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FileContent> {
  const abs = await resolveInWorkspace(root, rel);
  let st;
  try {
    st = await fs.stat(abs);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
    if (code === 'ENOENT') throw tagged('not found', 'ENOENT');
    throw err;
  }
  if (st.isDirectory()) throw tagged('is a directory', 'EISDIR');

  const pathPosix = posixPath(rel);
  const limit = maxFileBytes(env);
  const tooLarge = st.size > limit;
  if (!tooLarge) {
    const buf = await fs.readFile(abs);
    const binary = looksBinary(buf);
    return {
      path: pathPosix,
      size: st.size,
      binary,
      tooLarge: false,
      text: binary ? null : buf.toString('utf8'),
      version: contentVersion(buf),
    };
  }

  const sampleSize = Math.min(st.size, BINARY_SAMPLE_BYTES);
  const sample = await readSample(abs, sampleSize);
  return {
    path: pathPosix,
    size: st.size,
    binary: looksBinary(sample),
    tooLarge: true,
    text: null,
    version: await hashFile(abs),
  };
}

async function readSample(abs: string, size: number): Promise<Buffer> {
  if (size <= 0) return Buffer.alloc(0);
  const stream = createReadStream(abs, { start: 0, end: size - 1 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function ioErrorCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Windows rename can fail while another process holds the destination. */
export const ATOMIC_RENAME_BUSY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Five attempts; delays between them stay under ~500ms. */
export const ATOMIC_RENAME_ATTEMPTS = 5;
export const ATOMIC_RENAME_DELAYS_MS: readonly number[] = [25, 50, 100, 200];

export type WriteFileAtomicIo = {
  writeFile?: (file: string, data: string, encoding: BufferEncoding) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

async function unlinkQuiet(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch {
    /* tmp may already be gone after rename, or never created */
  }
}

async function renameWithRetry(
  rename: (oldPath: string, newPath: string) => Promise<void>,
  tmp: string,
  abs: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ATOMIC_RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rename(tmp, abs);
      return;
    } catch (err) {
      lastErr = err;
      const code = ioErrorCode(err);
      if (!ATOMIC_RENAME_BUSY_CODES.has(code) || attempt === ATOMIC_RENAME_ATTEMPTS) {
        throw err;
      }
      const wait = ATOMIC_RENAME_DELAYS_MS[attempt - 1] ?? ATOMIC_RENAME_DELAYS_MS[ATOMIC_RENAME_DELAYS_MS.length - 1];
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * Write `text` by creating a sibling temp file, then renaming over `abs`.
 * Callers must pass a path already resolved (and realpath'd) inside the workspace.
 * On Windows, a destination locked by another process falls back to in-place writeFile.
 */
export async function writeFileAtomic(
  abs: string,
  text: string,
  io: WriteFileAtomicIo = {},
): Promise<void> {
  const writeFile = io.writeFile ?? ((file, data, encoding) => fs.writeFile(file, data, encoding));
  const rename = io.rename ?? ((oldPath, newPath) => fs.rename(oldPath, newPath));
  const sleep = io.sleep ?? delay;

  let mode: number | undefined;
  try {
    const st = await fs.stat(abs);
    mode = st.mode & 0o777;
  } catch (err) {
    if (ioErrorCode(err) !== 'ENOENT') throw err;
  }

  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tmp, text, 'utf8');
    if (mode != null) {
      try {
        await fs.chmod(tmp, mode);
      } catch {
        /* Windows: chmod is best-effort */
      }
    }
    try {
      await renameWithRetry(rename, tmp, abs, sleep);
    } catch (err) {
      if (!ATOMIC_RENAME_BUSY_CODES.has(ioErrorCode(err))) throw err;
      await writeFile(abs, text, 'utf8');
    }
  } catch (err) {
    await unlinkQuiet(tmp);
    throw err;
  }
  await unlinkQuiet(tmp);
}

export type SaveWorkspaceFileInput = {
  root: string;
  path: string;
  text: string;
  baseVersion?: string | null;
  env?: NodeJS.ProcessEnv;
  atomic?: WriteFileAtomicIo;
};

export async function saveWorkspaceFile({
  root,
  path: rel,
  text,
  baseVersion,
  env = process.env,
  atomic,
}: SaveWorkspaceFileInput): Promise<SaveResult> {
  const abs = await resolveInWorkspace(root, rel);
  let existed = true;
  let current: FileContent;
  try {
    current = await readWorkspaceFile(root, rel, env);
  } catch (err) {
    const code = ioErrorCode(err);
    if (code === 'EISDIR') throw err;
    if (code !== 'ENOENT') throw err;
    existed = false;
    current = emptyFileContent(rel);
  }

  if (baseVersion != null) {
    if (baseVersion !== current.version) {
      const conflict = tagged('conflict', 'E_CONFLICT');
      conflict.current = current;
      throw conflict;
    }
  }

  let before = '';
  if (existed) {
    try {
      before = await fs.readFile(abs, 'utf8');
    } catch {
      before = '';
    }
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, text, atomic);
  const stats = diffStats(before, text) as { added: number; removed: number };
  return {
    path: posixPath(rel),
    version: contentVersion(text),
    added: Number(stats.added) || 0,
    removed: Number(stats.removed) || 0,
  };
}
