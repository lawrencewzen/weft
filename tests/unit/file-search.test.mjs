import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInWorkspace } from '../../src/core/paths.mjs';
import { listWorkspaceTree } from '../../src/core/workspace-tree.mjs';
import {
  createFileSearchState,
  FILE_SEARCH_CACHE_MS,
  FILE_SEARCH_GIT_TIMEOUT_MS,
  FILE_SEARCH_MAX_FILES,
  listWorkspaceFiles,
  normalizeWorkspaceRel,
} from '../../src/core/workspace-file-search.mjs';
import { searchWorkspaceFiles } from '../../src/v2/views/file-search.ts';
import {
  FILE_SEARCH_DEFAULT_LIMIT,
  FILE_SEARCH_MAX_LIMIT,
  parseFileSearchLimit,
  rankFileMatches,
  scorePath,
} from '../../src/v2/views/file-search-match.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const execFileP = promisify(execFile);
const TOKEN = 'file-search-token';

function state() {
  return createFileSearchState();
}

async function git(args, cwd) {
  await execFileP('git', args, { cwd, windowsHide: true, timeout: 20_000 });
}

async function initRepo(root) {
  await git(['init', '-b', 'main'], root);
  await git(['config', 'core.excludesFile', '/dev/null'], root);
}

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function getV2(base, apiPath, token) {
  const res = await fetch(base + apiPath, { headers: token ? v2Headers(token) : {} });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text, headers: res.headers };
}

function assertChecked(apiPath, method, status, body) {
  const checked = validateResponse(apiPath, method, status, body);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
}

async function assertInside(root, entries) {
  const rootReal = await realpath(root);
  for (const entry of entries) {
    assert.equal(entry.path.includes('\\'), false, entry.path);
    assert.equal(entry.path.split('/').includes('..'), false, entry.path);
    assert.equal(path.isAbsolute(entry.path), false, entry.path);
    const abs = await resolveInWorkspace(root, entry.path);
    const rel = path.relative(rootReal, abs);
    assert.ok(rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), entry.path);
    const st = await lstat(abs);
    assert.equal(st.isFile(), true, entry.path);
  }
}

test('scorePath ranks filename, prefix, and consecutive hits, then shorter paths', () => {
  const paths = ['ab.ts', 'ABC.TXT', 'src/ab.ts', 'a-b.ts', 'xab.ts', 'a/b.ts', 'my-app/a/b.ts', 'readme.md'];
  const ranked = rankFileMatches(paths, 'ab', 50);
  assert.deepEqual(ranked.map((hit) => hit.path), [
    'ab.ts',
    'ABC.TXT',
    'src/ab.ts',
    'a-b.ts',
    'xab.ts',
    'a/b.ts',
    'my-app/a/b.ts',
  ]);
  assert.equal(scorePath('ab.ts', 'AB'), scorePath('src/ab.ts', 'ab'));
  assert.equal(scorePath('ReadMe.md', 'readme'), scorePath('readme.md', 'README'));
  assert.ok(scorePath('ab.ts', 'ab') > scorePath('a-b.ts', 'ab'));
  assert.ok(scorePath('a-b.ts', 'ab') > scorePath('xab.ts', 'ab'));
  assert.ok(scorePath('xab.ts', 'ab') > scorePath('a/b.ts', 'ab'));
  assert.equal(scorePath('nope.ts', 'zzz'), null);
  assert.equal(scorePath('ab.ts', ''), null);
  for (const hit of ranked) assert.equal(Number.isInteger(hit.score), true);
});

test('Chinese filenames match as subsequences and prefer the filename', () => {
  const ranked = rankFileMatches([
    'docs/说明.md',
    '说明.txt',
    '说-明.txt',
    '文档/其他.txt',
  ], '说明', 10);
  assert.deepEqual(ranked.map((hit) => hit.path), ['说明.txt', 'docs/说明.md', '说-明.txt']);
  assert.equal(scorePath('说明.txt', '说明'), scorePath('docs/说明.md', '说明'));
  assert.ok(scorePath('说明.txt', '说明') > scorePath('说-明.txt', '说明'));
  assert.equal(scorePath('文档/其他.txt', '说明'), null);
  assert.equal(rankFileMatches(['文档/说明.md'], '文档', 10)[0].path, '文档/说明.md');
});

