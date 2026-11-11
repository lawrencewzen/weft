// Session-start worktree snapshot for the changes panel.
// A private GIT_INDEX_FILE is `git add -A`'d and `git write-tree`'d. That writes
// a dangling tree into the repo's object store and does not touch HEAD, the
// user's index, the worktree, or the stash list. The tree id lives in the
// Pi Durable conversation document WorkspaceSnapshot.
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineDoc } from '@earendil-works/pi-durable';
import { buildGitChildEnv, resolveGitBin } from '../core/git-import.mjs';
import { WORKSPACE_SNAPSHOT_DOC_KIND } from './ids.mjs';
import { decodeWorkspaceBytes } from './workspace-text.mjs';
import { log } from '../core/log.mjs';

/** Same cap as write/edit details and the legacy changes list. */
export const FILE_CAP = 1024 * 1024;
/** Collapse right-pane refreshes. tool.end drops the cache immediately. */
export const CHANGE_CACHE_MS = 500;
const ADD_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 8_000_000;

const DROP_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];

const indexLocks = new Map();

export const WorkspaceSnapshot = defineDoc({
  kind: WORKSPACE_SNAPSHOT_DOC_KIND,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ mode: '', tree: '' }),
});

function withIndexLock(indexFile, fn) {
  const key = path.resolve(indexFile);
  const prev = indexLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  indexLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

function gitEnv(base, indexFile) {
  const env = buildGitChildEnv(base || process.env);
  for (const key of DROP_GIT_VARS) delete env[key];
  env.GIT_OPTIONAL_LOCKS = '0';
  if (indexFile) env.GIT_INDEX_FILE = path.resolve(indexFile);
  return env;
}

function runGit(args, { cwd, env, indexFile, timeoutMs, encoding = 'buffer' } = {}) {
  const bin = resolveGitBin(env);
  return new Promise((resolve) => {
    execFile(bin, args, {
      cwd,
      env: gitEnv(env, indexFile),
      timeout: timeoutMs ?? GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      encoding,
    }, (err, stdout, stderr) => {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        resolve({ code: 127, stdout: emptyOut(encoding), stderr: emptyOut(encoding), missing: true });
        return;
      }
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({
        code,
        killed: err?.killed === true,
        stdout: stdout == null ? emptyOut(encoding) : stdout,
        stderr: stderr == null ? emptyOut(encoding) : stderr,
        missing: false,
      });
    });
  });
}

function emptyOut(encoding) {
  return encoding === 'utf8' ? '' : Buffer.alloc(0);
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(String(value ?? ''), 'utf8');
}

function textOf(value) {
  return asBuffer(value).toString('utf8');
}

/** Reused per conversation. Kept outside the worktree so `git add -A` cannot stage it. */
export function indexFileFor(dataDir, cid, workspacePath) {
  const safe = String(cid || 'conversation').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'conversation';
  let dir = path.resolve(dataDir || os.tmpdir(), 'change-indexes');
  const root = path.resolve(String(workspacePath || ''));
  if (root && (dir === root || dir.startsWith(root + path.sep))) {
    dir = path.resolve(os.tmpdir(), 'weft-change-indexes');
  }
  return path.join(dir, safe);
}

export function isOutsideWorkspacePath(filePath) {
  const raw = String(filePath ?? '').trim();
  if (!raw) return false;
  if (path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) return true;
  return /^[A-Za-z]:[\\/]/.test(raw);
}

/** A timed-out `git add` must not run again. Any other failure may try once. */
export function shouldRetryGitAdd(result) {
  if (!result || result.killed === true) return false;
  return result.code !== 0;
}

function stripPrefix(filePath, prefix) {
  const rel = String(filePath || '').replaceAll('\\', '/');
  const pre = String(prefix || '').replaceAll('\\', '/');
  if (!rel) return null;
  if (!pre) return rel;
  if (!rel.startsWith(pre)) return null;
  const rest = rel.slice(pre.length);
  return rest || null;
}

