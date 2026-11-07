import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  WIN_FOLDER_PICK_SCRIPT,
  WIN_PICK_CANCEL_MARKER,
  WIN_PICK_NONINTERACTIVE_EXIT,
  WIN_PICK_PROMPT_ENV,
  WIN_PICK_START_ENV,
  encodePowerShellCommand,
  pickWin32Folder,
  windowsPickerArgs,
  windowsPickerExecOptions,
} from '../../src/platform/win/folder-picker.mjs';

const START = 'D:\\起点 目录\\工作区';
const PROMPT = '选择文件夹';

function resolvedRunner(result) {
  return () => ({
    kill() {},
    promise: Promise.resolve(result),
  });
}

function enoent() {
  return {
    error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    stdout: '',
    stderr: '',
  };
}

async function withPath(names, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weft-win-pick-'));
  try {
    for (const name of names) await writeFile(path.join(dir, name), '');
    const env = { Path: dir, PATH: dir, PATHEXT: '.EXE;.CMD;.BAT;.COM' };
    await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function decodeScript(args) {
  assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
  assert.equal(args.includes('-Command'), false);
  assert.equal(args.includes('-File'), false);
  assert.equal(args.includes('-c'), false);
  const script = Buffer.from(args[4], 'base64').toString('utf16le');
  assert.equal(script, WIN_FOLDER_PICK_SCRIPT);
  assert.equal(script.includes(START), false);
  assert.equal(script.includes(PROMPT), false);
  assert.match(script, /\[Console\]::OutputEncoding/);
  assert.match(script, /UTF8Encoding \$false/);
  assert.match(script, /\[Environment\]::UserInteractive/);
  assert.match(script, new RegExp(`exit ${WIN_PICK_NONINTERACTIVE_EXIT}`));
  assert.match(script, /System\.Windows\.Forms\.FolderBrowserDialog/);
  assert.match(script, /\$dialog\.ShowDialog\(\)/);
  assert.equal(script.includes('$owner'), false);
  // dialog itself goes topmost: timer in the modal loop, #32770, HWND_TOPMOST
  assert.match(script, /System\.Windows\.Forms\.Timer|new Timer\(\)/);
  assert.match(script, /EnumThreadWindows/);
  assert.match(script, /"#32770"/);
  assert.match(script, /SetWindowPos\(h, new IntPtr\(-1\), 0, 0, 0, 0, 0x0001 \| 0x0002 \| 0x0040\)/);
  assert.match(script, /SetForegroundWindow/);
  // topmost part is isolated: its own try/catch inside the outer try, before ShowDialog
  const top = script.indexOf('Add-Type -ReferencedAssemblies');
  assert.ok(script.lastIndexOf('try {', top) > script.indexOf('try {'));
  assert.ok(script.indexOf('} catch { $weftTop = $null }') > top);
  assert.ok(script.indexOf('} catch { $weftTop = $null }') < script.indexOf('ShowDialog()'));
  assert.match(script, new RegExp(WIN_PICK_START_ENV));
  assert.match(script, new RegExp(WIN_PICK_CANCEL_MARKER));
  return script;
}

test('encoded command is UTF-16LE and execFile does not use a shell', () => {
  const args = windowsPickerArgs();
  assert.equal(args[4], encodePowerShellCommand(WIN_FOLDER_PICK_SCRIPT));
  decodeScript(args);
  const opts = windowsPickerExecOptions({ Path: 'C:\\Windows' });
  assert.equal(opts.shell, false);
  assert.equal(opts.encoding, 'utf8');
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.env.Path, 'C:\\Windows');
  assert.equal(windowsPickerExecOptions().env, undefined);
});

test('picked Chinese path, cancel marker, non-interactive exit, and other failures', async () => {
  await withPath(['pwsh.exe', 'powershell.exe'], async (env) => {
    let calls = 0;
    const picked = await pickWin32Folder({
      env,
      startDir: START,
      prompt: PROMPT,
      runner: (file, args, options) => {
        calls += 1;
        assert.equal(file, 'pwsh.exe');
        decodeScript(args);
        assert.equal(options.env[WIN_PICK_START_ENV], START);
        assert.equal(options.env[WIN_PICK_PROMPT_ENV], PROMPT);
        assert.equal(JSON.stringify(args).includes(START), false);
        return resolvedRunner({ error: null, stdout: 'D:\\工作\\项目\\\r\n', stderr: '' })();
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(picked, { status: 'picked', path: 'D:\\工作\\项目' });

    const drive = await pickWin32Folder({
      env,
      startDir: START,
      runner: () => resolvedRunner({ error: null, stdout: 'D:/\n', stderr: '' })(),
    });
    assert.deepEqual(drive, { status: 'picked', path: 'D:\\' });

    const cancelled = await pickWin32Folder({
      env,
      startDir: START,
      runner: () => resolvedRunner({
        error: null,
        stdout: `${WIN_PICK_CANCEL_MARKER}\r\n`,
        stderr: '',
      })(),
    });
    assert.deepEqual(cancelled, { status: 'cancelled' });

    const quiet = await pickWin32Folder({
      env,
      startDir: START,
      runner: () => resolvedRunner({
        error: Object.assign(new Error('not interactive'), { code: WIN_PICK_NONINTERACTIVE_EXIT }),
        stdout: '',
        stderr: '',
      })(),
    });
    assert.deepEqual(quiet, { status: 'unsupported' });

    const relative = await pickWin32Folder({
      env,
      startDir: START,
      runner: () => resolvedRunner({ error: null, stdout: '项目\n', stderr: '' })(),
    });
    assert.deepEqual(relative, { status: 'unsupported' });

    const crashed = await pickWin32Folder({
      env,
      startDir: START,
      runner: () => resolvedRunner({
        error: Object.assign(new Error('exit 1'), { code: 1 }),
        stdout: '',
        stderr: 'boom',
      })(),
    });
    assert.deepEqual(crashed, { status: 'unsupported' });
  });
});

test('missing pwsh falls back to powershell.exe; neither executable is unsupported', async () => {
  await withPath(['powershell.exe'], async (env) => {
    const files = [];
    const picked = await pickWin32Folder({
      env,
      startDir: START,
      prompt: PROMPT,
      runner: (file, args, options) => {
        files.push(file);
        decodeScript(args);
        assert.equal(options.env[WIN_PICK_START_ENV], START);
        return resolvedRunner({ error: null, stdout: 'D:\\工作\\项目\n', stderr: '' })();
      },
    });
    assert.deepEqual(files, ['powershell.exe']);
    assert.deepEqual(picked, { status: 'picked', path: 'D:\\工作\\项目' });
  });

  await withPath(['pwsh.exe', 'powershell.exe'], async (env) => {
    const files = [];
    const picked = await pickWin32Folder({
      env,
      startDir: START,
      runner: (file, args) => {
        files.push(file);
        decodeScript(args);
        if (file === 'pwsh.exe') return resolvedRunner(enoent())();
        return resolvedRunner({ error: null, stdout: 'E:\\工作\n', stderr: '' })();
      },
    });
    assert.deepEqual(files, ['pwsh.exe', 'powershell.exe']);
    assert.deepEqual(picked, { status: 'picked', path: 'E:\\工作' });
  });

  let calls = 0;
  const missing = await pickWin32Folder({
    env: { Path: '', PATH: '', PATHEXT: '.EXE' },
    startDir: START,
    runner: () => { calls += 1; return resolvedRunner({ stdout: 'D:\\工作' })(); },
  });
  assert.equal(calls, 0);
  assert.deepEqual(missing, { status: 'unsupported' });

  await withPath(['pwsh.exe', 'powershell.exe'], async (env) => {
    const files = [];
    const bothGone = await pickWin32Folder({
      env,
      startDir: START,
      runner: (file) => {
        files.push(file);
        return resolvedRunner(enoent())();
      },
    });
    assert.deepEqual(files, ['pwsh.exe', 'powershell.exe']);
    assert.deepEqual(bothGone, { status: 'unsupported' });
  });
});

test('a hung dialog is killed at the timeout and the next call can pick', async () => {
  await withPath(['pwsh.exe'], async (env) => {
    let killed = 0;
    const cancelled = await pickWin32Folder({
      env,
      startDir: START,
      timeoutMs: 40,
      runner: () => ({
        promise: new Promise(() => {}),
        kill() { killed += 1; },
      }),
    });
    assert.deepEqual(cancelled, { status: 'cancelled' });
    assert.equal(killed, 1);

    const picked = await pickWin32Folder({
      env,
      startDir: START,
      timeoutMs: 1000,
      runner: () => resolvedRunner({ error: null, stdout: 'D:\\工作\\项目\n', stderr: '' })(),
    });
    assert.deepEqual(picked, { status: 'picked', path: 'D:\\工作\\项目' });
  });
});
