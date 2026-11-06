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

/**
 * `resolved` is already absolute on the non-Windows path (callers realpath it).
 * Windows compares with path.win32 and ignores case, so `C:\\USERS\\x\\.SSH`
 * is the same directory as `C:\\Users\\x\\.ssh`.
 */
function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isUnder(root, resolved, platform = process.platform) {
  if (!root || !resolved) return false;
  const p = pathApi(platform);
  if (platform === 'win32') {
    const r = p.resolve(root);
    const target = p.resolve(resolved);
    const rl = r.toLowerCase();
    const tl = target.toLowerCase();
    if (tl === rl) return true;
    const prefix = rl.endsWith('\\') ? rl : `${rl}\\`;
    return tl.startsWith(prefix);
  }
  // posix, not the host path API: Windows CI still checks Unix rules with platform: 'linux'.
  const r = p.resolve(root);
  return resolved === r || resolved.startsWith(r + p.sep);
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

function filesystemRoot(resolved, platform = process.platform) {
  if (platform === 'win32') {
    if (!resolved) return false;
    const root = path.win32.parse(resolved).root;
    if (!root) return false;
    return path.win32.resolve(resolved).toLowerCase() === path.win32.resolve(root).toLowerCase();
  }
  const root = path.posix.parse(resolved).root;
  return Boolean(root) && resolved === root;
}

/**
 * Browse parent of a filesystem root.
 * Windows drive roots (`D:\\`) return `""`, the sentinel for the drive list.
 * Other platforms return null. Non-roots return undefined so the caller
 * walks to the real parent directory.
 */
export function filesystemRootParent(resolved, platform = process.platform) {
  if (!filesystemRoot(resolved, platform)) return undefined;
  return platform === 'win32' ? '' : null;
}

/**
 * %SystemRoot% on Windows. Unset or blank falls back to `C:\\Windows`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function windowsSystemRoot(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const raw = source.SystemRoot ?? source.SYSTEMROOT ?? source.systemroot ?? '';
  const text = String(raw).trim();
  return text || 'C:\\Windows';
}

/**
 * Directories the picker must not enter and that cannot be a workspace.
 * `resolved` is an absolute path (realpath already applied by callers).
 * Drive roots and `/` are not sensitive. $HOME itself is not sensitive.
 * On win32, comparison is case-insensitive. Only ~/.ssh, ~/.gnupg, and
 * `%SystemRoot%` (default `C:\\Windows`) plus its children are sensitive.
 * Unix SYSTEM_PREFIXES are not applied: path.win32.resolve would pin `/var`
 * onto the process drive and block ordinary folders such as `D:\\var\\www`.
 */
export function pathIsSensitive(resolved, {
  home,
  platform = process.platform,
  systemRoot = null,
  prefixes,
} = {}) {
  if (!resolved || filesystemRoot(resolved, platform)) return false;
  const activePrefixes = prefixes ?? (platform === 'win32' ? [] : SYSTEM_PREFIXES);
  const join = pathApi(platform).join;
  if (home) {
    if (isUnder(join(home, '.ssh'), resolved, platform)) return true;
    if (isUnder(join(home, '.gnupg'), resolved, platform)) return true;
  }
  for (const prefix of activePrefixes) {
    if (isUnder(prefix, resolved, platform)) return true;
  }
  if (platform === 'win32' && systemRoot && isUnder(systemRoot, resolved, platform)) return true;
  return false;
}

/**
 * Directories the picker must not enter and that cannot be a workspace:
 * ~/.ssh, ~/.gnupg, and system directories. The filesystem root is not
 * sensitive to browse (the picker walks up to it). $HOME itself is allowed.
 * Windows refuses %SystemRoot% and its children, and does not apply Unix
 * SYSTEM_PREFIXES. Symlinks and junctions are already resolved by the caller,
 * so they cannot point around this check.
 */
async function isSensitive(resolved, home) {
  if (!resolved || filesystemRoot(resolved)) return false;
  const prefixes = [];
  let systemRoot = null;
  if (process.platform === 'win32') {
    const configured = windowsSystemRoot();
    systemRoot = configured;
    try {
      const real = await fs.realpath(configured);
      if (real && real.toLowerCase() !== configured.toLowerCase()) prefixes.push(real);
    } catch { /* keep the configured path */ }
  } else {
    for (const prefix of SYSTEM_PREFIXES) {
      prefixes.push(prefix);
      try {
        const real = await fs.realpath(prefix);
        if (real !== prefix) prefixes.push(real);
      } catch { /* missing */ }
    }
  }
  return pathIsSensitive(resolved, { home, systemRoot, prefixes });
}

async function browseParent(current, home) {
  const rooted = filesystemRootParent(current);
  if (rooted !== undefined) return rooted;
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
 * and system directories. On Windows, drive roots such as `C:\\` and `D:\\`
 * stay allowed; `%SystemRoot%` and its children do not. The home directory
 * itself is allowed. WEFT_WORKSPACE_ROOT is not an allowlist; it is only the
 * folder picker's default start (see defaultWorkspaceRoot / listBrowsableDirs).
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

/** Per-drive fs.access bound so an empty or sleeping volume cannot stall the list. */
export const DRIVE_ACCESS_TIMEOUT_MS = 2000;

function accessWithTimeout(access, target, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Promise.resolve()
      .then(() => access(target))
      .then(() => finish(true), () => finish(false));
  });
}

/**
 * Drive letters that exist right now. Only win32; other platforms throw 404 E_PATH.
 * Each letter is probed independently. A hang or error on one letter is skipped
 * and does not block the rest. `path` is `""`, `parent` is null, and the row
 * is not a selectable workspace.
 *
 * @param {{
 *   platform?: string,
 *   access?: (target: string) => Promise<void> | void,
 *   timeoutMs?: number,
 *   root?: string,
 * }} [options]
 */
export async function listWindowsDrives({
  platform = process.platform,
  access = fs.access,
  timeoutMs = DRIVE_ACCESS_TIMEOUT_MS,
  root,
} = {}) {
  if (platform !== 'win32') throw fail('path is not allowed', 404);
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const checks = [...letters].map(async (letter) => {
    const drivePath = `${letter}:\\`;
    const ok = await accessWithTimeout(access, drivePath, timeoutMs);
    if (!ok) return null;
    return { name: `${letter}:`, path: drivePath, git: false };
  });
  const entries = (await Promise.all(checks)).filter(Boolean);
  return {
    root: root ?? await realOrResolve(defaultWorkspaceRoot()),
    path: '',
    parent: null,
    selectable: false,
    git: false,
    entries,
    truncated: false,
  };
}

/**
 * Folder picker for the new-workspace dialog. Lists sub-folders of `inputPath`
 * (default: defaultWorkspaceRoot()). Navigation is not limited to that start
 * directory. Hidden folders and symlinks into sensitive directories are skipped.
 * `/` can be listed but is not selectable. On Windows a drive root such as
 * `D:\\` is selectable and its parent is `""` (the drive list). $HOME is selectable.
 * Read-only.
 * `options.view === 'drives'` lists drive letters (win32 only).
 */
export async function listBrowsableDirs(inputPath, options = {}) {
  const opts = options ?? {};
  if (opts.view === 'drives') return listWindowsDrives(opts);
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
