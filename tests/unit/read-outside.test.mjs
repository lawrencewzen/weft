// T115: the model's read / ls / grep may leave the workspace, except for
// sensitive locations. write / edit stay inside it. Not isolation: bash is free.
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { sensitiveRule } from '../../src/core/read-guard.mjs';
import { workspaceTools } from '../../src/kernel/tools.mjs';
import { createWorkspaceEnv } from '../../src/kernel/workspace-env.mjs';

const tool = (name) => workspaceTools().find((t) => t.name === name);

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'piw-rout-'));
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, WEFT_DATA_DIR: process.env.WEFT_DATA_DIR };
  const home = path.join(base, 'home');
  const dataDir = path.join(base, 'data');
  const ws = path.join(base, 'ws');
  const other = path.join(base, 'other');
  for (const dir of [home, dataDir, ws, other, path.join(home, '.ssh'), path.join(home, '.config', 'gh')]) {
    await mkdir(dir, { recursive: true });
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.WEFT_DATA_DIR;
  await writeFile(path.join(home, '.ssh', 'id_rsa'), 'PRIVATE');
  await writeFile(path.join(home, '.config', 'gh', 'hosts.yml'), 'token');
  await writeFile(path.join(home, '.npmrc'), '//registry:_authToken=x');
  await writeFile(path.join(dataDir, 'providers.json'), 'KEYS');
  await writeFile(path.join(other, 'plain.txt'), '你好 outside\n');
  await writeFile(path.join(ws, 'in.txt'), 'inside\n');
  const env = await createWorkspaceEnv({ cwd: ws, dataDir });
  t.after(async () => {
    for (const [key, value] of Object.entries(savedHome)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  const api = { env, output() {}, retainedOutput: () => ({ text: '', truncated: false }), diagnostic() {} };
  return { base, home, dataDir, ws, other, env, api };
}

const run = (name, args, api) => tool(name).execute(args, api, BACKGROUND_CONTEXT);
const text = (result) => JSON.stringify(result);

test('read, ls and grep reach ordinary files outside the workspace (absolute path shown)', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.other, 'plain.txt');
  const read = await run('read', { path: target }, f.api);
  assert.match(text(read), /outside/);
  assert.match(text(read), /你好/);
  const rel = await run('read', { path: '../other/plain.txt' }, f.api);
  assert.match(text(rel), /outside/);
  const ls = await run('ls', { path: f.other }, f.api);
  assert.match(text(ls), /plain\.txt/);
  const grep = await run('grep', { pattern: 'outside', path: f.other }, f.api);
  const out = grep.output[0].text.replaceAll('\\', '/');
  assert.ok(out.startsWith(target.replaceAll('\\', '/')), out);
  assert.match(text(await run('read', { path: 'in.txt' }, f.api)), /inside/);
});

test('sensitive locations are refused with a plain message', async (t) => {
  const f = await fixture(t);
  for (const p of [
    path.join(f.home, '.ssh', 'id_rsa'),
    path.join(f.home, '.config', 'gh', 'hosts.yml'),
    path.join(f.home, '.npmrc'),
    path.join(f.dataDir, 'providers.json'),
    path.join(f.home, '.ssh', '..', '.ssh', 'id_rsa'),
  ]) {
    await assert.rejects(run('read', { path: p }, f.api), /E_SENSITIVE.*敏感位置/, p);
  }
  await assert.rejects(run('ls', { path: path.join(f.home, '.ssh') }, f.api), /E_SENSITIVE/);
  await assert.rejects(run('grep', { pattern: 'PRIVATE', path: path.join(f.home, '.ssh') }, f.api), /E_SENSITIVE/);
  // grep over a parent skips the sensitive subtree instead of leaking it
  const wide = await run('grep', { pattern: 'PRIVATE|KEYS|token', path: f.base }, f.api);
  assert.equal(wide.output[0].text, '');
});

test('a symlink into a sensitive location is refused (realpath)', { skip: process.platform === 'win32' && 'symlink needs privilege on Windows CI' }, async (t) => {
  const f = await fixture(t);
  await symlink(path.join(f.home, '.ssh'), path.join(f.ws, 'link-dir'), 'dir');
  await symlink(path.join(f.dataDir, 'providers.json'), path.join(f.other, 'link-file'));
  await assert.rejects(run('read', { path: 'link-dir/id_rsa' }, f.api), /E_SENSITIVE/);
  await assert.rejects(run('read', { path: path.join(f.other, 'link-file') }, f.api), /E_SENSITIVE/);
  await assert.rejects(run('ls', { path: 'link-dir' }, f.api), /E_SENSITIVE/);
});

test('rules fold case and separators on Windows and macOS, not on Linux', () => {
  const win = { platform: 'win32', homes: ['C:\\Users\\Me'], dataDirs: ['C:\\Users\\Me\\AppData\\Roaming\\Weft'] };
  for (const p of [
    'C:\\Users\\Me\\.ssh\\id_rsa',
    'c:/users/me/.SSH/id_rsa',
    'C:/Users/Me/.Config/GH/hosts.yml',
    'C:\\Users\\Me\\.ssh.\\id_rsa',
    '\\\\?\\C:\\Users\\Me\\.aws\\credentials',
    'C:\\Users\\ME\\appdata\\roaming\\weft\\providers.json',
    'C:\\Users\\Me\\.git-credentials',
  ]) assert.ok(sensitiveRule(p, win), p);
  assert.equal(sensitiveRule('C:\\Users\\Me\\AppData\\Roaming\\Weft\\workspaces\\a\\x.txt', win), '');
  assert.equal(sensitiveRule('C:\\Windows\\System32\\drivers\\etc\\hosts', win), '');
  assert.equal(sensitiveRule('C:\\Users\\Me\\.sshx\\a', win), '');
  assert.ok(sensitiveRule('C:\\Windows\\System32\\config\\SAM', { ...win }));
  const mac = { platform: 'darwin', homes: ['/Users/me'], dataDirs: [] };
  assert.ok(sensitiveRule('/Users/me/.SSH/id_rsa', mac));
  const linux = { platform: 'linux', homes: ['/home/me'], dataDirs: [] };
  assert.ok(sensitiveRule('/home/me/.ssh/id_rsa', linux));
  assert.equal(sensitiveRule('/home/me/.SSH/id_rsa', linux), '');
  assert.equal(sensitiveRule('/etc/hosts', linux), '');
  assert.ok(sensitiveRule('/etc/shadow', linux));
});

test('write and edit stay inside the workspace (E_SANDBOX); reads are not affected', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.other, 'plain.txt');
  await assert.rejects(run('write', { path: target, content: 'x' }, f.api), /E_SANDBOX/);
  await assert.rejects(run('write', { path: '../other/new.txt', content: 'x' }, f.api), /E_SANDBOX/);
  await assert.rejects(run('edit', { path: target, oldText: 'outside', newText: 'changed' }, f.api), /E_SANDBOX/);
  await assert.rejects(run('edit', { path: target, oldText: 'nope', newText: 'changed' }, f.api), /E_SANDBOX/);
  assert.equal(await readFile(target, 'utf8'), '你好 outside\n');
  await run('write', { path: 'made.txt', content: 'ok' }, f.api);
  assert.equal(await readFile(path.join(f.ws, 'made.txt'), 'utf8'), 'ok');
});

