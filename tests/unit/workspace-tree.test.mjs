import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { runWorkspaceTreeGit } from '../../src/core/workspace-tree.mjs';
import { fileNodeView, workspaceTreeView } from '../../src/v2/views/files.ts';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const execFileP = promisify(execFile);
const TOKEN = 'tree-ignored-token';

function assertChecked(apiPath, method, status, body) {
  const checked = validateResponse(apiPath, method, status, body);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
}

function assertNoIgnored(entries) {
  for (const entry of entries) {
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'ignored'), false, entry.path);
  }
}

async function git(cwd, args) {
  await execFileP('git', args, { cwd, windowsHide: true, timeout: 20_000 });
}

async function isolatedEnv() {
  const dir = await mkdtemp(path.join(tmpdir(), 'piw-tree-gitconfig-'));
  const empty = path.join(dir, 'empty-gitconfig');
  await writeFile(empty, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

async function writeMany(dir, count, prefix) {
  await mkdir(dir, { recursive: true });
  const batch = 80;
  for (let i = 0; i < count; i += batch) {
    const jobs = [];
    for (let j = i; j < Math.min(count, i + batch); j += 1) {
      const name = `${prefix}${String(j).padStart(4, '0')}.txt`;
      jobs.push(writeFile(path.join(dir, name), 'x'));
    }
    await Promise.all(jobs);
  }
}

test('fileNodeView includes ignored only when true', () => {
  assert.deepEqual(fileNodeView({ path: 'a\\b', type: 'file', ignored: true }), {
    path: 'a/b',
    type: 'file',
    ignored: true,
  });
  assert.deepEqual(fileNodeView({ path: 'dir', type: 'dir' }), { path: 'dir', type: 'dir' });
  assert.deepEqual(fileNodeView({ path: 'dir', type: 'dir', ignored: false }), { path: 'dir', type: 'dir' });
});

test('non-git tree has no ignored field', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-tree-nogit-'));
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'dist/\n');
  await writeFile(path.join(root, 'dist', 'a.js'), 'x');
  await writeFile(path.join(root, 'keep.txt'), 'x');
  const env = await isolatedEnv();
  const tree = await workspaceTreeView(root, { env });
  assert.equal(tree.truncated, false);
  assert.equal(tree.entries.some((entry) => entry.path === 'keep.txt'), true);
  assert.equal(tree.entries.some((entry) => entry.path === 'dist/a.js'), true);
  assertNoIgnored(tree.entries);
});

test('missing git does not throw and leaves ignored unset', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-tree-nogitbin-'));
  await git(root, ['init']);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'dist/\n*.log\n');
  await writeFile(path.join(root, 'dist', 'a.js'), 'x');
  await writeFile(path.join(root, 'keep.txt'), 'x');
  await writeFile(path.join(root, 'notes.log'), 'x');
  const env = await isolatedEnv();
  env.WEFT_GIT_BIN = path.join(root, 'missing-git-binary');
  const tree = await workspaceTreeView(root, { env });
  assert.equal(tree.entries.some((entry) => entry.path === 'keep.txt'), true);
  assert.equal(tree.entries.some((entry) => entry.path === 'dist/a.js'), true);
  assert.equal(tree.entries.some((entry) => entry.path === 'notes.log'), true);
  assertNoIgnored(tree.entries);
});

