import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import {
  appendOutsideChanges,
  captureWorktree,
  decorateGitChanges,
  indexFileFor,
  listWorktreeChanges,
  parseNameStatusZ,
  parseNumstatZ,
  readTreeBlob,
} from '../../src/kernel/workspace-snapshot.mjs';
import { withHarnessLock } from './_harness-lock.mjs';

const execFileP = promisify(execFile);
const FILE_CAP = 1024 * 1024;

async function git(repo, args, encoding = 'utf8') {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd: repo,
      encoding,
      windowsHide: true,
      maxBuffer: 8_000_000,
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout || '' };
  }
}

async function gitState(repo) {
  const status = await git(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const stash = await git(repo, ['stash', 'list']);
  const index = await readFile(path.join(repo, '.git', 'index'));
  return {
    status: String(status.stdout),
    head: String(head.stdout).trim(),
    stash: String(stash.stdout),
    indexHash: createHash('sha256').update(index).digest('hex'),
  };
}

async function initRepo(root) {
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 't96@example.com']);
  await git(repo, ['config', 'user.name', 't96']);
  await writeFile(path.join(repo, 'B.txt'), 'B0\n');
  await writeFile(path.join(repo, 'D.txt'), 'D0\n');
  await writeFile(path.join(repo, 'E.txt'), 'E0\n');
  await writeFile(path.join(repo, 'A.txt'), 'A0\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'init']);
  await writeFile(path.join(repo, 'A.txt'), 'A1 dirty before session\n');
  return repo;
}

function byPath(rows) {
  return new Map(rows.map((row) => [row.path, row]));
}

test('name-status and numstat -z parsers keep rename paths', () => {
  const names = parseNameStatusZ(Buffer.from('M\0B.txt\0A\0C.txt\0D\0D.txt\0R100\0E.txt\0F.txt\0', 'utf8'));
  assert.deepEqual(names.map((row) => [row.status, row.oldPath, row.path]), [
    ['M', null, 'B.txt'],
    ['A', null, 'C.txt'],
    ['D', null, 'D.txt'],
    ['R100', 'E.txt', 'F.txt'],
  ]);
  const stats = parseNumstatZ(Buffer.from('2\t1\tB.txt\0' + '1\t0\tC.txt\0' + '0\t1\tD.txt\0' + '0\t0\t\0E.txt\0F.txt\0', 'utf8'));
  assert.equal(stats[3].path, 'F.txt');
  assert.equal(stats[3].oldPath, 'E.txt');
  assert.equal(stats[3].addedRaw, '0');
  assert.equal(stats[0].path, 'B.txt');
  assert.equal(stats[0].oldPath, null);
});

