import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  agentShellKind,
  findWindowsExecutable,
  powershellCommandPrefix,
  windowsChildEnv,
  windowsPwshExecutable,
} from '../../src/platform/win/shell.mjs';

test('agentShellKind defaults by platform and honors WEFT_AGENT_SHELL', () => {
  assert.equal(agentShellKind({}, 'win32'), 'powershell');
  assert.equal(agentShellKind({}, 'linux'), 'bash');
  assert.equal(agentShellKind({}, 'darwin'), 'bash');
  assert.equal(agentShellKind({ WEFT_AGENT_SHELL: 'bash' }, 'win32'), 'bash');
  assert.equal(agentShellKind({ WEFT_AGENT_SHELL: 'powershell' }, 'linux'), 'powershell');
  assert.equal(agentShellKind({ WEFT_AGENT_SHELL: 'PowerShell' }, 'linux'), 'powershell');
  assert.equal(agentShellKind({ WEFT_AGENT_SHELL: ' cmd ' }, 'win32'), 'powershell');
  assert.equal(agentShellKind({ WEFT_AGENT_SHELL: '' }, 'linux'), 'bash');
});

test('powershellCommandPrefix sets UTF-8 without BOM for 5.1 and pwsh 7', () => {
  assert.match(powershellCommandPrefix, /UTF8Encoding \$false/);
  assert.match(powershellCommandPrefix, /\$OutputEncoding/);
  assert.match(powershellCommandPrefix, /\[Console\]::InputEncoding/);
  assert.match(powershellCommandPrefix, /\[Console\]::OutputEncoding/);
  assert.equal(powershellCommandPrefix.includes('UTF8Encoding $true'), false);
});

test('windowsChildEnv adds UTF-8 python/less vars and git config overlay', () => {
  const env = windowsChildEnv({ PATH: '/bin', HOME: '/home/weft' });
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(env.LESSCHARSET, 'utf-8');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.quotepath');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'false');
  assert.equal(env.GIT_CONFIG_KEY_1, 'i18n.logOutputEncoding');
  assert.equal(env.GIT_CONFIG_VALUE_1, 'utf-8');
});

test('windowsChildEnv appends git config after an existing GIT_CONFIG_COUNT', () => {
  const env = windowsChildEnv({
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Weft',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'weft@example.com',
  });
  assert.equal(env.GIT_CONFIG_COUNT, '4');
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'Weft');
  assert.equal(env.GIT_CONFIG_KEY_1, 'user.email');
  assert.equal(env.GIT_CONFIG_VALUE_1, 'weft@example.com');
  assert.equal(env.GIT_CONFIG_KEY_2, 'core.quotepath');
  assert.equal(env.GIT_CONFIG_VALUE_2, 'false');
  assert.equal(env.GIT_CONFIG_KEY_3, 'i18n.logOutputEncoding');
  assert.equal(env.GIT_CONFIG_VALUE_3, 'utf-8');
});

test('windowsChildEnv keeps a mixed-case GIT_CONFIG_COUNT and does not leave a duplicate', () => {
  const env = windowsChildEnv({
    Git_Config_Count: '1',
    GIT_CONFIG_KEY_0: 'core.autocrlf',
    GIT_CONFIG_VALUE_0: 'false',
  });
  assert.equal(env.Git_Config_Count, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.autocrlf');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'false');
  assert.equal(env.GIT_CONFIG_KEY_1, 'core.quotepath');
  assert.equal(env.GIT_CONFIG_KEY_2, 'i18n.logOutputEncoding');
});

test('findWindowsExecutable finds pwsh.exe on a fake PATH', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-pwsh-'));
  try {
    await writeFile(path.join(dir, 'pwsh.exe'), '');
    assert.equal(
      findWindowsExecutable('pwsh', { Path: dir, PATHEXT: '.EXE;.CMD' }),
      'pwsh.exe',
    );
    assert.equal(windowsPwshExecutable({ Path: dir, PATHEXT: '.EXE' }), 'pwsh.exe');
    assert.equal(windowsPwshExecutable({ Path: '', PATHEXT: '.EXE' }), null);
    assert.equal(findWindowsExecutable('pwsh', {}), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findWindowsExecutable walks multiple PATH entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'weft-path-'));
  const empty = path.join(root, 'empty');
  const bin = path.join(root, 'bin');
  try {
    await mkdir(empty);
    await mkdir(bin);
    await writeFile(path.join(bin, 'pwsh.exe'), '');
    assert.equal(
      findWindowsExecutable('pwsh', { Path: `${empty};${bin}`, PATHEXT: '.EXE' }),
      'pwsh.exe',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
