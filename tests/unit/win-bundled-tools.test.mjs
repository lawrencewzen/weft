import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import {
  applyBundledRgEnv,
  bundledToolDirs,
  bundledToolPath,
  bundledToolsRoots,
  prependPath,
  resolveTool,
} from '../../src/platform/win/bundled-tools.mjs';
import { agentPowerShellPrograms, windowsChildEnv, windowsPwshExecutable } from '../../src/platform/win/shell.mjs';
import { runDoctor } from '../../src/platform/win/doctor.mjs';

const APP = path.join('C:', 'Weft', 'app');
const PKG_TOOLS = path.join('C:', 'Weft', 'tools');
const RG = path.join(PKG_TOOLS, 'rg', 'rg.exe');
const PWSH = path.join(PKG_TOOLS, 'pwsh', 'pwsh.exe');

function withFiles(...files) {
  const set = new Set(files);
  return { platform: 'win32', appRoot: APP, exists: (p) => set.has(p) };
}

test('tools root: sibling of app\\ first, then <app>/tools', () => {
  assert.deepEqual(bundledToolsRoots(APP), [PKG_TOOLS, path.join(APP, 'tools')]);
  assert.deepEqual(bundledToolsRoots(path.join('C:', 'src', 'weft')), [path.join('C:', 'src', 'weft', 'tools')]);
});

test('bundledToolPath: found, missing, and never off Windows', () => {
  assert.equal(bundledToolPath('rg', withFiles(RG)), RG);
  assert.equal(bundledToolPath('pwsh', withFiles(RG)), null);
  assert.equal(bundledToolPath('rg', { ...withFiles(RG), platform: 'linux' }), null);
  assert.equal(bundledToolPath('git', withFiles(RG)), null);
  assert.equal(bundledToolPath('rg', { ...withFiles(path.join(APP, 'tools', 'rg', 'rg.exe')) }), path.join(APP, 'tools', 'rg', 'rg.exe'));
});

test('resolveTool priority: bundled, PATH, none', () => {
  const findOnPath = (name) => `C:\\Tools\\${name}.exe`;
  assert.deepEqual(resolveTool('rg', { ...withFiles(RG), findOnPath }), { source: 'bundled', path: RG });
  assert.deepEqual(resolveTool('rg', { ...withFiles(), findOnPath }), { source: 'PATH', path: 'C:\\Tools\\rg.exe' });
  assert.deepEqual(resolveTool('rg', { ...withFiles(), findOnPath: () => null }), { source: 'none', path: null });
});

test('applyBundledRgEnv sets WEFT_RG_PATH only when unset and bundled rg exists', () => {
  const env = {};
  assert.equal(applyBundledRgEnv(env, withFiles()), null);
  assert.equal(env.WEFT_RG_PATH, undefined);
  assert.equal(applyBundledRgEnv(env, withFiles(RG)), RG);
  assert.equal(env.WEFT_RG_PATH, RG);
  const set = { WEFT_RG_PATH: 'D:\\mine\\rg.exe' };
  assert.equal(applyBundledRgEnv(set, withFiles(RG)), null);
  assert.equal(set.WEFT_RG_PATH, 'D:\\mine\\rg.exe');
  assert.equal(applyBundledRgEnv({}, { ...withFiles(RG), platform: 'darwin' }), null);
});

test('windowsPwshExecutable and agent programs prefer the bundled pwsh', () => {
  const opts = withFiles(PWSH);
  assert.equal(windowsPwshExecutable({}, opts), PWSH);
  assert.deepEqual(agentPowerShellPrograms(opts), [PWSH, 'pwsh', 'powershell']);
  assert.deepEqual(agentPowerShellPrograms(withFiles()), ['pwsh', 'powershell']);
  // no bundled pwsh and nothing on PATH
  assert.equal(windowsPwshExecutable({}, withFiles()), null);
});

