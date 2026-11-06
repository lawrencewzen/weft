/**
 * Windows folder dialog for the intranet line.
 *
 * pwsh.exe when it is on PATH, otherwise powershell.exe. Both missing,
 * or both failing to spawn, is unsupported. execFile gets an argv array
 * (shell: false). The script is -EncodedCommand (UTF-16LE); the start
 * directory is WEFT_FOLDER_PICK_START and is never interpolated into the
 * script. Tests inject `runner` and never open a real window.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { findWindowsExecutable, windowsPwshExecutable } from './shell.mjs';

/** Same bound as FOLDER_PICK_TIMEOUT_MS in src/core/folder-picker.mjs. */
export const WIN_FOLDER_PICK_TIMEOUT_MS = 10 * 60 * 1000;

/** Exit code when [Environment]::UserInteractive is false (service session). */
export const WIN_PICK_NONINTERACTIVE_EXIT = 3;

/** Stdout marker when the user dismisses FolderBrowserDialog. */
export const WIN_PICK_CANCEL_MARKER = '__WEFT_PICK_CANCELLED__';

/** Child env var for the initial folder. Not embedded in the script. */
export const WIN_PICK_START_ENV = 'WEFT_FOLDER_PICK_START';

/** Child env var for the dialog description. Not embedded in the script. */
export const WIN_PICK_PROMPT_ENV = 'WEFT_FOLDER_PICK_PROMPT';

const DEFAULT_PROMPT = 'Select folder';

