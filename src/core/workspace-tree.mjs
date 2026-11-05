import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildGitChildEnv, resolveGitBin } from './git-import.mjs';
import { resolveInWorkspace } from './paths.mjs';

const SKIP_NAME = new Set(['.git', 'node_modules']);
export const WORKSPACE_TREE_MAX_ENTRIES = 500;
export const WORKSPACE_TREE_MAX_DEPTH = 8;
/** Direct children returned for `?dir=`. Past this, the response sets truncated. */
export const WORKSPACE_TREE_DIR_MAX_ENTRIES = 2000;
const MAX_ENTRIES = WORKSPACE_TREE_MAX_ENTRIES;
const MAX_DEPTH = WORKSPACE_TREE_MAX_DEPTH;
const DIR_MAX = WORKSPACE_TREE_DIR_MAX_ENTRIES;
const GIT_TIMEOUT_MS = 5_000;
const LS_FILES_ARGS = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'];

const DROP_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];

function codeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function toPosix(value) {
  return String(value ?? '').split(path.sep).join('/');
}

function hasGitSegment(rel) {
  return toPosix(rel).split('/').some((part) => part === '.git');
}

function ignoreChildEnv(base) {
  // cwd is the workspace. A leaked GIT_DIR would inspect the server checkout,
  // and one-shot GIT_CONFIG_* would retarget exclude rules away from it.
  const env = buildGitChildEnv(base || process.env);
  for (const key of DROP_GIT_VARS) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(key)) delete env[key];
  }
  return env;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value == null || value === '') return Buffer.alloc(0);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value));
}

/**
 * One git invocation for a tree request. `ok: false` means missing git,
 * not a repository, timeout, or any other failure.
 *
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ ok: boolean, stdout: Buffer }>}
 */
export function runWorkspaceTreeGit(args, { cwd, env } = {}) {
  const base = env || process.env;
  return new Promise((resolve) => {
    execFile(resolveGitBin(base), args, {
      cwd,
      env: ignoreChildEnv(base),
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'buffer',
    }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, stdout: Buffer.alloc(0) });
        return;
      }
      resolve({ ok: true, stdout: asBuffer(stdout) });
    });
  });
}

function parseIgnored(stdout) {
  const dirs = new Set();
  const files = new Set();
  for (const part of asBuffer(stdout).toString('utf8').split('\0')) {
    if (!part) continue;
    let rel = part.replaceAll('\\', '/');
    if (rel.startsWith('./')) rel = rel.slice(2);
    if (!rel || rel === '.') continue;
    if (rel.endsWith('/')) dirs.add(rel.replace(/\/+$/, ''));
    else files.add(rel);
  }
  return { dirs, files };
}

function isIgnored(rel, kind, index) {
  if (!index) return false;
  let slash = rel.lastIndexOf('/');
  while (slash > 0) {
    if (index.dirs.has(rel.slice(0, slash))) return true;
    slash = rel.lastIndexOf('/', slash - 1);
  }
  if (kind === 'dir') return index.dirs.has(rel);
  return index.files.has(rel);
}

async function loadIgnored(root, env, runGit) {
  try {
    const result = await runGit(LS_FILES_ARGS, { cwd: root, env });
    if (!result || result.ok !== true) return null;
    return parseIgnored(result.stdout);
  } catch {
    return null;
  }
}

async function resolveTreeDir(rootReal, dir) {
  const raw = toPosix(dir).trim();
  if (hasGitSegment(raw)) throw codeError('.git is not readable', 'E_NOT_READABLE');
  const resolved = await resolveInWorkspace(rootReal, raw);
  const rel = toPosix(path.relative(rootReal, resolved));
  if (rel && hasGitSegment(rel)) throw codeError('.git is not readable', 'E_NOT_READABLE');
  let st;
  try {
    st = await fs.stat(resolved);
  } catch (err) {
    if (err?.code === 'ENOENT') throw codeError('not found', 'ENOENT');
    throw err;
  }
  if (!st.isDirectory()) throw codeError('not a directory', 'ENOTDIR');
  return { real: resolved, rel };
}

