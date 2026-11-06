import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = 'E_PATH';
  return err;
}

function isUnder(root, resolved) {
  if (!root || !resolved) return false;
  const r = path.resolve(root);
  return resolved === r || resolved.startsWith(r + path.sep);
}

async function realOrResolve(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export function defaultWorkspaceRoot() {
  const env = String(process.env.WEFT_WORKSPACE_ROOT || '').trim();
  if (env) return path.resolve(env);
  const home = os.homedir();
  const projects = path.join(home, 'projects');
  if (existsSync(projects)) return path.resolve(projects);
  return path.resolve(home);
}

const SYSTEM_PREFIXES = ['/etc', '/var', '/usr', '/bin', '/boot', '/dev', '/proc', '/sys', '/root'];

function filesystemRoot(resolved) {
  const root = path.parse(resolved).root;
  return Boolean(root) && resolved === root;
}

/**
 * Directories the picker must not enter and that cannot be a workspace:
 * ~/.ssh, ~/.gnupg, and system directories. The filesystem root is not
 * sensitive to browse (the picker walks up to it). $HOME itself is allowed.
 */
async function isSensitive(resolved, home) {
  if (!resolved || filesystemRoot(resolved)) return false;
  if (isUnder(path.join(home, '.ssh'), resolved) || isUnder(path.join(home, '.gnupg'), resolved)) return true;
  for (const prefix of SYSTEM_PREFIXES) {
    let realPrefix = prefix;
    try { realPrefix = await fs.realpath(prefix); } catch { /* missing */ }
    if (isUnder(realPrefix, resolved) || isUnder(prefix, resolved)) return true;
  }
  return false;
}

async function browseParent(current, home) {
  if (filesystemRoot(current)) return null;
  const parent = path.dirname(current);
  if (!parent || parent === current) return null;
  let real;
  try {
    real = await fs.realpath(parent);
  } catch {
    return null;
  }
  if (real === current || await isSensitive(real, home)) return null;
  return parent;
}

/**
 * Resolve `inputPath` with realpath. Paths under DATA_DIR/workspaces are
 * checked first and always allowed, including when that directory lives
 * under a system prefix such as /var (macOS temp dirs are /private/var).
 * Any other existing path is allowed except `/`, `~/.ssh`, `~/.gnupg`,
 * and system directories. The home directory itself is allowed.
 * WEFT_WORKSPACE_ROOT is not an allowlist; it is only the folder picker's
 * default start (see defaultWorkspaceRoot / listBrowsableDirs).
 */
export async function resolveAllowedWorkspacePath(inputPath, { dataDir } = {}) {
  if (inputPath == null || String(inputPath).trim() === '') {
    throw fail('path is required');
  }
  const raw = String(inputPath);
  if (raw.includes('\0')) throw fail('path is forbidden');

  let resolved;
  try {
    resolved = await fs.realpath(raw);
  } catch (err) {
    if (err?.code === 'ENOENT') throw fail('path does not exist');
    throw fail('path is not allowed');
  }

  const home = await realOrResolve(os.homedir());
  const dataWs = await realOrResolve(path.join(dataDir, 'workspaces'));

  if (isUnder(dataWs, resolved)) return resolved;
  if (resolved === '/') throw fail('path is forbidden');
  if (resolved === home) return resolved;
  if (await isSensitive(resolved, home)) throw fail('path is forbidden');
  return resolved;
}

const MAX_BROWSE_ENTRIES = 500;

/**
 * Folder picker for the new-workspace dialog. Lists sub-folders of `inputPath`
 * (default: defaultWorkspaceRoot()). Navigation is not limited to that start
 * directory. Hidden folders and symlinks into sensitive directories are skipped.
 * `/` can be listed but is not selectable. $HOME is selectable. Read-only.
 */
export async function listBrowsableDirs(inputPath) {
  const root = await realOrResolve(defaultWorkspaceRoot());
  const home = await realOrResolve(os.homedir());
  const raw = inputPath == null || String(inputPath).trim() === '' ? root : String(inputPath);
  if (raw.includes('\0')) throw fail('path is forbidden');
  let current;
  try {
    current = await fs.realpath(raw);
  } catch (err) {
    if (err?.code === 'ENOENT') throw fail('path does not exist', 404);
    throw fail('path is not allowed');
  }
  if (await isSensitive(current, home)) throw fail('path is forbidden');

  let dirents;
  try {
    dirents = await fs.readdir(current, { withFileTypes: true });
  } catch {
    throw fail('path is not readable');
  }
  const entries = [];
  for (const ent of dirents) {
    if (ent.name.startsWith('.')) continue;
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const full = path.join(current, ent.name);
    let real;
    try {
      real = await fs.realpath(full);
      if (!(await fs.stat(real)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (await isSensitive(real, home)) continue;
    entries.push({ name: ent.name, path: full, git: existsSync(path.join(real, '.git')) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return {
    root,
    path: current,
    parent: await browseParent(current, home),
    selectable: current !== '/',
    git: existsSync(path.join(current, '.git')),
    entries: entries.slice(0, MAX_BROWSE_ENTRIES),
    truncated: entries.length > MAX_BROWSE_ENTRIES,
  };
}
