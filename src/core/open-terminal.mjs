/**
 * Open a directory in the host's system terminal.
 *
 * Always spawn with an argv array (never a shell string), detached,
 * stdio: 'ignore', then unref. Tests inject `spawn` and never launch a window.
 *
 * WEFT_TERMINAL_MOCK: test-only. `1` skips spawn; any other non-empty value is
 * a JSONL log path that records the launch specs that would have been used.
 */
import { spawn as defaultSpawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';

export function terminalError(message, { status = 500, code = 'E_TERMINAL' } = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** PowerShell single-quoted literal; `'` becomes `''`. */
export function quotePwshLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function darwinApp(env) {
  const raw = String(env?.WEFT_TERMINAL_APP ?? '').trim();
  return raw || 'Terminal';
}

/**
 * Ordered spawn attempts for a platform. Linux tries two commands; Windows
 * tries Windows Terminal then PowerShell via `cmd /c start ""`.
 */
export function terminalLaunches(dir, {
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform === 'darwin') {
    return [{ command: 'open', args: ['-a', darwinApp(env), dir] }];
  }
  if (platform === 'win32') {
    return [
      { command: 'wt.exe', args: ['-d', dir] },
      {
        command: 'cmd.exe',
        args: [
          '/c',
          'start',
          '',
          'powershell.exe',
          '-NoExit',
          '-Command',
          `Set-Location -LiteralPath ${quotePwshLiteral(dir)}`,
        ],
      },
    ];
  }
  return [
    { command: 'x-terminal-emulator', args: [], cwd: dir },
    { command: 'gnome-terminal', args: [`--working-directory=${dir}`] },
  ];
}

function mockMode(env) {
  const raw = String(env?.WEFT_TERMINAL_MOCK ?? '').trim();
  if (!raw) return null;
  if (raw === '1' || raw.toLowerCase() === 'true') return { kind: 'ok' };
  return { kind: 'file', path: raw };
}

function spawnOpts(launch) {
  const opts = {
    detached: true,
    stdio: 'ignore',
  };
  if (launch.cwd) opts.cwd = launch.cwd;
  return opts;
}

function waitSpawned(child) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      child.off('spawn', onSpawn);
      reject(err);
    };
    const onSpawn = () => {
      child.off('error', onError);
      try { child.unref(); } catch { /* ignore */ }
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

async function spawnDetached(launch, spawnFn) {
  const opts = spawnOpts(launch);
  let child;
  try {
    child = spawnFn(launch.command, launch.args, opts);
  } catch (err) {
    throw err;
  }
  await waitSpawned(child);
}

function isNotFound(err) {
  return err && (err.code === 'ENOENT' || err.code === 'ENOTFOUND');
}

function missingMessage(tried) {
  const names = tried.map((row) => row.command).join('、');
  if (tried.some((row) => row.command === 'x-terminal-emulator' || row.command === 'gnome-terminal')) {
    return `没有找到可用的终端程序（${names}）`;
  }
  return `找不到终端程序 ${names}`;
}

/**
 * Open `dir` in a system terminal. `dir` must already be a resolved directory
 * inside the workspace. Does not validate paths.
 */
export async function openInSystemTerminal(dir, {
  platform = process.platform,
  env = process.env,
  spawn: spawnFn = defaultSpawn,
} = {}) {
  const launches = terminalLaunches(dir, { platform, env });
  const mock = mockMode(env);
  if (mock) {
    if (mock.kind === 'file') {
      const line = `${JSON.stringify({
        platform,
        dir,
        launches: launches.map((row) => ({
          command: row.command,
          args: row.args,
          cwd: row.cwd || null,
          detached: true,
          stdio: 'ignore',
        })),
      })}\n`;
      await appendFile(mock.path, line);
    }
    return { opened: true, mocked: true };
  }

  const tried = [];
  let lastErr = null;
  for (const launch of launches) {
    tried.push(launch);
    try {
      await spawnDetached(launch, spawnFn);
      return { opened: true, command: launch.command, args: launch.args };
    } catch (err) {
      lastErr = err;
      if (isNotFound(err)) continue;
      const name = launch.command;
      throw terminalError(`无法打开系统终端（${name}）：${err?.message || err}`, {
        status: 500,
        code: 'E_TERMINAL',
      });
    }
  }
  const status = 501;
  throw terminalError(missingMessage(tried), {
    status,
    code: 'E_NO_TERMINAL',
    cause: lastErr,
  });
}