/**
 * List files and directories under a workspace root.
 * Symlinks that resolve outside the root are skipped. Directory symlinks are
 * listed but not followed, so a link cannot walk the tree out of the workspace.
 * In a git work tree, one `git ls-files --others --ignored --exclude-standard
 * --directory` supplies the ignored set. Ignored directories are listed with
 * `ignored: true` and are not walked or counted toward the 500-entry cap.
 * `opts.dir` lists only the direct children of that relative directory, at most
 * 2000 of them.
 *
 * @param {string} root
 * @param {{
 *   dir?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   runGit?: (args: readonly string[], opts: { cwd: string, env?: NodeJS.ProcessEnv }) => Promise<{ ok: boolean, stdout?: Buffer | Uint8Array | string }>,
 * }} [opts]
 * @returns {Promise<Array<{ path: string, type: 'file' | 'dir', ignored?: true }> & { truncated?: boolean }>}
 */
export async function listWorkspaceTree(root, opts = {}) {
  const rootReal = await fs.realpath(root);
  const env = opts.env || process.env;
  const runGit = opts.runGit || runWorkspaceTreeGit;
  const rawDir = opts.dir == null ? '' : String(opts.dir).trim();
  const dirMode = rawDir !== '';
  let startReal = rootReal;
  let startRel = '';
  if (dirMode) {
    const located = await resolveTreeDir(rootReal, rawDir);
    startReal = located.real;
    startRel = located.rel;
  }

  const ignoredIndex = await loadIgnored(rootReal, env, runGit);
  const entries = [];
  let counted = 0;
  let dirEmitted = 0;
  let dirTruncated = false;
  const seen = new Set([rootReal]);

  function accept(node, countsTowardWalk) {
    if (!dirMode) {
      entries.push(node);
      if (countsTowardWalk) counted += 1;
      return true;
    }
    if (dirEmitted >= DIR_MAX) {
      dirTruncated = true;
      return false;
    }
    entries.push(node);
    dirEmitted += 1;
    return true;
  }

  async function walk(dirReal, rel, depth, recursive) {
    if (recursive && (depth > MAX_DEPTH || counted >= MAX_ENTRIES)) return;
    let dirents;
    try {
      dirents = await fs.readdir(dirReal, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    const dirs = [];
    const files = [];
    for (const ent of dirents) {
      if (ent.name === '.git') continue;
      if (recursive && SKIP_NAME.has(ent.name)) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      let real;
      try {
        real = await resolveInWorkspace(rootReal, childRel);
      } catch {
        continue;
      }
      let st;
      try {
        st = await fs.lstat(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) dirs.push({ ent, childRel, real });
      else if (st.isFile()) files.push({ childRel });
    }
    for (const d of dirs) {
      if (isIgnored(d.childRel, 'dir', ignoredIndex)) {
        if (!accept({ path: d.childRel, type: 'dir', ignored: true }, false)) return;
        continue;
      }
      if (recursive && counted >= MAX_ENTRIES) continue;
      if (!accept({ path: d.childRel, type: 'dir' }, true)) return;
      if (!recursive) continue;
      if (d.ent.isSymbolicLink() || seen.has(d.real)) continue;
      seen.add(d.real);
      await walk(d.real, d.childRel, depth + 1, true);
    }
    for (const f of files) {
      if (recursive && counted >= MAX_ENTRIES) break;
      const node = { path: f.childRel, type: 'file' };
      if (isIgnored(f.childRel, 'file', ignoredIndex)) node.ignored = true;
      if (!accept(node, true)) return;
    }
  }

  await walk(startReal, startRel, 0, !dirMode);
  entries.truncated = dirMode ? dirTruncated : counted >= MAX_ENTRIES;
  return entries;
}