export const WIN_FOLDER_PICK_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
if (-not [Environment]::UserInteractive) { exit ${WIN_PICK_NONINTERACTIVE_EXIT} }
try {
  Add-Type -AssemblyName System.Windows.Forms
  $owner = New-Object System.Windows.Forms.Form
  $owner.ShowInTaskbar = $false
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $owner.Opacity = 0
  $owner.TopMost = $true
  $owner.Show() | Out-Null
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.ShowNewFolderButton = $true
  $prompt = [Environment]::GetEnvironmentVariable('${WIN_PICK_PROMPT_ENV}')
  if ($prompt) { $dialog.Description = $prompt }
  $start = [Environment]::GetEnvironmentVariable('${WIN_PICK_START_ENV}')
  if ($start) {
    $dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer
    $dialog.SelectedPath = $start
  }
  $result = $dialog.ShowDialog($owner)
  $owner.Close()
  $owner.Dispose()
  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
    [Console]::Out.WriteLine($dialog.SelectedPath)
    exit 0
  }
  [Console]::Out.WriteLine('${WIN_PICK_CANCEL_MARKER}')
  exit 0
} catch {
  exit 1
}
`.trim();

/** UTF-16LE base64, the only form -EncodedCommand accepts. */
export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

export function windowsPickerArgs(script = WIN_FOLDER_PICK_SCRIPT) {
  return ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodePowerShellCommand(script)];
}

/**
 * execFile options for the dialog. `shell: false` keeps the argv array
 * out of cmd.exe. `env` is set only when the caller supplies one.
 */
export function windowsPickerExecOptions(env) {
  const opts = {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 1024 * 1024,
  };
  if (env) opts.env = env;
  return opts;
}

/**
 * pwsh.exe first when it exists on PATH, then powershell.exe.
 * An empty list means both are missing.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function windowsPickerCandidates(env = process.env) {
  const found = [];
  const pwsh = windowsPwshExecutable(env);
  if (pwsh) found.push(pwsh);
  const powershell = findWindowsExecutable('powershell', env);
  if (powershell && !found.includes(powershell)) found.push(powershell);
  return found;
}

export function windowsPickerChildEnv(env, startDir, prompt) {
  const base = { ...(env && typeof env === 'object' ? env : process.env) };
  if (startDir == null || String(startDir).trim() === '') delete base[WIN_PICK_START_ENV];
  else base[WIN_PICK_START_ENV] = String(startDir);
  const promptText = prompt == null || String(prompt).trim() === '' ? DEFAULT_PROMPT : String(prompt);
  base[WIN_PICK_PROMPT_ENV] = promptText;
  return base;
}

function normalizePickerStdout(stdout) {
  let text = String(stdout ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
  return text;
}

function normalizeWinPick(text) {
  if (/^[a-zA-Z]:[\\/]$/.test(text)) return `${text[0]}:\\`;
  return text.replace(/[\\/]+$/, '');
}

/**
 * Map one process result to a picker status.
 * `enoent` is internal: the caller may try the next executable.
 */
export function interpretWindowsPickerResult(result) {
  const error = result?.error ?? null;
  const code = error?.code;
  if (code === 'ENOENT') return { status: 'enoent' };
  const stdout = result?.stdout ?? error?.stdout ?? '';
  const text = normalizePickerStdout(stdout);
  if (code === WIN_PICK_NONINTERACTIVE_EXIT || String(code) === String(WIN_PICK_NONINTERACTIVE_EXIT)) {
    return { status: 'unsupported' };
  }
  if (text === WIN_PICK_CANCEL_MARKER) return { status: 'cancelled' };
  if (error) return { status: 'unsupported' };
  const picked = normalizeWinPick(text);
  if (!path.win32.isAbsolute(picked)) return { status: 'unsupported' };
  return { status: 'picked', path: picked };
}

function defaultRunner(file, args, options = {}) {
  let child;
  let settled = false;
  const promise = new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child = execFile(file, args, windowsPickerExecOptions(options.env), (error, stdout, stderr) => {
      finish({
        error: error ?? null,
        stdout: stdout == null ? '' : String(stdout),
        stderr: stderr == null ? '' : String(stderr),
      });
    });
    child.on('error', (error) => {
      finish({ error, stdout: '', stderr: '' });
    });
  });
  return {
    promise,
    kill() {
      if (!child) return;
      try { child.kill(); } catch { /* already exited */ }
    },
  };
}

function awaitPicker(handle, timeoutMs) {
  if (!handle || typeof handle.promise?.then !== 'function') {
    return Promise.resolve({ timedOut: false, invalid: true });
  }
  let timedOut = false;
  let timer;
  return new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { handle.kill?.(); } catch { /* ignore */ }
      resolve({ timedOut: true });
    }, timeoutMs);
    Promise.resolve(handle.promise).then(
      (value) => {
        if (!timedOut) resolve({ timedOut: false, value });
      },
      (error) => {
        if (!timedOut) resolve({ timedOut: false, value: { error, stdout: '', stderr: '' } });
      },
    );
  }).finally(() => clearTimeout(timer));
}

/**
 * Open the Windows folder dialog.
 * `runner(file, args, { env })` returns `{ promise, kill }`.
 * A non-interactive session exits WIN_PICK_NONINTERACTIVE_EXIT and is unsupported,
 * so a service does not sit on the 10 minute timer with no visible window.
 *
 * @param {{
 *   runner?: (file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
 *     promise: Promise<{ error?: { code?: unknown, message?: string, stdout?: string, stderr?: string } | null, stdout?: string, stderr?: string }>,
 *     kill?: () => void,
 *   },
 *   startDir?: string,
 *   prompt?: string,
 *   timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 */
export async function pickWin32Folder({ runner, startDir, prompt, timeoutMs, env } = {}) {
  const candidates = windowsPickerCandidates(env ?? process.env);
  if (candidates.length === 0) return { status: 'unsupported' };
  const run = typeof runner === 'function' ? runner : defaultRunner;
  const args = windowsPickerArgs();
  const childEnv = windowsPickerChildEnv(env, startDir, prompt);
  const timeout = timeoutMs ?? WIN_FOLDER_PICK_TIMEOUT_MS;

  for (let i = 0; i < candidates.length; i += 1) {
    let handle;
    try {
      handle = run(candidates[i], args, { env: childEnv });
    } catch {
      return { status: 'unsupported' };
    }
    const waited = await awaitPicker(handle, timeout);
    if (waited.invalid) return { status: 'unsupported' };
    if (waited.timedOut) return { status: 'cancelled' };
    const outcome = interpretWindowsPickerResult(waited.value);
    if (outcome.status === 'enoent' && i < candidates.length - 1) continue;
    if (outcome.status === 'enoent') return { status: 'unsupported' };
    return outcome;
  }
  return { status: 'unsupported' };
}