test('prependPath puts tool dirs first, keeps casing of the key, drops duplicates', () => {
  const env = { Path: 'C:\\Windows;C:\\Weft\\tools\\rg;C:\\bin' };
  prependPath(env, ['C:\\Weft\\tools\\rg', 'C:\\Weft\\tools\\pwsh']);
  assert.equal(env.Path, 'C:\\Weft\\tools\\rg;C:\\Weft\\tools\\pwsh;C:\\Windows;C:\\bin');
  assert.equal(Object.keys(env).length, 1);
  const bare = prependPath({}, ['X']);
  assert.equal(bare.Path, 'X');
});

test('bundledToolDirs lists only present tools', () => {
  assert.deepEqual(bundledToolDirs(withFiles(RG)), [path.dirname(RG)]);
  assert.deepEqual(bundledToolDirs(withFiles(RG, PWSH)), [path.dirname(RG), path.dirname(PWSH)]);
  assert.deepEqual(bundledToolDirs(withFiles()), []);
});

test('windowsChildEnv prepends tool dirs to PATH and silences pwsh update checks; no-op without tools', () => {
  const dirs = [path.dirname(RG), path.dirname(PWSH)];
  const env = windowsChildEnv({ Path: 'C:\\Windows' }, { toolDirs: dirs });
  assert.equal(env.Path, `${dirs.join(';')};C:\\Windows`);
  assert.equal(env.POWERSHELL_UPDATECHECK, 'Off');
  assert.equal(env.POWERSHELL_TELEMETRY_OPTOUT, '1');
  const rgOnly = windowsChildEnv({ PATH: 'C:\\Windows' }, { toolDirs: [path.dirname(RG)] });
  assert.equal(rgOnly.PATH, `${path.dirname(RG)};C:\\Windows`);
  assert.equal(rgOnly.POWERSHELL_UPDATECHECK, undefined);
  const none = windowsChildEnv({ PATH: 'C:\\Windows' }, { toolDirs: [] });
  assert.equal(none.PATH, 'C:\\Windows');
});

function fakeDoctor(files, onPath) {
  const exec = async (command, args) => {
    const text = String(command);
    const out = text.endsWith('rg.exe') ? 'ripgrep 15.2.0 (rev abc)\nfeatures:+pcre2'
      : args.includes('$PSVersionTable.PSVersion.ToString()') ? '7.6.10'
        : '';
    return { code: 0, stdout: Buffer.from(out), stderr: Buffer.alloc(0) };
  };
  return runDoctor({
    platform: 'win32',
    env: { Path: 'C:\\x' },
    appRoot: APP,
    existsSync: (p) => files.includes(p),
    which: (name) => onPath[name] ?? null,
    exec,
    readRegistry: async () => Buffer.alloc(0),
    inspectService: async () => ({ running: false }),
    loadShellModule: async () => null,
    tmpdir: () => 'C:\\tmp',
    writeFileSync: () => {},
    rmSync: () => {},
    dataDir: 'C:\\data',
  });
}

test('doctor shows rg and pwsh source and version: bundled / PATH / none', async () => {
  const bundled = await fakeDoctor([RG, PWSH], { pwsh: 'C:\\pf\\pwsh.exe', rg: 'C:\\pf\\rg.exe' });
  assert.match(bundled, /\[内置工具\]\nrg: 来源 bundled，.*rg\.exe，ripgrep 15\.2\.0/);
  assert.match(bundled, /pwsh: 来源 bundled，.*pwsh\.exe，7\.6\.10/);
  assert.match(bundled, /pwsh: .*pwsh\.exe（7\.6\.10）（来源 bundled）/);

  const onPath = await fakeDoctor([], { pwsh: 'C:\\pf\\pwsh.exe', rg: 'C:\\pf\\rg.exe' });
  assert.match(onPath, /rg: 来源 PATH，C:\\pf\\rg\.exe，ripgrep 15\.2\.0/);
  assert.match(onPath, /pwsh: 来源 PATH，C:\\pf\\pwsh\.exe，7\.6\.10/);

  const none = await fakeDoctor([], {});
  assert.match(none, /rg: 来源 none，未找到/);
  assert.match(none, /pwsh: 来源 none，未找到/);
});