test('empty query, limit default 50, and limit clamped to 200', () => {
  assert.equal(FILE_SEARCH_DEFAULT_LIMIT, 50);
  assert.equal(FILE_SEARCH_MAX_LIMIT, 200);
  assert.deepEqual(rankFileMatches(['a.txt'], '', 10), []);
  assert.deepEqual(rankFileMatches(['a.txt'], '', undefined), []);
  const paths = Array.from({ length: 250 }, (_, i) => `n${String(i).padStart(3, '0')}.txt`);
  assert.equal(rankFileMatches(paths, 'n').length, 50);
  assert.equal(rankFileMatches(paths, 'n', 3).length, 3);
  assert.equal(rankFileMatches(paths, 'n', 1000).length, 200);
  assert.equal(rankFileMatches(paths, 'n', 0).length, 50);
  assert.equal(rankFileMatches(paths, 'n', -5).length, 50);
  assert.equal(rankFileMatches(paths, 'n', 'foo').length, 50);
  assert.equal(rankFileMatches(paths, 'n', '12').length, 12);
  assert.equal(parseFileSearchLimit(null), 50);
  assert.equal(parseFileSearchLimit('200'), 200);
  const top = rankFileMatches(paths, 'n', 1);
  assert.deepEqual(top.map((hit) => hit.path), ['n000.txt']);
});

test('normalizeWorkspaceRel rejects paths that leave the workspace', () => {
  assert.equal(normalizeWorkspaceRel('../secret.txt'), null);
  assert.equal(normalizeWorkspaceRel('/etc/passwd'), null);
  assert.equal(normalizeWorkspaceRel('C:/windows/notepad.exe'), null);
  assert.equal(normalizeWorkspaceRel('a/../../b'), null);
  assert.equal(normalizeWorkspaceRel('a/../b'), 'b');
  assert.equal(normalizeWorkspaceRel('a//b'), 'a/b');
  assert.equal(normalizeWorkspaceRel('./a/b'), 'a/b');
  assert.equal(normalizeWorkspaceRel(''), null);
  assert.equal(normalizeWorkspaceRel('a\0b'), null);
});

