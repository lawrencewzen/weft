// Environment check for the problem report (doctor.txt). The base checks are platform neutral.
// Platform packages add their own sections with registerDoctor(name, fn): fn(ctx) returns text
// (or { text }) and may be async. A failing section is reported as a line, never thrown.
import { access, constants, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sections = new Map();

export function registerDoctor(name, fn) {
  if (typeof fn !== 'function') throw new TypeError('doctor section must be a function');
  sections.set(String(name), fn);
  return () => { if (sections.get(String(name)) === fn) sections.delete(String(name)); };
}

export function unregisterDoctor(name) {
  return sections.delete(String(name));
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'];

async function isFile(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** First match of `name` on PATH, or null. Honors PATHEXT on Windows. */
export async function findOnPath(name, env = process.env, platform = process.platform) {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = String(pathVar).split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32'
    ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      if (await isFile(full)) return full;
    }
  }
  return null;
}

async function writable(dir) {
  const probe = path.join(dir, `.weft-doctor-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.code || String(err?.message || err) };
  }
}

export async function baseDoctor({ dataDir, env = process.env, platform = process.platform } = {}) {
  const lines = [];
  const found = {};
  for (const name of ['bash', 'pwsh', 'powershell', 'git', 'node']) found[name] = await findOnPath(name, env, platform);
  const shell = found.bash ? 'bash' : found.pwsh ? 'PowerShell (pwsh)' : found.powershell ? 'PowerShell (powershell)' : 'none found';
  lines.push('[shell]');
  lines.push(`agent shell: ${shell}`);
  lines.push('');
  lines.push('[PATH]');
  for (const [name, where] of Object.entries(found)) lines.push(`${name}: ${where ? `found (${where})` : 'not found'}`);
  lines.push('');
  lines.push('[proxy] (only whether set)');
  for (const name of PROXY_VARS) lines.push(`${name}: ${String(env[name] ?? '').trim() ? 'set' : 'not set'}`);
  lines.push('');
  lines.push('[data directory]');
  if (dataDir) {
    const w = await writable(dataDir);
    lines.push(`${dataDir}: ${w.ok ? 'writable' : `NOT writable (${w.error})`}`);
  } else {
    lines.push('unknown');
  }
  return lines.join('\n');
}

export async function runDoctor(ctx = {}) {
  const out = [];
  try {
    out.push('== base ==', await baseDoctor(ctx));
  } catch (err) {
    out.push('== base ==', `check failed: ${err?.message || err}`);
  }
  for (const [name, fn] of sections) {
    out.push('', `== ${name} ==`);
    try {
      const res = await fn(ctx);
      out.push(typeof res === 'string' ? res : String(res?.text ?? ''));
    } catch (err) {
      out.push(`check failed: ${err?.message || err}`);
    }
  }
  return `${out.join('\n')}\n`;
}
