import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildGitChildEnv, resolveGitBin } from './git-import.mjs';
import { resolveInWorkspace } from './paths.mjs';

const SKIP_NAME = new Set(['.git', 'node_modules']);
export const WORKSPACE_TREE_MAX_ENTRIES = 500;
export const WORKSPACE_TREE_MAX_DEPTH = 8;
const MAX_ENTRIES = WORKSPACE_TREE_MAX_ENTRIES;
const MAX_DEPTH = WORKSPACE_TREE_MAX_DEPTH;
const GIT_TIMEOUT_MS = 5_000;

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
  return Buffer.from(String(value));
}

function runGit(root, args, env) {
  return new Promise((resolve) => {
    execFile(resolveGitBin(env), args, {
      cwd: root,
      env: ignoreChildEnv(env),
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout) => {
      if (err) {
        resolve({ ok: false });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

function checkIgnore(root, rels, env) {
  return new Promise((resolve) => {
    const child = execFile(resolveGitBin(env), ['check-ignore', '--stdin', '-z'], {
      cwd: root,
      env: ignoreChildEnv(env),
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'buffer',
    }, (err, stdout) => {
      const code = err ? err.code : 0;
      if (code !== 0 && code !== 1) {
        resolve({ ok: false, paths: [] });
        return;
      }
      const text = asBuffer(stdout).toString('utf8');
      const paths = [];
      for (const part of text.split('\0')) {
        const norm = toPosix(part).replace(/^\.\//, '');
        if (norm) paths.push(norm);
      }
      resolve({ ok: true, paths });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(Buffer.from(`${rels.join('\0')}\0`, 'utf8'));
  });
}

function createIgnoreChecker(root, env) {
  let state = 'unknown';
  return {
    async match(rels) {
      if (state === 'off' || rels.length === 0) return new Set();
      if (state === 'unknown') {
        const probe = await runGit(root, ['rev-parse', '--is-inside-work-tree'], env);
        state = probe.ok && probe.stdout.trim() === 'true' ? 'on' : 'off';
        if (state === 'off') return new Set();
      }
      const result = await checkIgnore(root, rels, env);
      if (!result.ok) {
        state = 'off';
        return new Set();
      }
      return new Set(result.paths);
    },
  };
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
 * In a git work tree, ignored directories are listed with `ignored: true` and
 * are not walked or counted toward the 500-entry cap. `opts.dir` lists only
 * the direct children of that relative directory.
 *
 * @param {string} root
 * @param {{ dir?: string | null, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<Array<{ path: string, type: 'file' | 'dir', ignored?: true }> & { truncated?: boolean }>}
 */
export async function listWorkspaceTree(root, opts = {}) {
  const rootReal = await fs.realpath(root);
  const env = opts.env || process.env;
  const rawDir = opts.dir == null ? '' : String(opts.dir).trim();
  const dirMode = rawDir !== '';
  let startReal = rootReal;
  let startRel = '';
  if (dirMode) {
    const located = await resolveTreeDir(rootReal, rawDir);
    startReal = located.real;
    startRel = located.rel;
  }

  const entries = [];
  let counted = 0;
  const seen = new Set([rootReal]);
  const ignore = createIgnoreChecker(rootReal, env);

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
    const ignored = await ignore.match([
      ...dirs.map((d) => d.childRel),
      ...files.map((f) => f.childRel),
    ]);
    for (const d of dirs) {
      if (ignored.has(d.childRel)) {
        entries.push({ path: d.childRel, type: 'dir', ignored: true });
        continue;
      }
      if (recursive && counted >= MAX_ENTRIES) continue;
      entries.push({ path: d.childRel, type: 'dir' });
      counted += 1;
      if (!recursive) continue;
      if (d.ent.isSymbolicLink() || seen.has(d.real)) continue;
      seen.add(d.real);
      await walk(d.real, d.childRel, depth + 1, true);
    }
    for (const f of files) {
      if (recursive && counted >= MAX_ENTRIES) break;
      const node = { path: f.childRel, type: 'file' };
      if (ignored.has(f.childRel)) node.ignored = true;
      entries.push(node);
      counted += 1;
    }
  }

  await walk(startReal, startRel, 0, !dirMode);
  entries.truncated = !dirMode && counted >= MAX_ENTRIES;
  return entries;
}