test('empty query does not list files', async () => {
  let calls = 0;
  const found = await searchWorkspaceFiles('/does-not-need-to-exist', '', {
    state: state(),
    runGit: async () => {
      calls += 1;
      return { ok: false };
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(found, { entries: [], truncated: false });
});

test('cache expires by timestamp and shares one in-flight list', async () => {
  assert.equal(FILE_SEARCH_CACHE_MS, 2000);
  assert.equal(FILE_SEARCH_MAX_FILES, 200_000);
  assert.equal(FILE_SEARCH_GIT_TIMEOUT_MS, 5000);
  const root = await mkdtemp(path.join(tmpdir(), 'piw-search-cache-'));
  await writeFile(path.join(root, 'a.txt'), 'a');
  let calls = 0;
  let now = 1000;
  const shared = state();
  const runGit = async () => {
    calls += 1;
    return { ok: true, files: ['a.txt'], truncated: false };
  };
  const opts = { state: shared, now: () => now, runGit };
  const first = await searchWorkspaceFiles(root, 'a', opts);
  const second = await searchWorkspaceFiles(root, 'a', opts);
  assert.equal(calls, 1);
  assert.equal(first.entries[0].path, 'a.txt');
  assert.equal(second.entries[0].path, 'a.txt');
  now = 2999;
  await searchWorkspaceFiles(root, 'a', opts);
  assert.equal(calls, 1);
  now = 3000;
  await searchWorkspaceFiles(root, 'a', opts);
  assert.equal(calls, 2);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let inflightCalls = 0;
  const inflight = state();
  const slowGit = async () => {
    inflightCalls += 1;
    await gate;
    return { ok: true, files: ['a.txt'], truncated: false };
  };
  const pendingOpts = { state: inflight, runGit: slowGit };
  const left = searchWorkspaceFiles(root, 'a', pendingOpts);
  const right = searchWorkspaceFiles(root, 'a', pendingOpts);
  release();
  const both = await Promise.all([left, right]);
  assert.equal(inflightCalls, 1);
  assert.equal(both[0].entries[0].path, 'a.txt');
  assert.equal(both[1].entries[0].path, 'a.txt');
});

test('non-git workspace walks files and skips .git, node_modules, and outside symlinks', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'piw-search-walk-'));
  const root = path.join(parent, 'ws');
  const outside = path.join(parent, 'outside');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'src', 'keep.js'), 'k');
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'i');
  await writeFile(path.join(root, '.git', 'secret'), 's');
  await writeFile(path.join(outside, 'hidden.txt'), 'h');
  await writeFile(path.join(root, 'ok.txt'), 'o');
  await symlink(path.join(outside, 'hidden.txt'), path.join(root, 'escape.txt'));
  await symlink(outside, path.join(root, 'linked'));
  await symlink('ok.txt', path.join(root, 'alias.txt'));

  const keep = await searchWorkspaceFiles(root, 'keep', { state: state() });
  assert.deepEqual(keep.entries.map((entry) => entry.path), ['src/keep.js']);

  const found = await searchWorkspaceFiles(root, 't', { state: state() });
  const paths = found.entries.map((entry) => entry.path);
  assert.equal(found.truncated, false);
  assert.ok(paths.includes('ok.txt'));
  assert.ok(paths.includes('alias.txt'));
  assert.equal(paths.includes('escape.txt'), false);
  assert.equal(paths.includes('node_modules/pkg/index.js'), false);
  assert.equal(paths.some((item) => item.startsWith('.git')), false);
  assert.equal(paths.some((item) => item.includes('hidden.txt')), false);
  assert.equal((await searchWorkspaceFiles(root, 'index', { state: state() })).entries.length, 0);
  assert.equal((await searchWorkspaceFiles(root, 'secret', { state: state() })).entries.length, 0);
  await assertInside(root, found.entries);

  const capped = await listWorkspaceFiles(root, {
    state: state(),
    maxFiles: 2,
    runGit: async () => ({ ok: false }),
  });
  assert.equal(capped.truncated, true);
  assert.equal(capped.files.length, 2);
});

test('git missing or failing falls back to a directory walk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-search-fallback-'));
  await writeFile(path.join(root, 'wanted.js'), 'w');
  const missing = await searchWorkspaceFiles(root, 'wanted', {
    state: state(),
    env: { ...process.env, WEFT_GIT_BIN: path.join(root, 'missing-git-bin') },
  });
  assert.equal(missing.entries[0].path, 'wanted.js');

  const bin = path.join(root, 'slow-git.mjs');
  await writeFile(bin, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
  await chmod(bin, 0o755);
  const started = Date.now();
  const timed = await searchWorkspaceFiles(root, 'wanted', {
    state: state(),
    env: { ...process.env, WEFT_GIT_BIN: bin },
    gitTimeoutMs: 300,
  });
  assert.ok(Date.now() - started < 3000, `git timeout took ${Date.now() - started}ms`);
  assert.equal(timed.entries[0].path, 'wanted.js');
});

test('git list drops paths outside the workspace and honors the file cap', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'piw-search-bounds-'));
  const root = path.join(parent, 'ws');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'ok.txt'), 'o');
  await writeFile(path.join(parent, 'secret.txt'), 's');
  const found = await searchWorkspaceFiles(root, 't', {
    state: state(),
    runGit: async () => ({
      ok: true,
      files: ['../secret.txt', '/etc/passwd', 'C:/windows/notepad.exe', 'ok.txt', 'a/../../secret.txt'],
      truncated: false,
    }),
  });
  assert.deepEqual(found.entries.map((entry) => entry.path), ['ok.txt']);
  await assertInside(root, found.entries);

  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
    await writeFile(path.join(root, name), 'x');
  }
  await writeFile(path.join(root, 'z-only-walk.txt'), 'z');
  const bin = path.join(root, '0-git.mjs');
  await writeFile(bin, [
    '#!/usr/bin/env node',
    "import { writeSync } from 'node:fs';",
    "const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];",
    'writeSync(1, names.join(String.fromCharCode(0)) + String.fromCharCode(0));',
    '',
  ].join('\n'));
  await chmod(bin, 0o755);
  const capped = await listWorkspaceFiles(root, {
    state: state(),
    maxFiles: 2,
    env: { ...process.env, WEFT_GIT_BIN: bin },
  });
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.files, ['a.txt', 'b.txt']);
});

