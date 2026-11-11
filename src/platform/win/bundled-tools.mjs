// Tools shipped inside the Windows package (intranet only):
//   <package>\tools\rg\rg.exe       ripgrep
//   <package>\tools\pwsh\pwsh.exe   PowerShell 7
// <package> is the folder holding Weft.exe, node\ and app\. The server code lives
// in app\, so tools\ is a sibling of app\. A tools\ folder inside the app root is
// also accepted (running from a checkout). Priority everywhere: bundled, then PATH.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const TOOLS = {
  rg: { dir: 'rg', exe: 'rg.exe' },
  pwsh: { dir: 'pwsh', exe: 'pwsh.exe' },
};

/** Candidate `tools` folders, package layout first. */
export function bundledToolsRoots(appRoot = DEFAULT_APP_ROOT) {
  const roots = [];
  if (path.basename(appRoot).toLowerCase() === 'app') roots.push(path.join(path.dirname(appRoot), 'tools'));
  roots.push(path.join(appRoot, 'tools'));
  return roots;
}

/**
 * Absolute path of a bundled tool, or null. Bundled tools exist only in the
 * Windows package, so other platforms always get null.
 *
 * @param {'rg' | 'pwsh'} name
 * @param {{ platform?: string, appRoot?: string, exists?: (p: string) => boolean }} [options]
 */
export function bundledToolPath(name, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return null;
  const spec = TOOLS[name];
  if (!spec) return null;
  const exists = options.exists ?? existsSync;
  for (const root of bundledToolsRoots(options.appRoot)) {
    const file = path.join(root, spec.dir, spec.exe);
    try {
      if (exists(file)) return file;
    } catch { /* unreadable */ }
  }
  return null;
}

/** Directories to put in front of PATH for Agent commands (only those that exist). */
export function bundledToolDirs(options = {}) {
  const dirs = [];
  for (const name of ['rg', 'pwsh']) {
    const file = bundledToolPath(name, options);
    if (file) dirs.push(path.dirname(file));
  }
  return dirs;
}

/**
 * Tool lookup result: `{ source: 'bundled' | 'PATH' | 'none', path }`.
 * `findOnPath(name)` returns a path or null; callers inject their own.
 */
export function resolveTool(name, { findOnPath, ...options } = {}) {
  const bundled = bundledToolPath(name, options);
  if (bundled) return { source: 'bundled', path: bundled };
  const found = findOnPath ? findOnPath(name) : null;
  if (found) return { source: 'PATH', path: found };
  return { source: 'none', path: null };
}

/**
 * Set WEFT_RG_PATH to the bundled rg.exe when it exists and the variable is
 * not already set (an explicit value always wins). Returns the path set, or null.
 */
export function applyBundledRgEnv(env = process.env, options = {}) {
  if (String(env.WEFT_RG_PATH ?? '').trim()) return null;
  const rg = bundledToolPath('rg', options);
  if (!rg) return null;
  env.WEFT_RG_PATH = rg;
  return rg;
}

/** Put `dirs` in front of the PATH variable (whatever its casing) of a plain env object. */
export function prependPath(env, dirs, sep = ';') {
  const wanted = dirs.filter(Boolean);
  if (!wanted.length) return env;
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'Path';
  const rest = String(env[key] ?? '').split(sep).filter(Boolean);
  const lower = (p) => p.toLowerCase();
  const front = wanted.filter((dir, i) => wanted.findIndex((d) => lower(d) === lower(dir)) === i);
  const tail = rest.filter((p) => !front.some((dir) => lower(dir) === lower(p)));
  env[key] = [...front, ...tail].join(sep);
  return env;
}