test('a workspace inside the data directory reads its own files; the rest of the data directory stays refused', async (t) => {
  const f = await fixture(t);
  const proj = path.join(f.dataDir, 'proj');
  await mkdir(path.join(proj, 'docs'), { recursive: true });
  await writeFile(path.join(proj, 'AGENTS.md'), 'rules\n');
  await writeFile(path.join(proj, 'docs', 'a.txt'), 'doc\n');
  await writeFile(path.join(f.dataDir, 'weft.sqlite'), 'DB');
  await writeFile(path.join(f.dataDir, 'providers.json'), 'KEYS');
  const env = await createWorkspaceEnv({ cwd: proj, dataDir: f.dataDir });
  t.after(() => env.cleanup(BACKGROUND_CONTEXT).catch(() => {}));
  const api = { ...f.api, env };
  const info = await env.fileInfo('AGENTS.md', BACKGROUND_CONTEXT);
  assert.equal(info.ok, true);
  assert.equal((await env.readBinaryFile('AGENTS.md', BACKGROUND_CONTEXT)).ok, true);
  assert.match(text(await run('read', { path: 'docs/a.txt' }, api)), /doc/);
  assert.match(text(await run('ls', { path: '.' }, api)), /AGENTS\.md/);
  for (const p of ['../weft.sqlite', '../providers.json', path.join(f.dataDir, 'weft.sqlite')]) {
    await assert.rejects(run('read', { path: p }, api), /E_SENSITIVE/, p);
  }
  assert.equal((await env.fileInfo('../weft.sqlite', BACKGROUND_CONTEXT)).ok, false);
});

test('data directory rule: workspace root inside it is exempt only for its own files', () => {
  const opt = { platform: 'linux', homes: [], dataDirs: ['/d'], root: '/d/proj' };
  assert.equal(sensitiveRule('/d/proj/AGENTS.md', opt), '');
  assert.ok(sensitiveRule('/d/weft.sqlite', opt));
  assert.ok(sensitiveRule('/d/proj2/x', opt));
  // the data directory itself, or a parent of it, as workspace gives no exemption
  assert.ok(sensitiveRule('/d/weft.sqlite', { ...opt, root: '/d' }));
  assert.ok(sensitiveRule('/d/weft.sqlite', { ...opt, root: '/' }));
  // home credentials stay refused even inside a home workspace
  assert.ok(sensitiveRule('/h/.ssh/id', { platform: 'linux', homes: ['/h'], dataDirs: [], root: '/h' }));
});