test('ls-files marks ignored files and does not walk ignored directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-tree-ignore-'));
  await git(root, ['init']);
  await mkdir(path.join(root, 'dist', 'nested'), { recursive: true });
  await mkdir(path.join(root, 'build'), { recursive: true });
  await mkdir(path.join(root, 'src', 'sub'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'dist/\nbuild/\n*.log\n');
  await writeFile(path.join(root, 'dist', 'a.js'), 'x');
  await writeFile(path.join(root, 'dist', 'nested', 'b.js'), 'x');
  await writeFile(path.join(root, 'src', 'keep.ts'), 'x');
  await writeFile(path.join(root, 'src', 'debug.log'), 'x');
  await writeFile(path.join(root, 'src', 'sub', 'c.ts'), 'x');
  await writeFile(path.join(root, 'notes.log'), 'x');
  await writeFile(path.join(root, 'tracked.log'), 'x');
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  await git(root, ['add', '-f', 'tracked.log']);
  const env = await isolatedEnv();

  const tree = await workspaceTreeView(root, { env });
  const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
  assert.equal(tree.truncated, false);
  assert.equal(byPath.get('dist')?.type, 'dir');
  assert.equal(byPath.get('dist')?.ignored, true);
  assert.equal(byPath.get('build')?.ignored, true);
  assert.equal(byPath.get('notes.log')?.ignored, true);
  assert.equal(byPath.get('src/debug.log')?.ignored, true);
  assert.equal(byPath.has('src/keep.ts'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(byPath.get('src/keep.ts'), 'ignored'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(byPath.get('src'), 'ignored'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(byPath.get('tracked.log'), 'ignored'), false);
  assert.equal(tree.entries.some((entry) => entry.path.startsWith('dist/')), false);
  assert.equal(tree.entries.some((entry) => entry.path.startsWith('build/')), false);
  assert.equal(tree.entries.some((entry) => entry.path === 'node_modules' || entry.path.startsWith('node_modules/')), false);
  assert.equal(tree.entries.some((entry) => entry.path === '.git' || entry.path.startsWith('.git/')), false);

  const src = await workspaceTreeView(root, { env, dir: 'src' });
  assert.equal(src.truncated, false);
  assert.deepEqual(src.entries.map((entry) => entry.path).sort(), ['src/debug.log', 'src/keep.ts', 'src/sub']);
  assert.equal(src.entries.find((entry) => entry.path === 'src/debug.log')?.ignored, true);
  assert.equal(src.entries.some((entry) => entry.path === 'src/sub/c.ts'), false);

  const dot = await workspaceTreeView(root, { env, dir: '.' });
  assert.equal(dot.entries.some((entry) => entry.path === 'src'), true);
  assert.equal(dot.entries.some((entry) => entry.path === 'src/keep.ts'), false);

  const modules = await workspaceTreeView(root, { env, dir: 'node_modules' });
  assert.deepEqual(modules.entries.map((entry) => entry.path), ['node_modules/pkg']);
  const pkg = await workspaceTreeView(root, { env, dir: 'node_modules/pkg' });
  assert.equal(pkg.entries.some((entry) => entry.path === 'node_modules/pkg/index.js' && entry.type === 'file'), true);

  await assert.rejects(
    () => workspaceTreeView(root, { env, dir: '../outside' }),
    (err) => err.code === 'E_SANDBOX',
  );
  await assert.rejects(
    () => workspaceTreeView(root, { env, dir: 'missing-dir' }),
    (err) => err.code === 'ENOENT',
  );
  await assert.rejects(
    () => workspaceTreeView(root, { env, dir: 'notes.log' }),
    (err) => err.code === 'ENOTDIR',
  );
  await assert.rejects(
    () => workspaceTreeView(root, { env, dir: '.git' }),
    (err) => err.code === 'E_NOT_READABLE',
  );
  await assert.rejects(
    () => workspaceTreeView(root, { env, dir: '.git/objects' }),
    (err) => err.code === 'E_NOT_READABLE',
  );
  await assert.rejects(
    () => workspaceTreeView(root, { env, dir: 'src/.git' }),
    (err) => err.code === 'E_NOT_READABLE',
  );
});

test('ignored directories do not consume the 500 entry budget', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-tree-budget-'));
  await git(root, ['init']);
  await writeFile(path.join(root, '.gitignore'), 'dist/\n');
  await writeMany(path.join(root, 'dist'), 600, 'd');
  await writeMany(root, 499, 'k');
  const env = await isolatedEnv();
  const tree = await workspaceTreeView(root, { env });
  const paths = new Set(tree.entries.map((entry) => entry.path));
  for (let i = 0; i < 499; i += 1) {
    assert.equal(paths.has(`k${String(i).padStart(4, '0')}.txt`), true);
  }
  assert.equal(paths.has('.gitignore'), true);
  assert.equal(paths.has('dist'), true);
  assert.equal(tree.entries.find((entry) => entry.path === 'dist')?.ignored, true);
  assert.equal(tree.entries.some((entry) => entry.path.startsWith('dist/')), false);
  assert.equal(tree.entries.length, 501);
  assert.equal(tree.truncated, true);

  const inside = await workspaceTreeView(root, { env, dir: 'dist' });
  assert.equal(inside.truncated, false);
  assert.equal(inside.entries.length, 600);
  assert.equal(inside.entries.every((entry) => entry.ignored === true && entry.type === 'file'), true);
});

test('one tree request runs git once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-tree-once-'));
  await git(root, ['init']);
  await mkdir(path.join(root, 'src', 'sub'), { recursive: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'dist/\n*.log\n');
  await writeFile(path.join(root, 'src', 'keep.ts'), 'x');
  await writeFile(path.join(root, 'src', 'sub', 'c.ts'), 'x');
  await writeFile(path.join(root, 'src', 'debug.log'), 'x');
  await writeFile(path.join(root, 'dist', 'a.js'), 'x');
  await writeFile(path.join(root, 'notes.log'), 'x');
  const env = await isolatedEnv();
  const calls = [];
  const runGit = async (args, opts) => {
    calls.push(args);
    return runWorkspaceTreeGit(args, opts);
  };

  const tree = await workspaceTreeView(root, { env, runGit });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  assert.equal(tree.entries.find((entry) => entry.path === 'dist')?.ignored, true);
  assert.equal(tree.entries.find((entry) => entry.path === 'notes.log')?.ignored, true);
  assert.equal(tree.entries.some((entry) => entry.path === 'src/sub/c.ts'), true);
  assert.equal(tree.entries.some((entry) => entry.path.startsWith('dist/')), false);

  const again = await workspaceTreeView(root, { env, dir: 'src', runGit });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(again.entries.find((entry) => entry.path === 'src/debug.log')?.ignored, true);
  assert.equal(again.truncated, false);
});

