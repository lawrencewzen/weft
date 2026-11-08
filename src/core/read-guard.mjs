// Sensitive locations the model's read-only file tools (read / ls / grep) must
// not touch, even though they may read outside the workspace. This is a guard
// against accidents, not isolation: bash / powershell are not restricted.
import { realpath as realpathCallback } from 'node:fs';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

/** Credential entries under the user's home directory. */
export const HOME_SENSITIVE_ENTRIES = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.git-credentials',
];

const realpathNative = promisify(realpathCallback.native);

const WIN_HOME_SENSITIVE_ENTRIES = ['AppData/Roaming/GitHub CLI'];
const POSIX_SYSTEM_SENSITIVE = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers', '/etc/sudoers.d'];
const WIN_SYSTEM_SENSITIVE = [['System32', 'config']];

function sensitiveError(target, label) {
  const err = new Error(`E_SENSITIVE: 这是敏感位置（${label}），不允许读取：${target}`);
  err.code = 'E_SENSITIVE';
  return err;
}

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Windows ignores trailing dots and spaces in a segment; `\\?\` is a prefix only. */
function normalize(p, platform) {
  const api = pathApi(platform);
  let s = String(p ?? '');
  if (platform === 'win32') {
    s = s.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replaceAll('/', '\\');
  }
  s = api.resolve(s);
  if (platform === 'win32') {
    const { root } = api.parse(s);
    const rest = s.slice(root.length).split('\\').map((seg) => (
      seg === '' || /^\.+$/.test(seg) ? seg : seg.replace(/[. ]+$/, '')
    )).join('\\');
    s = root + rest;
  }
  return s;
}

function foldCase(s, platform) {
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;
}

function under(entry, target, platform) {
  const api = pathApi(platform);
  const e = foldCase(entry, platform);
  const t = foldCase(target, platform);
  return t === e || t.startsWith(e.endsWith(api.sep) ? e : e + api.sep);
}

/** Subfolders of the data directory that hold user workspaces, not credentials. */
const DATA_DIR_OPEN = ['workspaces', 'chats'];

/**
 * Pure rule check on an already realpath-ed absolute path.
 * Returns the label of the matching rule, or '' when readable.
 */
export function sensitiveRule(resolved, { homes = [], dataDirs = [], root = '', platform = process.platform } = {}) {
  const api = pathApi(platform);
  const target = normalize(resolved, platform);
  const rootN = root ? normalize(root, platform) : '';
  for (const dir of dataDirs) {
    const base = normalize(dir, platform);
    if (!under(base, target, platform)) continue;
    // A workspace placed inside the data directory keeps its own files readable.
    // A root that is the data directory itself, or contains it, gives no exemption.
    if (rootN && rootN !== base && under(base, rootN, platform) && under(rootN, target, platform)) continue;
    if (DATA_DIR_OPEN.some((name) => under(api.join(base, name), target, platform))) continue;
    return 'Weft 数据目录，含 provider 凭据';
  }
  const names = [...HOME_SENSITIVE_ENTRIES, ...(platform === 'win32' ? WIN_HOME_SENSITIVE_ENTRIES : [])];
  for (const home of homes) {
    for (const name of names) {
      if (under(api.join(normalize(home, platform), ...name.split('/')), target, platform)) {
        return `用户目录下的 ${name}，含凭据`;
      }
    }
  }
  const system = platform === 'win32'
    ? WIN_SYSTEM_SENSITIVE.map((rel) => api.join(process.env.SystemRoot || 'C:\\Windows', ...rel))
    : POSIX_SYSTEM_SENSITIVE;
  for (const entry of system) {
    if (under(normalize(entry, platform), target, platform)) return '系统凭据文件';
  }
  return '';
}

/** realpath (native, so Windows 8.3 short names expand) of the longest existing prefix. */
export async function realpathLoose(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = await realpathNative(current);
      return missing.reduceRight((acc, name) => path.join(acc, name), real);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function candidates(list) {
  const out = new Set();
  for (const item of list) {
    if (!item) continue;
    out.add(path.resolve(item));
    try { out.add(await realpathLoose(item)); } catch { /* unreadable */ }
  }
  return [...out];
}

/** Weft data directories: the one this process uses, WEFT_DATA_DIR, and %APPDATA%\Weft. */
function dataDirList(dataDir) {
  return [dataDir, process.env.WEFT_DATA_DIR, process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Weft')
    : ''];
}

/**
 * Throw E_SENSITIVE when `target` (any spelling, symlink or junction included)
 * resolves into a sensitive location. Failures to resolve are treated as blocked.
 */
export async function assertReadablePath(target, { dataDir, root } = {}) {
  let real;
  try {
    real = await realpathLoose(target);
  } catch {
    throw sensitiveError(target, '无法解析路径');
  }
  const homes = await candidates([os.homedir(), process.env.USERPROFILE, process.env.HOME]);
  const dataDirs = await candidates(dataDirList(dataDir));
  const realRoot = root ? await realpathLoose(root).catch(() => root) : '';
  // Check the lexical spelling too, in case a link was replaced between steps.
  for (const spelling of new Set([real, path.resolve(target)])) {
    const label = sensitiveRule(spelling, { homes, dataDirs, root: realRoot });
    if (label) throw sensitiveError(spelling, label);
  }
}
