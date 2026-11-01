// Windows Agent shell: PowerShell 7 (pwsh) instead of Git Bash, UTF-8 child env.
// Original files import a couple of helpers from here so main → intranet merges
// stay small. Not a scheduler; createPowerShellTool still owns execution.
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Must match `@earendil-works/pi-durable` `createPowerShellTool` (`UTF8_OUTPUT`
 * in dist/tools/bash.js). That call SetConsoleOutputCP(65001), which makes
 * cmd.exe misread GBK `.bat` files. We cannot change the library; the prefix
 * below undoes it.
 */
export const PI_DURABLE_UTF8_OUTPUT = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}';

/**
 * Restore the console output CP to the system OEM code page.
 *
 * pwsh 7 (.NET) has `Encoding.Default` = UTF-8 (65001), not ACP/OEM. Using
 * Default after pi-durable's UTF-8 line leaves CP 65001. OEMCodePage is 936
 * on Chinese Win10 and 437 on windows-latest.
 */
export const powershellOemRestore = 'try { [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage) } catch {}';

/**
 * Lines run before each Agent PowerShell command (after pi-durable's UTF-8 line).
 *
 * Keep `$OutputEncoding` as UTF-8 (no BOM): it only encodes PowerShell pipeline
 * stdin to native programs and does not call SetConsoleOutputCP.
 *
 * Do not set `[Console]::OutputEncoding` to UTF-8, `InputEncoding`, or
 * `chcp 65001`. Those change the console output CP; cmd.exe then misreads GBK
 * batch files.
 */
export const powershellCommandPrefix = [
  '$enc = New-Object System.Text.UTF8Encoding $false',
  '$OutputEncoding = $enc',
  powershellOemRestore,
].join('\n');

/** Script body createPowerShellTool actually runs: library UTF-8 line, then our prefix, then the command. */
export function agentPowerShellScript(command) {
  return `${PI_DURABLE_UTF8_OUTPUT}\n${powershellCommandPrefix}\n${command}`;
}

/**
 * Which command tool the model gets. Windows defaults to powershell; Linux/macOS
 * stay on bash. `WEFT_AGENT_SHELL=bash|powershell` overrides (Linux CI).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {'bash' | 'powershell'}
 */
export function agentShellKind(env = process.env, platform = process.platform) {
  const raw = String(env?.WEFT_AGENT_SHELL ?? '').trim().toLowerCase();
  if (raw === 'bash' || raw === 'powershell') return raw;
  return platform === 'win32' ? 'powershell' : 'bash';
}

function gitConfigCount(env) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'GIT_CONFIG_COUNT');
  if (!key) return { key: null, count: 0 };
  const n = Number.parseInt(String(env[key]), 10);
  return { key, count: Number.isFinite(n) && n > 0 ? n : 0 };
}

function setEnv(out, name, value) {
  const folded = name.toUpperCase();
  for (const existing of Object.keys(out)) {
    if (existing !== name && existing.toUpperCase() === folded) delete out[existing];
  }
  out[name] = value;
}

/**
 * UTF-8 defaults for Agent commands (python, git, less) plus git config overlay.
 * Call after the env allow-list. Host `GIT_CONFIG_*` is already stripped; if the
 * filtered env still has a count (tests, or a later overlay), append after it.
 *
 * @param {Record<string, string>} [env]
 * @returns {Record<string, string>}
 */
export function windowsChildEnv(env = {}) {
  const out = { ...env };
  setEnv(out, 'PYTHONUTF8', '1');
  setEnv(out, 'PYTHONIOENCODING', 'utf-8');
  setEnv(out, 'LESSCHARSET', 'utf-8');

  const extra = [
    ['core.quotepath', 'false'],
    ['i18n.logOutputEncoding', 'utf-8'],
  ];
  const { key: countKey, count } = gitConfigCount(out);
  let n = count;
  for (const [gitKey, gitValue] of extra) {
    out[`GIT_CONFIG_KEY_${n}`] = gitKey;
    out[`GIT_CONFIG_VALUE_${n}`] = gitValue;
    n += 1;
  }
  if (countKey) delete out[countKey];
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/**
 * Look up a Windows program on PATH. `pathSep` defaults to `;` so Linux tests
 * can pass a win32-style Path. Returns the basename to spawn, or null.
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ pathSep?: string }} [options]
 * @returns {string | null}
 */
export function findWindowsExecutable(name, env = process.env, options = {}) {
  const pathEnv = String(env?.Path ?? env?.PATH ?? '');
  if (!pathEnv) return null;
  const pathSep = options.pathSep ?? ';';
  const pathext = String(env?.PATHEXT ?? '.EXE;.CMD;.BAT;.COM');
  const exts = pathext.split(';').map((part) => part.trim()).filter(Boolean);
  const lower = name.toLowerCase();
  const hasExt = exts.some((ext) => lower.endsWith(ext.toLowerCase()));
  const files = hasExt ? [name] : [name, ...exts.map((ext) => {
    const suffix = ext.startsWith('.') ? ext : `.${ext}`;
    return `${name}${suffix}`;
  })];
  for (const dir of pathEnv.split(pathSep)) {
    if (!dir) continue;
    for (const file of files) {
      const variants = [file, file.toLowerCase(), file.toUpperCase()];
      for (const variant of variants) {
        try {
          if (existsSync(path.join(dir, variant))) {
            // PATHEXT on Windows is `.EXE`; existsSync matches that casing.
            // Spawn and tests want a stable `name.exe`.
            return lower.endsWith('.exe') ? name : `${name}.exe`;
          }
        } catch {
          /* ignore unreadable PATH entries */
        }
      }
    }
  }
  return null;
}

/** `pwsh.exe` when it exists on PATH; otherwise null. */
export function windowsPwshExecutable(env = process.env, options = {}) {
  return findWindowsExecutable('pwsh', env, options);
}
