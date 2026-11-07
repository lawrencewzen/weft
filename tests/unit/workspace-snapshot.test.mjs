import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import iconv from 'iconv-lite';
import { liveDiff } from '../../src/core/diff.mjs';
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
  shouldRetryGitAdd,
} from '../../src/kernel/workspace-snapshot.mjs';
import { decodeWorkspaceBytes } from '../../src/kernel/workspace-text.mjs';
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

test('a timed-out git add is not retried', () => {
  assert.equal(shouldRetryGitAdd({ code: 1, killed: true }), false);
  assert.equal(shouldRetryGitAdd({ code: 124, killed: true, missing: false }), false);
  assert.equal(shouldRetryGitAdd({ code: 1, killed: false }), true);
  assert.equal(shouldRetryGitAdd({ code: 128 }), true);
  assert.equal(shouldRetryGitAdd({ code: 0, killed: false }), false);
  assert.equal(shouldRetryGitAdd(null), false);
});

test('decodeWorkspaceBytes keeps a UTF-8 BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\n', 'utf8')]);
  const text = decodeWorkspaceBytes(buf);
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.equal(text.slice(1), 'alpha\n');
});

test('GBK worktree diff keeps the changed line and has no U+FFFD', async () => {
  const prev = process.env.WEFT_TEXT_ENCODING_DETECT;
  process.env.WEFT_TEXT_ENCODING_DETECT = '1';
  const root = await mkdtemp(path.join(tmpdir(), 'weft-snap-gbk-'));
  try {
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 't99@example.com']);
    await git(repo, ['config', 'user.name', 't99']);
    const before = '第一行\n第二行保持\n第三行\n';
    const after = '第一行\n第二行改过\n第三行\n';
    await writeFile(path.join(repo, 'notes.py'), iconv.encode(before, 'gbk'));
    const added = await git(repo, ['add', '-A']);
    assert.equal(added.code, 0, added.stdout);
    const committed = await git(repo, ['commit', '-m', 'init']);
    assert.equal(committed.code, 0, committed.stdout);

    const indexFile = indexFileFor(root, 'gbk', repo);
    const captured = await captureWorktree({ cwd: repo, indexFile });
    assert.equal(captured.mode, 'git');
    await writeFile(path.join(repo, 'notes.py'), iconv.encode(after, 'gbk'));

    const entries = await listWorktreeChanges({ cwd: repo, indexFile, baseTree: captured.tree });
    const row = entries.find((item) => item.path === 'notes.py');
    assert.ok(row, JSON.stringify(entries.map((item) => item.path)));
    assert.equal(row.binary, false);
    assert.equal(row.added, 1);
    assert.equal(row.removed, 1);

    const blob = await readTreeBlob({ cwd: repo, tree: captured.tree, rel: 'notes.py' });
    const disk = decodeWorkspaceBytes(await readFile(path.join(repo, 'notes.py')));
    const diff = liveDiff({
      path: 'notes.py',
      before: blob.text,
      storedAfter: blob.text,
      diskText: disk,
    });
    assert.equal(blob.text, before);
    assert.equal(disk, after);
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert.match(diff.unified, /^-第二行保持/m);
    assert.match(diff.unified, /^\+第二行改过/m);
    assert.equal(`${blob.text}${disk}${diff.unified}`.includes('\uFFFD'), false);
  } finally {
    if (prev == null) delete process.env.WEFT_TEXT_ENCODING_DETECT;
    else process.env.WEFT_TEXT_ENCODING_DETECT = prev;
    await rm(root, { recursive: true, force: true });
  }
});

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

async function initGitRepo(root) {
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 't96@example.com']);
  await git(repo, ['config', 'user.name', 't96']);
  return repo;
}

