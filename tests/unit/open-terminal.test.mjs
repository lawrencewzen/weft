import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  quotePwshLiteral,
  escapeWtArg,
  terminalLaunches,
  openInSystemTerminal,
} from '../../src/core/open-terminal.mjs';

const SPACE_DIR = 'C:\\Users\\Alice\\My Project';
const CN_DIR = 'C:\\Users\\张三\\项目';
const QUOTE_DIR = "C:\\Users\\O'Brien\\code";
const UNIX_SPACE = "/tmp/weft's dir/中文";

function fakeSpawn(decide) {
  const calls = [];
  const spawn = (command, args, opts) => {
    calls.push({ command, args, opts: { ...opts } });
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    const outcome = decide({ command, args, opts, index: calls.length - 1 });
    queueMicrotask(() => {
      if (outcome === 'ok') {
        child.emit('spawn');
        return;
      }
      const err = new Error(outcome?.message || `spawn ${command} ENOENT`);
      err.code = outcome?.code || 'ENOENT';
      child.emit('error', err);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

function alwaysOk() {
  return fakeSpawn(() => 'ok');
}

test('quotePwshLiteral doubles single quotes and wraps the path', () => {
  assert.equal(quotePwshLiteral(SPACE_DIR), `'${SPACE_DIR}'`);
  assert.equal(quotePwshLiteral(CN_DIR), `'${CN_DIR}'`);
  assert.equal(quotePwshLiteral(QUOTE_DIR), `'C:\\Users\\O''Brien\\code'`);
  assert.equal(quotePwshLiteral(UNIX_SPACE), `'/tmp/weft''s dir/中文'`);
});

test('darwin uses open -a Terminal, or WEFT_TERMINAL_APP', () => {
  const dir = '/Users/alice/weft';
  assert.deepEqual(terminalLaunches(dir, { platform: 'darwin', env: {} }), [
    { command: 'open', args: ['-a', 'Terminal', dir] },
  ]);
  assert.deepEqual(terminalLaunches(dir, { platform: 'darwin', env: { WEFT_TERMINAL_APP: 'iTerm' } }), [
    { command: 'open', args: ['-a', 'iTerm', dir] },
  ]);
});

test('windows prefers wt.exe -d, then cmd /c start "" powershell with LiteralPath', () => {
  for (const dir of [SPACE_DIR, CN_DIR, QUOTE_DIR]) {
    const launches = terminalLaunches(dir, { platform: 'win32', env: {} });
    assert.equal(launches[0].command, 'wt.exe');
    assert.deepEqual(launches[0].args, ['-d', dir]);
    assert.equal(launches[1].command, 'cmd.exe');
    assert.deepEqual(launches[1].args, [
      '/c',
      'start',
      '',
      'powershell.exe',
      '-NoExit',
      '-Command',
      `Set-Location -LiteralPath ${quotePwshLiteral(dir)}`,
    ]);
    assert.equal(typeof launches[1].args[launches[1].args.length - 1], 'string');
    assert.ok(Array.isArray(launches[1].args));
  }
});

test('windows wt.exe escapes semicolons in the directory as one argv; powershell LiteralPath keeps them', () => {
  const dir = 'C:\\w\\a ; new-tab calc';
  assert.equal(escapeWtArg(dir), 'C:\\w\\a \\; new-tab calc');
  const launches = terminalLaunches(dir, { platform: 'win32', env: {} });
  assert.equal(launches[0].command, 'wt.exe');
  assert.equal(launches[0].args.length, 2);
  assert.deepEqual(launches[0].args, ['-d', 'C:\\w\\a \\; new-tab calc']);
  assert.equal(launches[0].args.includes('new-tab'), false);
  assert.equal(launches[1].command, 'cmd.exe');
  assert.equal(
    launches[1].args[launches[1].args.length - 1],
    `Set-Location -LiteralPath ${quotePwshLiteral(dir)}`,
  );
  assert.equal(launches[1].args[launches[1].args.length - 1].includes('; new-tab calc'), true);
  assert.equal(launches[1].args[launches[1].args.length - 1].includes('\\;'), false);
});

test('linux tries x-terminal-emulator then gnome-terminal --working-directory', () => {
  const dir = UNIX_SPACE;
  const launches = terminalLaunches(dir, { platform: 'linux', env: {} });
  assert.deepEqual(launches[0], { command: 'x-terminal-emulator', args: [], cwd: dir });
  assert.deepEqual(launches[1], {
    command: 'gnome-terminal',
    args: [`--working-directory=${dir}`],
  });
});

test('openInSystemTerminal spawns with detached, stdio ignore, unref, and argv arrays', async () => {
  const spawn = alwaysOk();
  const dir = UNIX_SPACE;
  await openInSystemTerminal(dir, { platform: 'linux', env: {}, spawn });
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, 'x-terminal-emulator');
  assert.deepEqual(spawn.calls[0].args, []);
  assert.equal(spawn.calls[0].opts.detached, true);
  assert.equal(spawn.calls[0].opts.stdio, 'ignore');
  assert.equal(spawn.calls[0].opts.cwd, dir);
  assert.equal(spawn.calls[0].opts.shell, undefined);
});

test('darwin spawn args keep spaces / chinese / quotes as one argv element', async () => {
  const spawn = alwaysOk();
  const dir = UNIX_SPACE;
  await openInSystemTerminal(dir, {
    platform: 'darwin',
    env: { WEFT_TERMINAL_APP: 'iTerm' },
    spawn,
  });
  assert.deepEqual(spawn.calls[0], {
    command: 'open',
    args: ['-a', 'iTerm', dir],
    opts: { detached: true, stdio: 'ignore' },
  });
});

test('windows falls back to powershell when wt.exe is missing', async () => {
  const spawn = fakeSpawn(({ command }) => (command === 'wt.exe' ? { code: 'ENOENT' } : 'ok'));
  const dir = QUOTE_DIR;
  const result = await openInSystemTerminal(dir, { platform: 'win32', env: {}, spawn });
  assert.equal(result.command, 'cmd.exe');
  assert.equal(spawn.calls.length, 2);
  assert.equal(spawn.calls[0].command, 'wt.exe');
  assert.deepEqual(spawn.calls[1].args, [
    '/c',
    'start',
    '',
    'powershell.exe',
    '-NoExit',
    '-Command',
    `Set-Location -LiteralPath ${quotePwshLiteral(dir)}`,
  ]);
});

test('windows uses wt.exe when it spawns', async () => {
  const spawn = alwaysOk();
  const dir = SPACE_DIR;
  const result = await openInSystemTerminal(dir, { platform: 'win32', env: {}, spawn });
  assert.equal(result.command, 'wt.exe');
  assert.deepEqual(spawn.calls[0].args, ['-d', dir]);
  assert.equal(spawn.calls.length, 1);
});

test('linux 501 when both emulators are missing', async () => {
  const spawn = fakeSpawn(() => ({ code: 'ENOENT' }));
  await assert.rejects(
    () => openInSystemTerminal('/tmp/ws', { platform: 'linux', env: {}, spawn }),
    (err) => {
      assert.equal(err.code, 'E_NO_TERMINAL');
      assert.equal(err.status, 501);
      assert.match(err.message, /x-terminal-emulator/);
      assert.match(err.message, /gnome-terminal/);
      return true;
    },
  );
  assert.equal(spawn.calls.length, 2);
});

test('ENOENT on the only darwin command is E_NO_TERMINAL 501', async () => {
  const spawn = fakeSpawn(() => ({ code: 'ENOENT' }));
  await assert.rejects(
    () => openInSystemTerminal('/tmp/ws', { platform: 'darwin', env: {}, spawn }),
    (err) => err.code === 'E_NO_TERMINAL' && err.status === 501,
  );
});

test('non-ENOENT spawn errors are E_TERMINAL 500', async () => {
  const spawn = fakeSpawn(() => ({ code: 'EACCES', message: 'permission denied' }));
  await assert.rejects(
    () => openInSystemTerminal('/tmp/ws', { platform: 'darwin', env: {}, spawn }),
    (err) => {
      assert.equal(err.code, 'E_TERMINAL');
      assert.equal(err.status, 500);
      assert.match(err.message, /permission denied/);
      return true;
    },
  );
});

test('this process.platform is one of the documented launchers', () => {
  const launches = terminalLaunches('/tmp/ws');
  assert.ok(launches.length >= 1);
  if (process.platform === 'win32') {
    assert.equal(launches[0].command, 'wt.exe');
    assert.equal(launches[1].command, 'cmd.exe');
  } else if (process.platform === 'darwin') {
    assert.equal(launches[0].command, 'open');
  } else {
    assert.equal(launches[0].command, 'x-terminal-emulator');
    assert.equal(launches[1].command, 'gnome-terminal');
  }
});

test('WEFT_TERMINAL_MOCK=1 does not spawn', async () => {
  const spawn = alwaysOk();
  const result = await openInSystemTerminal('/tmp/ws', {
    platform: 'linux',
    env: { WEFT_TERMINAL_MOCK: '1' },
    spawn,
  });
  assert.deepEqual(result, { opened: true, mocked: true });
  assert.equal(spawn.calls.length, 0);
});

test('WEFT_TERMINAL_MOCK log path records argv and skips spawn', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-term-mock-'));
  const log = path.join(dir, 'spawn.jsonl');
  const spawn = alwaysOk();
  try {
    await openInSystemTerminal(QUOTE_DIR, {
      platform: 'win32',
      env: { WEFT_TERMINAL_MOCK: log },
      spawn,
    });
    assert.equal(spawn.calls.length, 0);
    const recorded = JSON.parse((await readFile(log, 'utf8')).trim());
    assert.equal(recorded.platform, 'win32');
    assert.equal(recorded.dir, QUOTE_DIR);
    assert.equal(recorded.launches[0].command, 'wt.exe');
    assert.deepEqual(recorded.launches[0].args, ['-d', QUOTE_DIR]);
    assert.equal(recorded.launches[0].detached, true);
    assert.equal(recorded.launches[0].stdio, 'ignore');
    assert.equal(recorded.launches[1].command, 'cmd.exe');
    assert.ok(recorded.launches[1].args.includes(`Set-Location -LiteralPath ${quotePwshLiteral(QUOTE_DIR)}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
