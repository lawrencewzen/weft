/**
 * Workspace file list for search.
 * Git repos: `git ls-files -z --cached --others --exclude-standard` with cwd
 * set to the workspace, so a subdirectory workspace stays relative to itself.
 * Otherwise (not a repo, git missing, timeout, or any failure) walk the
 * directory, skipping `.git` and `node_modules`. Symlinks are not followed.
 * Every returned path has passed resolveInWorkspace and is a file.
 * The list is cached per workspace root for about two seconds. Expiry is a
 * timestamp check; nothing is scheduled.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildGitChildEnv, resolveGitBin } from './git-import.mjs';
import { resolveInWorkspace } from './paths.mjs';

export const FILE_SEARCH_CACHE_MS = 2_000;
export const FILE_SEARCH_MAX_FILES = 200_000;
export const FILE_SEARCH_GIT_TIMEOUT_MS = 5_000;

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const FILTER_CONCURRENCY = 32;

const DROP_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

function createState() {
  return { cache: new Map(), inflight: new Map() };
}

const globalState = createState();

export function createFileSearchState() {
  return createState();
}

/** Relative POSIX path inside the workspace, or null when it escapes or is empty. */
export function normalizeWorkspaceRel(raw) {
  if (typeof raw !== 'string' || raw.includes('\0')) return null;
  let s = process.platform === 'win32' ? raw.replaceAll('\\', '/') : raw;
  if (s.startsWith('/') || /^[a-zA-Z]:(?:\/|$)/.test(s)) return null;
  const parts = [];
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) return null;
  return parts.join('/');
}

function gitListEnv(base) {
  const env = buildGitChildEnv(base || process.env);
  for (const key of DROP_GIT_VARS) delete env[key];
  return env;
}

function gitLsFiles(root, opts) {
  const timeoutMs = opts.timeoutMs ?? FILE_SEARCH_GIT_TIMEOUT_MS;
  const maxFiles = opts.maxFiles ?? FILE_SEARCH_MAX_FILES;
  const bin = resolveGitBin(opts.env);
  const env = gitListEnv(opts.env);
  const args = [
    '-c', 'core.quotepath=false',
    'ls-files', '-z', '--cached', '--others', '--exclude-standard',
  ];

  return new Promise((resolve) => {
    let child;
    let signal;
    try {
      signal = AbortSignal.timeout(timeoutMs);
      child = spawn(bin, args, {
        cwd: root,
        env,
        windowsHide: true,
        signal,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve({ ok: false });
      return;
    }

    const files = [];
    let truncated = false;
    let killedForCap = false;
    let buf = Buffer.alloc(0);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const stopForCap = () => {
      truncated = true;
      if (killedForCap) return;
      killedForCap = true;
      child.kill();
    };

    const pushPath = (text) => {
      if (truncated) return;
      const rel = normalizeWorkspaceRel(text);
      if (!rel) return;
      if (files.length >= maxFiles) {
        stopForCap();
        return;
      }
      files.push(rel);
    };

    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let idx = buf.indexOf(0);
      while (idx >= 0) {
        pushPath(buf.subarray(0, idx).toString('utf8'));
        buf = buf.subarray(idx + 1);
        if (truncated) return;
        idx = buf.indexOf(0);
      }
    });

    child.on('error', () => finish({ ok: false }));
    child.on('close', (code) => {
      if (settled) return;
      if (!killedForCap && !signal.aborted && code === 0 && buf.length > 0) {
        pushPath(buf.toString('utf8'));
      }
      if (killedForCap) {
        finish({ ok: true, files, truncated: true });
        return;
      }
      if (signal.aborted || code !== 0) {
        finish({ ok: false });
        return;
      }
      finish({ ok: true, files, truncated });
    });
  });
}

async function isWorkspaceFile(root, rel) {
  try {
    const abs = await resolveInWorkspace(root, rel);
    const st = await fs.lstat(abs);
    return st.isFile();
  } catch {
    return false;
  }
}

async function mapPool(items, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(FILTER_CONCURRENCY, items.length);
  async function worker() {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  if (workers > 0) await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

async function filterListed(root, raws, maxFiles) {
  const checked = await mapPool(raws, async (raw) => {
    const rel = normalizeWorkspaceRel(raw);
    if (!rel) return null;
    if (!(await isWorkspaceFile(root, rel))) return null;
    return rel;
  });
  const files = [];
  const seen = new Set();
  let truncated = false;
  for (const rel of checked) {
    if (!rel || seen.has(rel)) continue;
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    seen.add(rel);
    files.push(rel);
  }
  return { files, truncated };
}

async function walkFiles(rootReal, maxFiles) {
  const files = [];
  let truncated = false;
  const seenDirs = new Set([rootReal]);

  async function walk(dirReal, rel) {
    if (truncated) return;
    let dirents;
    try {
      dirents = await fs.readdir(dirReal, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of dirents) {
      if (truncated) return;
      if (SKIP_DIRS.has(ent.name)) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      let resolved;
      try {
        resolved = await resolveInWorkspace(rootReal, childRel);
      } catch {
        continue;
      }
      let st;
      try {
        st = await fs.lstat(resolved);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (ent.isSymbolicLink() || seenDirs.has(resolved)) continue;
        seenDirs.add(resolved);
        await walk(resolved, childRel);
        continue;
      }
      if (!st.isFile()) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push(childRel);
    }
  }

  await walk(rootReal, '');
  return { files, truncated };
}

async function loadFileList(rootReal, opts) {
  const maxFiles = opts.maxFiles ?? FILE_SEARCH_MAX_FILES;
  const timeoutMs = opts.gitTimeoutMs ?? FILE_SEARCH_GIT_TIMEOUT_MS;
  let git;
  try {
    git = opts.runGit
      ? await opts.runGit(rootReal, { maxFiles, timeoutMs, env: opts.env })
      : await gitLsFiles(rootReal, { maxFiles, timeoutMs, env: opts.env });
  } catch {
    git = { ok: false };
  }
  if (git && git.ok) {
    const filtered = await filterListed(rootReal, git.files || [], maxFiles);
    return {
      files: filtered.files,
      truncated: Boolean(git.truncated) || filtered.truncated,
    };
  }
  return walkFiles(rootReal, maxFiles);
}

function prune(state, nowMs, ttl) {
  for (const [key, hit] of state.cache) {
    if (nowMs - hit.at >= ttl) state.cache.delete(key);
  }
}

export async function listWorkspaceFiles(root, opts = {}) {
  const state = opts.state ?? globalState;
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? FILE_SEARCH_CACHE_MS;
  const rootReal = await fs.realpath(root);
  const t = now();
  prune(state, t, ttl);
  const hit = state.cache.get(rootReal);
  if (hit && t - hit.at < ttl) return { files: hit.files, truncated: hit.truncated };
  const pending = state.inflight.get(rootReal);
  if (pending) return pending;
  const job = loadFileList(rootReal, opts)
    .then((result) => {
      state.cache.set(rootReal, { at: now(), files: result.files, truncated: result.truncated });
      return result;
    })
    .finally(() => {
      if (state.inflight.get(rootReal) === job) state.inflight.delete(rootReal);
    });
  state.inflight.set(rootReal, job);
  return job;
}