test('an existing transcript stays on the write/edit list instead of snapshotting', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'weft-snap-legacy-'));
    const dataDir = path.join(root, 'data');
    await mkdir(dataDir);
    const repo = await initGitRepo(root);
    await writeFile(path.join(repo, 'note.txt'), 'base\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'init']);
    const script = path.join(dataDir, 'script.json');
    await writeFile(script, JSON.stringify({
      turns: [
        { tool: 'write', args: { path: 'note.txt', content: 'from-write\n' } },
        { text: 'later' },
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
        name: 'legacy',
        path: repo,
        source: 'local',
        rootPath: repo,
      });
      const conv = await kernel.createConversation({
        workspaceId: ws.id,
        workspacePath: repo,
        title: 'legacy',
      });
      const conversation = await kernel.harness.conversation(conv.harnessId, kernel.context);
      const submission = await conversation.submit({
        type: 'input',
        content: 'go',
        requestId: 'legacy-turn',
      }, kernel.context);
      const started = Date.now();
      let record;
      while (Date.now() - started < 20_000) {
        record = await submission.status(kernel.context);
        if (record?.status === 'done' || record?.status === 'unanswered') break;
        await sleep(40);
      }
      assert.equal(record?.status, 'done', JSON.stringify(record));
      await writeFile(path.join(repo, 'shell.txt'), 'from-shell\n');
      const posted = await kernel.postMessage(conv, 'next');
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      const rows = byPath(await kernel.changes(conv.id));
      assert.equal(rows.has('note.txt'), true, JSON.stringify([...rows.keys()]));
      assert.equal(rows.has('shell.txt'), false, JSON.stringify([...rows.keys()]));
      assert.equal(Object.hasOwn(rows.get('note.txt'), 'status'), false);
      assert.deepEqual(rows.get('note.txt').by, { kind: 'main' });
      const diff = await kernel.diff(conv.id, 'note.txt');
      assert.equal(diff.status, 200, JSON.stringify(diff.body));
      assert.equal(diff.body.before, 'base\n');
      assert.equal(diff.body.after, 'from-write\n');
    } finally {
      await kernel.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('a model-config entry before the first user message still snapshots', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'weft-snap-model-'));
    const dataDir = path.join(root, 'data');
    await mkdir(dataDir);
    const repo = await initGitRepo(root);
    await writeFile(path.join(repo, 'note.txt'), 'base\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'init']);
    const env = { ...process.env, WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ok' };
    delete env.WEFT_FAUX_SCRIPT;
    const store = createSqliteStore(dataDir);
    const kernel = await openConversationKernel({ dataDir, store, demo: true, env });
    try {
      const ws = await store.createWorkspace({
        name: 'model',
        path: repo,
        source: 'local',
        rootPath: repo,
      });
      const conv = await kernel.createConversation({
        workspaceId: ws.id,
        workspacePath: repo,
        title: 'model',
      });
      const conversation = await kernel.harness.conversation(conv.harnessId, kernel.context);
      await conversation.commit(async (tx) => {
        await tx.appendEntry(conv.harnessId, {
          kind: 'pi.system',
          data: { reason: 'model', model: { provider: 'faux', modelId: 'faux-1' } },
        });
      }, kernel.context);
      const view = await conversation.context(kernel.context);
      const kinds = (view.entries || []).map((entry) => entry.kind);
      assert.ok(kinds.includes('pi.system'), JSON.stringify(kinds));
      assert.equal(kinds.includes('pi.user'), false, JSON.stringify(kinds));
      const posted = await kernel.postMessage(conv, 'go');
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      const done = await waitDone(kernel, store, conv);
      assert.equal(done.status, 'done', JSON.stringify(done));
      await writeFile(path.join(repo, 'note.txt'), 'after\n');
      const rows = byPath(await kernel.changes(conv.id));
      const note = rows.get('note.txt');
      assert.ok(note, JSON.stringify([...rows.keys()]));
      assert.equal(note.status, 'modified');
      assert.equal(note.added, 1);
      assert.equal(note.removed, 1);
    } finally {
      await kernel.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('UTF-8 BOM and CRLF diffs match the change counts', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'weft-snap-text-'));
    const dataDir = path.join(root, 'data');
    await mkdir(dataDir);
    const repo = await initGitRepo(root);
    await writeFile(path.join(repo, '.gitattributes'), '* text=auto\n');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(path.join(repo, 'bom.txt'), Buffer.concat([bom, Buffer.from('alpha\nbeta\n', 'utf8')]));
    await writeFile(path.join(repo, 'crlf.txt'), 'line one\r\nline two\r\nline three\r\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'init']);
    const env = { ...process.env, WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ok' };
    delete env.WEFT_FAUX_SCRIPT;
    const store = createSqliteStore(dataDir);
    const kernel = await openConversationKernel({ dataDir, store, demo: true, env });
    try {
      const ws = await store.createWorkspace({
        name: 'text',
        path: repo,
        source: 'local',
        rootPath: repo,
      });
      const conv = await kernel.createConversation({
        workspaceId: ws.id,
        workspacePath: repo,
        title: 'text',
      });
      const posted = await kernel.postMessage(conv, 'go');
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      const done = await waitDone(kernel, store, conv);
      assert.equal(done.status, 'done', JSON.stringify(done));
      await writeFile(path.join(repo, 'bom.txt'), Buffer.concat([bom, Buffer.from('alpha\nBETA\n', 'utf8')]));
      await writeFile(path.join(repo, 'crlf.txt'), 'line one\r\nline TWO\r\nline three\r\n');
      const rows = byPath(await kernel.changes(conv.id));
      for (const name of ['bom.txt', 'crlf.txt']) {
        const row = rows.get(name);
        assert.ok(row, JSON.stringify([...rows.keys()]));
        assert.equal(row.status, 'modified', name);
        assert.equal(row.added, 1, `${name} changes added ${row.added}`);
        assert.equal(row.removed, 1, `${name} changes removed ${row.removed}`);
        const diff = await kernel.diff(conv.id, name);
        assert.equal(diff.status, 200, JSON.stringify(diff.body));
        assert.equal(diff.body.error, undefined, JSON.stringify(diff.body));
        assert.equal(diff.body.added, row.added, name);
        assert.equal(diff.body.removed, row.removed, name);
      }
      const bomDiff = await kernel.diff(conv.id, 'bom.txt');
      assert.equal(bomDiff.body.before.charCodeAt(0), 0xfeff);
      assert.equal(bomDiff.body.after.charCodeAt(0), 0xfeff);
      assert.equal(bomDiff.body.after.includes('BETA'), true);
    } finally {
      await kernel.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