test('dir listing stops at 2000 entries', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-tree-dirmax-'));
  const many = path.join(root, 'many');
  await writeMany(many, 2000, 'f');
  const env = await isolatedEnv();
  const full = await workspaceTreeView(root, { env, dir: 'many' });
  assert.equal(full.truncated, false);
  assert.equal(full.entries.length, 2000);
  assert.equal(full.entries.some((entry) => entry.path === 'many/f0000.txt'), true);
  assert.equal(full.entries.some((entry) => entry.path === 'many/f1999.txt'), true);

  await writeFile(path.join(many, 'f2000.txt'), 'x');
  const over = await workspaceTreeView(root, { env, dir: 'many' });
  assert.equal(over.truncated, true);
  assert.equal(over.entries.length, 2000);
  assert.equal(over.entries.some((entry) => entry.path === 'many/f2000.txt'), false);
  assert.equal(over.entries.some((entry) => entry.path === 'many/f1999.txt'), true);
});

test('GET /api/v2/workspaces/{id}/tree dir parameter', { timeout: 40_000 }, async () => {
  const gitconfig = await isolatedEnv();
  const srv = await startServer({
    token: TOKEN,
    env: {
      WEFT_LLM: 'faux',
      GIT_CONFIG_GLOBAL: gitconfig.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: gitconfig.GIT_CONFIG_SYSTEM,
    },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'tree-ignored' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const wid = ws.body.id;
    const root = ws.body.path;
    await git(root, ['init']);
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), 'dist/\n*.log\n');
    await writeFile(path.join(root, 'dist', 'a.js'), 'x');
    await writeFile(path.join(root, 'src', 'app.js'), 'ok\n');
    await writeFile(path.join(root, 'notes.log'), 'x');
    await writeFile(path.join(root, 'readme.txt'), 'hi\n');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    await writeFile(path.join(root, '..', 'secret.txt'), 'outside\n');

    const headers = { authorization: `Bearer ${discovery.token}` };
    const get = async (apiPath) => {
      const res = await fetch(srv.base + apiPath, { headers });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status: res.status, body, text, headers: res.headers };
    };

    const tree = await get(`/api/v2/workspaces/${wid}/tree`);
    assert.equal(tree.status, 200, tree.text);
    assert.equal(tree.headers.get('weft-protocol'), PROTOCOL_VERSION);
    assertChecked(`/api/v2/workspaces/${wid}/tree`, 'GET', 200, tree.body);
    assert.equal(tree.body.entries.find((entry) => entry.path === 'dist')?.ignored, true);
    assert.equal(tree.body.entries.find((entry) => entry.path === 'notes.log')?.ignored, true);
    assert.equal(tree.body.entries.some((entry) => entry.path === 'dist/a.js'), false);
    assert.equal(tree.body.entries.some((entry) => entry.path.startsWith('node_modules')), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        tree.body.entries.find((entry) => entry.path === 'src/app.js'),
        'ignored',
      ),
      false,
    );

    const src = await get(`/api/v2/workspaces/${wid}/tree?dir=${encodeURIComponent('src')}`);
    assert.equal(src.status, 200, src.text);
    assertChecked(`/api/v2/workspaces/${wid}/tree`, 'GET', 200, src.body);
    assert.deepEqual(src.body.entries.map((entry) => entry.path), ['src/app.js']);

    const modules = await get(`/api/v2/workspaces/${wid}/tree?dir=${encodeURIComponent('node_modules')}`);
    assert.equal(modules.status, 200, modules.text);
    assert.equal(modules.body.entries.some((entry) => entry.path === 'node_modules/pkg'), true);

    const outside = await get(`/api/v2/workspaces/${wid}/tree?dir=${encodeURIComponent('../secret.txt')}`);
    assert.equal(outside.status, 403, outside.text);
    assert.equal(outside.body.code, 'E_SANDBOX');
    assertChecked(`/api/v2/workspaces/${wid}/tree`, 'GET', 403, outside.body);

    const missing = await get(`/api/v2/workspaces/${wid}/tree?dir=${encodeURIComponent('missing-dir')}`);
    assert.equal(missing.status, 404, missing.text);
    assertChecked(`/api/v2/workspaces/${wid}/tree`, 'GET', 404, missing.body);

    const file = await get(`/api/v2/workspaces/${wid}/tree?dir=${encodeURIComponent('readme.txt')}`);
    assert.equal(file.status, 400, file.text);
    assert.equal(file.body.code, 'E_BAD_REQUEST');
    assertChecked(`/api/v2/workspaces/${wid}/tree`, 'GET', 400, file.body);

    const gitDir = await get(`/api/v2/workspaces/${wid}/tree?dir=${encodeURIComponent('.git')}`);
    assert.equal(gitDir.status, 403, gitDir.text);
    assert.equal(gitDir.body.code, 'E_NOT_READABLE');
    assertChecked(`/api/v2/workspaces/${wid}/tree`, 'GET', 403, gitDir.body);

    const gitNested = await get(`/api/v2/workspaces/${wid}/tree?dir=${encodeURIComponent('src/.git')}`);
    assert.equal(gitNested.status, 403, gitNested.text);
    assert.equal(gitNested.body.code, 'E_NOT_READABLE');
  } finally {
    await stopServer(srv);
  }
});