/** `git diff-tree --name-status -z` records. Renames and copies carry two paths. */
export function parseNameStatusZ(buf) {
  const data = asBuffer(buf);
  const out = [];
  let i = 0;
  while (i < data.length) {
    const n0 = data.indexOf(0, i);
    if (n0 < 0) break;
    const status = data.toString('utf8', i, n0);
    i = n0 + 1;
    if (!status) continue;
    const n1 = data.indexOf(0, i);
    if (n1 < 0) break;
    const first = data.toString('utf8', i, n1);
    i = n1 + 1;
    if (status.startsWith('R') || status.startsWith('C')) {
      const n2 = data.indexOf(0, i);
      if (n2 < 0) break;
      const second = data.toString('utf8', i, n2);
      i = n2 + 1;
      out.push({ status, oldPath: first, path: second });
    } else {
      out.push({ status, oldPath: null, path: first });
    }
  }
  return out;
}

/**
 * `git diff-tree --numstat -z`. A rename is `added\tremoved\t\0old\0new\0`
 * (empty path field, then the two names). Anything else is one path.
 */
export function parseNumstatZ(buf) {
  const data = asBuffer(buf);
  const out = [];
  let i = 0;
  while (i < data.length) {
    const nul = data.indexOf(0, i);
    if (nul < 0) break;
    const head = data.toString('utf8', i, nul);
    i = nul + 1;
    const tab1 = head.indexOf('\t');
    const tab2 = tab1 < 0 ? -1 : head.indexOf('\t', tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const addedRaw = head.slice(0, tab1);
    const removedRaw = head.slice(tab1 + 1, tab2);
    let filePath = head.slice(tab2 + 1);
    let oldPath = null;
    if (filePath === '') {
      const n1 = data.indexOf(0, i);
      if (n1 < 0) break;
      const n2 = data.indexOf(0, n1 + 1);
      if (n2 < 0) break;
      oldPath = data.toString('utf8', i, n1);
      filePath = data.toString('utf8', n1 + 1, n2);
      i = n2 + 1;
    }
    out.push({ addedRaw, removedRaw, path: filePath, oldPath });
  }
  return out;
}

function statusOf(code) {
  if (code.startsWith('R')) return 'renamed';
  if (code.startsWith('C') || code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  return 'modified';
}

function countOf(raw) {
  if (raw === '-' || raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

async function showPrefix(cwd, env) {
  const result = await runGit(['rev-parse', '--show-prefix'], { cwd, env, encoding: 'utf8' });
  if (result.code !== 0) return '';
  return String(result.stdout || '').replaceAll('\\', '/').trim();
}

async function addAndWriteTree(cwd, indexFile, env) {
  return withIndexLock(indexFile, async () => {
    await mkdir(path.dirname(indexFile), { recursive: true });
    const args = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=', 'add', '-A', '--', '.'];
    let added = await runGit(args, { cwd, env, indexFile, timeoutMs: ADD_TIMEOUT_MS });
    if (shouldRetryGitAdd(added)) {
      await rm(indexFile, { force: true });
      added = await runGit(args, { cwd, env, indexFile, timeoutMs: ADD_TIMEOUT_MS });
    }
    if (added.killed) {
      log.error('WEFT_CHANGE_SNAPSHOT', 'git add timed out');
      const error = new Error('git add timed out');
      error.code = 'E_GIT_TIMEOUT';
      throw error;
    }
    if (added.code !== 0 || added.missing) {
      const error = new Error('git add failed');
      error.code = added.missing ? 'ENOENT' : 'E_GIT';
      throw error;
    }
    const written = await runGit(['write-tree'], { cwd, env, indexFile, encoding: 'utf8' });
    const tree = textOf(written.stdout).trim();
    if (written.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(tree)) {
      const error = new Error('git write-tree failed');
      error.code = 'E_GIT';
      throw error;
    }
    return tree;
  });
}

async function insideWorkTree(cwd, env) {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd, env, encoding: 'utf8' });
  if (result.missing) {
    const error = new Error('git not found');
    error.code = 'ENOENT';
    throw error;
  }
  return result.code === 0 && textOf(result.stdout).trim() === 'true';
}

/**
 * Read-only tree of the worktree at `cwd`, including untracked files that are
 * not ignored. `mode: 'fallback'` means the caller should keep the write/edit list.
 */
export async function captureWorktree({ cwd, indexFile, env } = {}) {
  const root = String(cwd || '').trim();
  if (!root || !indexFile) return { mode: 'fallback', tree: '' };
  try {
    const inside = await insideWorkTree(root, env);
    if (!inside) return { mode: 'fallback', tree: '' };
    const tree = await addAndWriteTree(root, indexFile, env);
    return { mode: 'git', tree };
  } catch {
    return { mode: 'fallback', tree: '' };
  }
}

async function blobSizes(cwd, specs, env) {
  if (!specs.length) return [];
  const bin = resolveGitBin(env);
  const stdout = await new Promise((resolve) => {
    const child = execFile(bin, ['cat-file', '--batch-check'], {
      cwd,
      env: gitEnv(env),
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    }, (err, out) => {
      resolve(err && !out ? '' : String(out || ''));
    });
    if (!child?.stdin) {
      resolve('');
      return;
    }
    child.stdin.on('error', () => {});
    child.stdin.end(`${specs.join('\n')}\n`);
  });
  return stdout.split(/\r?\n/).filter((line) => line.length > 0).map((line) => {
    if (line.endsWith(' missing')) return { missing: true, size: 0, type: '' };
    const parts = line.split(/\s+/);
    return {
      missing: false,
      type: parts[1] || '',
      size: Number(parts[2]) || 0,
    };
  });
}

function specFor(tree, prefix, rel) {
  return `${tree}:${prefix}${rel}`;
}

/**
 * Diff `baseTree` against a fresh tree of the worktree. Paths are relative to
 * `cwd` (the conversation workspace), not the git toplevel.
 */
export async function listWorktreeChanges({ cwd, indexFile, baseTree, env, maxBytes = FILE_CAP } = {}) {
  const root = String(cwd || '').trim();
  const tree = String(baseTree || '').trim();
  if (!root || !indexFile || !tree) {
    const error = new Error('snapshot diff missing');
    error.code = 'E_GIT';
    throw error;
  }
  const current = await addAndWriteTree(root, indexFile, env);
  const [nameResult, numResult, prefix] = await Promise.all([
    runGit(['diff-tree', '-r', '-M', '--name-status', '-z', tree, current], { cwd: root, env }),
    runGit(['diff-tree', '-r', '-M', '--numstat', '-z', tree, current], { cwd: root, env }),
    showPrefix(root, env),
  ]);
  if (nameResult.code !== 0 || numResult.code !== 0) {
    const error = new Error('git diff-tree failed');
    error.code = 'E_GIT';
    throw error;
  }
  const names = parseNameStatusZ(nameResult.stdout);
  const stats = new Map();
  for (const row of parseNumstatZ(numResult.stdout)) {
    const rel = stripPrefix(row.path, prefix);
    if (rel) stats.set(rel, row);
  }
  const entries = [];
  for (const row of names) {
    const rel = stripPrefix(row.path, prefix);
    if (!rel) continue;
    const kind = statusOf(row.status);
    const oldRel = row.oldPath ? stripPrefix(row.oldPath, prefix) : null;
    const statRow = stats.get(rel);
    const binary = statRow ? (statRow.addedRaw === '-' || statRow.removedRaw === '-') : false;
    entries.push({
      path: rel,
      status: kind,
      oldPath: kind === 'renamed' ? (oldRel || null) : null,
      added: statRow ? countOf(statRow.addedRaw) : 0,
      removed: statRow ? countOf(statRow.removedRaw) : 0,
      binary,
      tooLarge: binary,
    });
  }
  const specs = [];
  const specIndex = [];
  for (const entry of entries) {
    if (entry.status !== 'added' && (entry.oldPath || entry.path)) {
      specs.push(specFor(tree, prefix, entry.oldPath || entry.path));
      specIndex.push(entry);
    }
    if (entry.status !== 'deleted') {
      specs.push(specFor(current, prefix, entry.path));
      specIndex.push(entry);
    }
  }
  const sizes = await blobSizes(root, specs, env);
  for (let i = 0; i < specIndex.length; i++) {
    const info = sizes[i];
    if (!info || info.missing) continue;
    if (info.type !== 'blob' || info.size > maxBytes) specIndex[i].tooLarge = true;
  }
  return entries;
}

/** Blob text for `tree:prefix+rel`. Missing paths are empty (an add). */
export async function readTreeBlob({ cwd, tree, prefix = '', rel, env, maxBytes = FILE_CAP } = {}) {
  const filePath = String(rel || '').replaceAll('\\', '/');
  if (!filePath || filePath.includes('\0') || filePath.includes('\n')) {
    return { missing: true, text: '', tooLarge: false, binary: false };
  }
  const spec = specFor(tree, prefix, filePath);
  const sized = await runGit(['cat-file', '-s', spec], { cwd, env, encoding: 'utf8' });
  if (sized.code !== 0) return { missing: true, text: '', tooLarge: false, binary: false };
  const size = Number(textOf(sized.stdout).trim());
  if (!Number.isFinite(size) || size > maxBytes) {
    return { missing: false, text: '', tooLarge: true, binary: false, size };
  }
  const blob = await runGit(['cat-file', '-p', spec], { cwd, env });
  if (blob.code !== 0) return { missing: true, text: '', tooLarge: false, binary: false };
  return {
    missing: false,
    text: decodeWorkspaceBytes(asBuffer(blob.stdout)),
    tooLarge: false,
    binary: false,
    size,
  };
}

export async function gitPrefix(cwd, env) {
  return showPrefix(cwd, env);
}

/**
 * Attach write/edit `by` (and toolCallId) onto snapshot rows.
 * `baselines` are mergeFileChanges rows, keyed by workspace-relative or absolute path.
 */
export function decorateGitChanges(entries, baselines) {
  const byPath = new Map();
  for (const row of baselines || []) {
    const key = String(row?.path || '').replaceAll('\\', '/');
    if (key && !byPath.has(key)) byPath.set(key, row);
  }
  return (entries || []).map((entry) => {
    const key = String(entry.path || '').replaceAll('\\', '/');
    const oldKey = entry.oldPath ? String(entry.oldPath).replaceAll('\\', '/') : '';
    const baseline = byPath.get(key) || (oldKey ? byPath.get(oldKey) : null) || null;
    const tooLarge = entry.tooLarge === true || entry.binary === true;
    return {
      path: key,
      added: entry.added ?? 0,
      removed: entry.removed ?? 0,
      status: entry.status,
      oldPath: entry.status === 'renamed' ? (entry.oldPath || null) : null,
      by: baseline?.by ?? null,
      toolCallId: baseline?.toolCallId ?? null,
      ...(tooLarge ? { error: '文件过大' } : {}),
    };
  });
}

/** Keep absolute paths from the write/edit list. Snapshot rows already cover the worktree. */
export function appendOutsideChanges(gitRows, outsideRows) {
  const seen = new Set((gitRows || []).map((row) => String(row.path || '').replaceAll('\\', '/')));
  const extra = [];
  for (const row of outsideRows || []) {
    const key = String(row?.path || '').replaceAll('\\', '/');
    if (!isOutsideWorkspacePath(key) || seen.has(key)) continue;
    seen.add(key);
    extra.push(row);
  }
  return [...(gitRows || []), ...extra];
}