test('git repo hides gitignored files, shows untracked files, and stays inside a subdirectory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-search-git-'));
  await initRepo(root);
  await mkdir(path.join(root, 'ignored'), { recursive: true });
  await mkdir(path.join(root, '文档'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'secret.txt\nignored/\n');
  await writeFile(path.join(root, 'readme.txt'), 'r');
  await writeFile(path.join(root, 'secret.txt'), 's');
  await writeFile(path.join(root, 'fresh.txt'), 'f');
  await writeFile(path.join(root, 'ignored', 'nope.txt'), 'n');
  await writeFile(path.join(root, '说明.txt'), '说明');
  await writeFile(path.join(root, '文档', '说明.md'), '文档');
  await git(['add', 'readme.txt', '.gitignore', '说明.txt', '文档/说明.md'], root);

  const found = await searchWorkspaceFiles(root, 'txt', { state: state() });
  const paths = new Set(found.entries.map((entry) => entry.path));
  assert.equal(paths.has('readme.txt'), true);
  assert.equal(paths.has('fresh.txt'), true);
  assert.equal(paths.has('说明.txt'), true);
  assert.equal(paths.has('secret.txt'), false);
  assert.equal(paths.has('ignored/nope.txt'), false);
  await assertInside(root, found.entries);

  const chinese = await searchWorkspaceFiles(root, '说明', { state: state() });
  assert.deepEqual(chinese.entries.map((entry) => entry.path), ['说明.txt', '文档/说明.md']);

  const sub = path.join(root, '文档');
  const nested = await searchWorkspaceFiles(sub, '说明', { state: state() });
  assert.deepEqual(nested.entries.map((entry) => entry.path), ['说明.md']);
  assert.equal(nested.entries.some((entry) => entry.path.includes('说明.txt')), false);
});

test('git repo search finds a file past the tree cap and deeper than the tree', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-search-many-'));
  try {
    await initRepo(root);
    const writes = [];
    for (let i = 0; i <= 500; i += 1) {
      writes.push(writeFile(path.join(root, `n${String(i).padStart(3, '0')}.txt`), 'x'));
    }
    await Promise.all(writes);
    const deep = path.join(root, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9');
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, 'leaf.txt'), 'leaf');
    await git(['add', '-A'], root);

    const tree = await listWorkspaceTree(root);
    assert.equal(tree.some((entry) => entry.path === 'n500.txt'), false);
    assert.equal(tree.some((entry) => entry.path.endsWith('leaf.txt')), false);

    const last = await searchWorkspaceFiles(root, 'n500', { state: state() });
    assert.equal(last.truncated, false);
    assert.equal(last.entries[0].path, 'n500.txt');
    const leaf = await searchWorkspaceFiles(root, 'leaf', { state: state() });
    assert.equal(leaf.entries[0].path, 'd1/d2/d3/d4/d5/d6/d7/d8/d9/leaf.txt');
    await assertInside(root, [...last.entries, ...leaf.entries]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('git symlink to the outside is not searchable; an inside symlink is', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'piw-search-link-'));
  const root = path.join(parent, 'ws');
  const outside = path.join(parent, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'hidden.txt'), 'h');
  await writeFile(path.join(root, 'ok.txt'), 'o');
  await symlink(path.join(outside, 'hidden.txt'), path.join(root, 'escape.txt'));
  await symlink(outside, path.join(root, 'linked'));
  await symlink('ok.txt', path.join(root, 'alias.txt'));
  await initRepo(root);
  await git(['add', '-A'], root);

  const found = await searchWorkspaceFiles(root, 't', { state: state() });
  const paths = found.entries.map((entry) => entry.path);
  assert.ok(paths.includes('ok.txt'));
  assert.ok(paths.includes('alias.txt'));
  assert.equal(paths.includes('escape.txt'), false);
  assert.equal(paths.some((item) => item.includes('hidden')), false);
  await assertInside(root, found.entries);
});