test('capture and diff see session changes and leave git metadata alone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'weft-snap-'));
  try {
    const repo = await initRepo(root);
    const indexFile = indexFileFor(root, 'conv-1', repo);
    const before = await gitState(repo);
    const indexBeforeTools = await readFile(path.join(repo, '.git', 'index'));
    const captured = await captureWorktree({ cwd: repo, indexFile });
    assert.equal(captured.mode, 'git');
    assert.match(captured.tree, /^[0-9a-f]{40}$/);
    const indexAfterCapture = await readFile(path.join(repo, '.git', 'index'));
    assert.equal(
      createHash('sha256').update(indexAfterCapture).digest('hex'),
      createHash('sha256').update(indexBeforeTools).digest('hex'),
    );

    await writeFile(path.join(repo, 'B.txt'), 'B1\n');
    await writeFile(path.join(repo, 'C.txt'), 'C1\n');
    await rm(path.join(repo, 'D.txt'));
    const moved = await git(repo, ['mv', 'E.txt', 'F.txt']);
    assert.equal(moved.code, 0, moved.stdout);
    await writeFile(path.join(repo, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    await writeFile(path.join(repo, 'big.txt'), Buffer.alloc(FILE_CAP + 1, 0x61));

    const afterMutations = await gitState(repo);
    const indexDuringDiff = createHash('sha256').update(await readFile(path.join(repo, '.git', 'index'))).digest('hex');
    const entries = await listWorktreeChanges({ cwd: repo, indexFile, baseTree: captured.tree });
    const indexAfterDiff = createHash('sha256').update(await readFile(path.join(repo, '.git', 'index'))).digest('hex');
    assert.equal(indexAfterDiff, indexDuringDiff);
    const statusAfter = String((await git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout);
    const headAfter = String((await git(repo, ['rev-parse', 'HEAD'])).stdout).trim();
    const stashAfter = String((await git(repo, ['stash', 'list'])).stdout);
    assert.equal(statusAfter, afterMutations.status);
    assert.equal(headAfter, before.head);
    assert.equal(stashAfter, before.stash);

    const rows = byPath(decorateGitChanges(entries, [
      { path: 'G.txt', by: { kind: 'main' }, toolCallId: 'call-g' },
    ]));
    assert.equal(rows.has('A.txt'), false, JSON.stringify([...rows.keys()]));
    assert.equal(rows.get('B.txt').status, 'modified');
    assert.equal(rows.get('B.txt').by, null);
    assert.equal(rows.get('C.txt').status, 'added');
    assert.equal(rows.get('D.txt').status, 'deleted');
    assert.equal(rows.get('F.txt').status, 'renamed');
    assert.equal(rows.get('F.txt').oldPath, 'E.txt');
    assert.equal(rows.has('E.txt'), false);
    assert.equal(rows.get('bin.dat').error, '文件过大');
    assert.equal(rows.get('big.txt').error, '文件过大');

    const blobB = await readTreeBlob({ cwd: repo, tree: captured.tree, rel: 'B.txt' });
    assert.equal(blobB.text, 'B0\n');
    const missingC = await readTreeBlob({ cwd: repo, tree: captured.tree, rel: 'C.txt' });
    assert.equal(missingC.missing, true);
    const outside = appendOutsideChanges([...rows.values()], [
      { path: '/tmp/outside.txt', added: 1, removed: 0, by: { kind: 'main' } },
      { path: 'B.txt', added: 9, removed: 9, by: { kind: 'main' } },
    ]);
    assert.equal(outside.some((row) => row.path === '/tmp/outside.txt'), true);
    assert.equal(outside.filter((row) => row.path === 'B.txt').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing git binary falls back without touching the index', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'weft-snap-nogit-'));
  try {
    const repo = await initRepo(root);
    const before = createHash('sha256').update(await readFile(path.join(repo, '.git', 'index'))).digest('hex');
    const captured = await captureWorktree({
      cwd: repo,
      indexFile: indexFileFor(root, 'nogit', repo),
      env: { ...process.env, WEFT_GIT_BIN: path.join(root, 'missing-git') },
    });
    assert.deepEqual(captured, { mode: 'fallback', tree: '' });
    const after = createHash('sha256').update(await readFile(path.join(repo, '.git', 'index'))).digest('hex');
    assert.equal(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a directory that is not a git repo falls back', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'weft-snap-plain-'));
  try {
    const captured = await captureWorktree({
      cwd: root,
      indexFile: indexFileFor(root, 'plain', root),
    });
    assert.deepEqual(captured, { mode: 'fallback', tree: '' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitDone(kernel, store, conv) {
  const started = Date.now();
  let presented;
  while (Date.now() - started < 20_000) {
    const fresh = await store.getConversation(conv.id);
    presented = await kernel.present(fresh);
    if (presented.status === 'done' || presented.status === 'failed') return presented;
    await sleep(40);
  }
  throw new Error(`conversation did not finish: ${JSON.stringify(presented)}`);
}

test('changes() uses the session snapshot and does not touch HEAD, stash, or the index', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'weft-snap-kernel-'));
    const dataDir = path.join(root, 'data');
    await mkdir(dataDir);
    const repo = await initRepo(root);
    const script = path.join(dataDir, 'script.json');
    await writeFile(script, JSON.stringify({
      turns: [
        { tool: 'write', args: { path: 'G.txt', content: 'from-write\n' } },
        { text: 'done' },
      ],
    }));
    const store = createSqliteStore(dataDir);
    const kernel = await openConversationKernel({
      dataDir,
      store,
      demo: true,
      env: { ...process.env, WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script },
    });
    try {
      const ws = await store.createWorkspace({
        name: 'snap',
        path: repo,
        source: 'local',
        rootPath: repo,
      });
      const before = await gitState(repo);
      const indexAtStart = before.indexHash;
      const conv = await kernel.createConversation({
        workspaceId: ws.id,
        workspacePath: repo,
        title: 'snap',
      });
      const posted = await kernel.postMessage(conv, 'go');
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      const done = await waitDone(kernel, store, conv);
      assert.equal(done.status, 'done', JSON.stringify(done));
      const indexAfterTurn = createHash('sha256').update(await readFile(path.join(repo, '.git', 'index'))).digest('hex');
      assert.equal(indexAfterTurn, indexAtStart);
      const headAfterTurn = String((await git(repo, ['rev-parse', 'HEAD'])).stdout).trim();
      const stashAfterTurn = String((await git(repo, ['stash', 'list'])).stdout);
      assert.equal(headAfterTurn, before.head);
      assert.equal(stashAfterTurn, before.stash);

      await writeFile(path.join(repo, 'B.txt'), 'B1\n');
      await writeFile(path.join(repo, 'C.txt'), 'C1\n');
      await rm(path.join(repo, 'D.txt'));
      const moved = await git(repo, ['mv', 'E.txt', 'F.txt']);
      assert.equal(moved.code, 0, moved.stdout);
      const afterMutations = await gitState(repo);
      const indexDuring = createHash('sha256').update(await readFile(path.join(repo, '.git', 'index'))).digest('hex');
      const rows = byPath(await kernel.changes(conv.id));
      assert.deepEqual([...rows.keys()].sort(), ['B.txt', 'C.txt', 'D.txt', 'F.txt', 'G.txt']);
      assert.equal(rows.get('B.txt').status, 'modified');
      assert.equal(rows.get('B.txt').by, null);
      assert.equal(rows.get('C.txt').status, 'added');
      assert.equal(rows.get('C.txt').by, null);
      assert.equal(rows.get('D.txt').status, 'deleted');
      assert.equal(rows.get('F.txt').status, 'renamed');
      assert.equal(rows.get('F.txt').oldPath, 'E.txt');
      assert.equal(rows.has('A.txt'), false);
      assert.deepEqual(rows.get('G.txt').by, { kind: 'main' });

      const diffB = await kernel.diff(conv.id, 'B.txt');
      assert.equal(diffB.status, 200);
      assert.equal(diffB.body.before, 'B0\n');
      assert.equal(diffB.body.after, 'B1\n');
      const diffC = await kernel.diff(conv.id, 'C.txt');
      assert.equal(diffC.body.before, '');
      assert.equal(diffC.body.after, 'C1\n');
      const diffD = await kernel.diff(conv.id, 'D.txt');
      assert.equal(diffD.body.before, 'D0\n');
      assert.equal(diffD.body.after, '');
      const diffF = await kernel.diff(conv.id, 'F.txt');
      assert.equal(diffF.body.before, 'E0\n');
      assert.equal(diffF.body.after, 'E0\n');
      const missing = await kernel.diff(conv.id, 'A.txt');
      assert.equal(missing.status, 404);

      const indexAfter = createHash('sha256').update(await readFile(path.join(repo, '.git', 'index'))).digest('hex');
      assert.equal(indexAfter, indexDuring);
      const statusAfter = String((await git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout);
      const headAfter = String((await git(repo, ['rev-parse', 'HEAD'])).stdout).trim();
      const stashAfter = String((await git(repo, ['stash', 'list'])).stdout);
      assert.equal(statusAfter, afterMutations.status);
      assert.equal(headAfter, before.head);
      assert.equal(stashAfter, before.stash);
    } finally {
      await kernel.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('a non-git workspace keeps the write/edit changes list', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'weft-snap-fallback-'));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'ws');
    await mkdir(dataDir);
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'A.txt'), 'pre-existing\n');
    const script = path.join(dataDir, 'script.json');
    await writeFile(script, JSON.stringify({
      turns: [
        { tool: 'write', args: { path: 'G.txt', content: 'from-write\n' } },
        { text: 'done' },
      ],
    }));
    const store = createSqliteStore(dataDir);
    const kernel = await openConversationKernel({
      dataDir,
      store,
      demo: true,
      env: { ...process.env, WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script },
    });
    try {
      const ws = await store.createWorkspace({
        name: 'plain',
        path: workspace,
        source: 'local',
        rootPath: workspace,
      });
      const conv = await kernel.createConversation({
        workspaceId: ws.id,
        workspacePath: workspace,
        title: 'plain',
      });
      const posted = await kernel.postMessage(conv, 'go');
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      const done = await waitDone(kernel, store, conv);
      assert.equal(done.status, 'done', JSON.stringify(done));
      await writeFile(path.join(workspace, 'B.txt'), 'from-shell\n');
      const rows = await kernel.changes(conv.id);
      assert.deepEqual(rows.map((row) => row.path), ['G.txt']);
      assert.equal(rows[0].status, undefined);
      assert.equal(Object.hasOwn(rows[0], 'oldPath'), false);
      assert.deepEqual(rows[0].by, { kind: 'main' });
      const diff = await kernel.diff(conv.id, 'G.txt');
      assert.equal(diff.status, 200);
      assert.equal(diff.body.before, '');
      assert.equal(diff.body.after, 'from-write\n');
      const shell = await kernel.diff(conv.id, 'B.txt');
      assert.equal(shell.status, 404);
    } finally {
      await kernel.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
