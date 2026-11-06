/**
 * Native folder picker for the local Weft server.
 *
 * The browser cannot see a full local path, so the server opens the system
 * dialog (Claude Desktop's "Select folder"). Only macOS is implemented here.
 * Other platforms return unsupported; Windows belongs on the intranet line.
 *
 * The dialog is started with execFile('osascript', argv). Arguments stay in
 * the argv array and are never joined into a shell command.
 * Tests inject `runner` and never launch a real window.
 */

import { execFile } from 'node:child_process';
import { resolveAllowedWorkspacePath } from './workspace-guard.mjs';

/** Kill the dialog if the user never answers. */
export const FOLDER_PICK_TIMEOUT_MS = 10 * 60 * 1000;

const DEFAULT_PROMPT = 'Select folder';

/** One dialog at a time. Later callers wait on this promise. */
let inflight = null;

function appleScriptString(value) {
  return `"${String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\u2028\u2029]/g, ' ')}"`;
}

/**
 * choose folder runs in Standard Additions, outside the System Events tell,
 * so the command is not sent to System Events. activate brings the dialog forward.
 */
export function buildChooseFolderScript(startDir, prompt) {
  const promptText = prompt == null || String(prompt).trim() === '' ? DEFAULT_PROMPT : String(prompt);
  const start = startDir == null ? '' : String(startDir);
  const location = start === '' ? '' : ` default location POSIX file ${appleScriptString(start)}`;
  return [
    'tell application "System Events" to activate',
    `set chosenFolder to choose folder with prompt ${appleScriptString(promptText)}${location}`,
    'return POSIX path of chosenFolder',
  ].join('\n');
}

function defaultRunner(file, args) {
  let child;
  let settled = false;
  const promise = new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child = execFile(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
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

function normalizePosixPath(stdout) {
  let text = String(stdout ?? '').replace(/^\uFEFF/, '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  if (text.length > 1) text = text.replace(/\/+$/, '');
  return text;
}

function isAppleScriptCancel(text) {
  return /\(-128\)/.test(text) || /user cancell?ed/i.test(text);
}

function osascriptOutcome(result) {
  const error = result?.error ?? null;
  const stderr = `${result?.stderr ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  const stdout = result?.stdout ?? error?.stdout ?? '';
  if (error?.code === 'ENOENT') return { status: 'unsupported' };
  if (isAppleScriptCancel(stderr)) return { status: 'cancelled' };
  if (error) return { status: 'unsupported' };
  const picked = normalizePosixPath(stdout);
  if (!picked.startsWith('/')) return { status: 'unsupported' };
  return { status: 'picked', path: picked };
}

async function pickDarwin({ runner, startDir, prompt, timeoutMs }) {
  const run = typeof runner === 'function' ? runner : defaultRunner;
  const script = buildChooseFolderScript(startDir, prompt);
  let handle;
  try {
    handle = run('osascript', ['-e', script]);
  } catch {
    return { status: 'unsupported' };
  }
  if (!handle || typeof handle.promise?.then !== 'function') return { status: 'unsupported' };

  const timeout = timeoutMs ?? FOLDER_PICK_TIMEOUT_MS;
  let timedOut = false;
  let timer;
  const result = await new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { handle.kill?.(); } catch { /* ignore */ }
      resolve({ timedOut: true });
    }, timeout);
    Promise.resolve(handle.promise).then(
      (value) => {
        if (!timedOut) resolve({ timedOut: false, value });
      },
      (error) => {
        if (!timedOut) resolve({ timedOut: false, value: { error, stdout: '', stderr: '' } });
      },
    );
  });
  clearTimeout(timer);
  if (timedOut || result.timedOut) return { status: 'cancelled' };
  return osascriptOutcome(result.value);
}

/** Platform dispatch. Missing platforms stay unsupported (no Linux/Windows dialog). */
const PLATFORM_PICKERS = {
  darwin: pickDarwin,
};

/**
 * Open one folder dialog.
 * `runner(file, args)` returns `{ promise, kill }` and replaces execFile in tests.
 * Concurrent calls share the in-flight dialog instead of opening another one.
 */
export async function pickFolder({ platform, runner, startDir, prompt, timeoutMs } = {}) {
  if (inflight) return inflight;
  const pick = PLATFORM_PICKERS[platform];
  const promise = (pick
    ? pick({ runner, startDir, prompt, timeoutMs })
    : Promise.resolve({ status: 'unsupported' })
  ).catch(() => ({ status: 'unsupported' })).finally(() => {
    if (inflight === promise) inflight = null;
  });
  inflight = promise;
  return promise;
}

export function isFolderPickerOff(env = process.env) {
  return String(env?.WEFT_FOLDER_PICKER ?? '').trim().toLowerCase() === 'off';
}

/** Host header is loopback: 127.0.0.1, localhost, or [::1], with an optional port. */
export function isLoopbackRequestHost(hostHeader) {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (raw == null) return false;
  let host = String(raw).trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return false;
    const after = host.slice(end + 1);
    if (after !== '' && !/^:\d+$/.test(after)) return false;
    host = host.slice(1, end);
  } else if (/^[^:]+:\d+$/.test(host)) {
    host = host.slice(0, host.lastIndexOf(':'));
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Request gate used by POST /api/v2/workspace-root/pick.
 * Non-loopback hosts and WEFT_FOLDER_PICKER=off return unsupported without
 * calling `runner`. A picked path still has to pass resolveAllowedWorkspacePath;
 * a forbidden path throws that function's E_PATH error.
 *
 * @param {{
 *   host?: unknown,
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   runner?: (file: string, args: string[]) => {
 *     promise: Promise<{
 *       error?: { code?: unknown, message?: string, stderr?: string, stdout?: string } | null,
 *       stdout?: string,
 *       stderr?: string,
 *     }>,
 *     kill?: () => void,
 *   },
 *   startDir?: string,
 *   prompt?: string,
 *   timeoutMs?: number,
 *   dataDir?: string,
 * }} [opts]
 * @returns {Promise<{ status: 'picked', path: string } | { status: 'cancelled' } | { status: 'unsupported' }>}
 */
export async function pickWorkspaceFolder({
  host,
  env = process.env,
  platform = process.platform,
  runner,
  startDir,
  prompt,
  timeoutMs,
  dataDir,
} = {}) {
  if (isFolderPickerOff(env) || !isLoopbackRequestHost(host)) {
    return { status: 'unsupported' };
  }
  const picked = await pickFolder({ platform, runner, startDir, prompt, timeoutMs });
  if (picked.status !== 'picked') return { status: picked.status };
  const path = await resolveAllowedWorkspacePath(picked.path, { dataDir });
  return { status: 'picked', path };
}