test('GET /api/v2/workspaces/{id}/file-search: contract, empty q, limit, sandbox, auth', { timeout: 40_000 }, async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'file-search' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const wid = ws.body.id;
    const root = ws.body.path;
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app.js'), 'const a = 1;\n');
    await writeFile(path.join(root, '说明.txt'), '中文\n');
    await writeFile(path.join(root, 'beta.txt'), 'b\n');
    await writeFile(path.join(root, '..', 'secret.txt'), 'outside\n');
    await symlink(path.join(root, '..', 'secret.txt'), path.join(root, 'escape.txt'));

    const found = await getV2(
      srv.base,
      `/api/v2/workspaces/${wid}/file-search?q=${encodeURIComponent('说明')}`,
      discovery.token,
    );
    assert.equal(found.status, 200, found.text);
    assert.equal(found.headers.get('weft-protocol'), PROTOCOL_VERSION);
    assertChecked(`/api/v2/workspaces/${wid}/file-search`, 'GET', 200, found.body);
    assert.equal(found.body.truncated, false);
    assert.equal(found.body.entries[0].path, '说明.txt');
    assert.equal(Number.isInteger(found.body.entries[0].score), true);

    const app = await getV2(
      srv.base,
      `/api/v2/workspaces/${wid}/file-search?q=app`,
      discovery.token,
    );
    assert.equal(app.status, 200, app.text);
    assert.equal(app.body.entries.some((entry) => entry.path === 'src/app.js'), true);

    const empty = await getV2(srv.base, `/api/v2/workspaces/${wid}/file-search?q=`, discovery.token);
    assert.equal(empty.status, 200, empty.text);
    assertChecked(`/api/v2/workspaces/${wid}/file-search`, 'GET', 200, empty.body);
    assert.deepEqual(empty.body, { entries: [], truncated: false });

    const missingQ = await getV2(srv.base, `/api/v2/workspaces/${wid}/file-search`, discovery.token);
    assert.deepEqual(missingQ.body, { entries: [], truncated: false });

    const limited = await getV2(
      srv.base,
      `/api/v2/workspaces/${wid}/file-search?q=t&limit=1`,
      discovery.token,
    );
    assert.equal(limited.status, 200, limited.text);
    assert.equal(limited.body.entries.length, 1);

    const badLimit = await getV2(
      srv.base,
      `/api/v2/workspaces/${wid}/file-search?q=t&limit=9999`,
      discovery.token,
    );
    assert.equal(badLimit.status, 200, badLimit.text);
    assert.ok(badLimit.body.entries.length > 1);
    assert.ok(badLimit.body.entries.length <= 200);

    const escaped = await getV2(
      srv.base,
      `/api/v2/workspaces/${wid}/file-search?q=escape`,
      discovery.token,
    );
    assert.equal(escaped.body.entries.length, 0);
    const secret = await getV2(
      srv.base,
      `/api/v2/workspaces/${wid}/file-search?q=secret`,
      discovery.token,
    );
    assert.equal(secret.body.entries.some((entry) => entry.path.includes('..')), false);
    assert.equal(secret.body.entries.length, 0);

    const absent = await getV2(srv.base, '/api/v2/workspaces/missing/file-search?q=a', discovery.token);
    assert.equal(absent.status, 404, absent.text);
    assertChecked('/api/v2/workspaces/missing/file-search', 'GET', 404, absent.body);

    const unauth = await getV2(srv.base, `/api/v2/workspaces/${wid}/file-search?q=a`);
    assert.equal(unauth.status, 401);
    assertChecked(`/api/v2/workspaces/${wid}/file-search`, 'GET', 401, unauth.body);
  } finally {
    await stopServer(srv);
  }
});
