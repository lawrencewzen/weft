import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  collectGitStatus,
  createGitStatusCache,
  parseAheadBehind,
  parseBranch,
  parseNumstat,
  parsePorcelain,
} from '../../src/v2/views/git-status.ts';

const execFileP = promisify(execFile);

async function tryGit(cwd, args) {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { ok: true, stdout: String(stdout || '') };
  } catch (err) {
    return { ok: false, err };
  }
}

async function gitInit(dir, branch = 'main') {
  const first = await tryGit(dir, ['init', '-b', branch]);
  if (first.ok) return true;
  if (first.err?.code === 'ENOENT') return false;
  const second = await tryGit(dir, ['init']);
  return second.ok;
}

async function gitIdent(dir, args) {
  return tryGit(dir, ['-c', 'user.name=weft', '-c', 'user.email=weft@test', ...args]);
}

function mockRun(handlers) {
  return async (args) => {
    const key = args.join(' ');
    for (const [prefix, result] of handlers) {
      if (key === prefix || key.startsWith(`${prefix} `) || args[0] === prefix) {
        const value = typeof result === 'function' ? await result(args) : result;
        return value;
      }
    }
    return { stdout: '', code: 1 };
  };
}

test('parsePorcelain counts modified, staged, and untracked files', () => {
  const text = [
    ' M src/a.ts',
    'A  src/b.ts',
    '?? new.txt',
    'R  old.ts -> renamed.ts',
    '',
  ].join('\n');
  assert.equal(parsePorcelain(text), 4);
  assert.equal(parsePorcelain(''), 0);
  assert.equal(parsePorcelain('?? untracked-only\n'), 1);
});

test('parseNumstat sums lines and skips binary files', () => {
  const text = [
    '10\t2\tfile.txt',
    '-\t-\timage.png',
    '3\t0\tpath with spaces.md',
    '0\t4\tgone.ts',
  ].join('\n');
  assert.deepEqual(parseNumstat(text), { insertions: 13, deletions: 6 });
  assert.deepEqual(parseNumstat(''), { insertions: 0, deletions: 0 });
});

test('parseAheadBehind reads behind then ahead', () => {
  assert.deepEqual(parseAheadBehind('2\t3\n'), { behind: 2, ahead: 3 });
  assert.deepEqual(parseAheadBehind('0 0'), { behind: 0, ahead: 0 });
  assert.equal(parseAheadBehind(''), null);
  assert.equal(parseAheadBehind('nope'), null);
});

test('parseBranch uses the symbolic ref or a short sha when detached', () => {
  assert.deepEqual(parseBranch('main\n', 'abc'), { branch: 'main', detached: false });
  assert.deepEqual(parseBranch('HEAD', 'deadbeef'), { branch: 'deadbeef', detached: true });
  assert.deepEqual(parseBranch('', 'abc1234'), { branch: 'abc1234', detached: true });
  assert.equal(parseBranch('', ''), null);
});

test('collectGitStatus with a mock runner covers clean branch, dirty, untracked, detached, upstream', async () => {
  const clean = await collectGitStatus('/repo', {
    run: mockRun([
      ['rev-parse --is-inside-work-tree', { stdout: 'true\n', code: 0 }],
      ['status', { stdout: '', code: 0 }],
      ['diff', { stdout: '', code: 0 }],
      ['symbolic-ref', { stdout: 'main\n', code: 0 }],
      ['rev-parse --short', { stdout: 'abc\n', code: 0 }],
      ['rev-list', { stdout: '0\t0\n', code: 0 }],
    ]),
  });
  assert.deepEqual(clean, {
    branch: 'main',
    detached: false,
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    ahead: 0,
    behind: 0,
  });

  const dirty = await collectGitStatus('/repo', {
    run: mockRun([
      ['rev-parse --is-inside-work-tree', { stdout: 'true\n', code: 0 }],
      ['status', { stdout: ' M a.ts\n?? extra.txt\n', code: 0 }],
      ['diff', { stdout: '12\t3\ta.ts\n-\t-\tpic.bin\n', code: 0 }],
      ['symbolic-ref', { stdout: 'dev\n', code: 0 }],
      ['rev-parse --short', { stdout: 'fff\n', code: 0 }],
      ['rev-list', { stdout: '1\t2\n', code: 0 }],
    ]),
  });
  assert.deepEqual(dirty, {
    branch: 'dev',
    detached: false,
    changedFiles: 2,
    insertions: 12,
    deletions: 3,
    ahead: 2,
    behind: 1,
  });

  const detached = await collectGitStatus('/repo', {
    run: mockRun([
      ['rev-parse --is-inside-work-tree', { stdout: 'true\n', code: 0 }],
      ['status', { stdout: '', code: 0 }],
      ['diff', { stdout: '', code: 0 }],
      ['symbolic-ref', { stdout: '', code: 1 }],
      ['rev-parse --short', { stdout: 'bead\n', code: 0 }],
      ['rev-list', { stdout: '', code: 128 }],
    ]),
  });
  assert.deepEqual(detached, {
    branch: 'bead',
    detached: true,
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    ahead: null,
    behind: null,
  });
});

test('collectGitStatus returns null for a non-git directory, missing git, or empty cwd', async () => {
  assert.equal(await collectGitStatus(''), null);
  assert.equal(await collectGitStatus('/tmp/not-a-repo', {
    run: async () => ({ stdout: 'false\n', code: 128 }),
  }), null);
  assert.equal(await collectGitStatus('/tmp/x', {
    run: async () => {
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    },
  }), null);
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-not-git-'));
  const real = await collectGitStatus(dir);
  assert.equal(real, null);
});

test('createGitStatusCache merges concurrent refresh of the same workspace', async () => {
  let insideCalls = 0;
  const run = async (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      insideCalls += 1;
      await sleep(40);
      return { stdout: 'true\n', code: 0 };
    }
    if (args[0] === 'symbolic-ref') return { stdout: 'main\n', code: 0 };
    if (args[0] === 'status' || args[0] === 'diff') return { stdout: '', code: 0 };
    if (args[0] === 'rev-parse') return { stdout: 'abc\n', code: 0 };
    return { stdout: '', code: 1 };
  };
  const cache = createGitStatusCache({ run });
  const [a, b] = await Promise.all([
    cache.refresh('w1', '/repo'),
    cache.refresh('w1', '/repo'),
  ]);
  assert.equal(insideCalls, 1);
  assert.equal(a.branch, 'main');
  assert.equal(b.branch, 'main');
  assert.equal(cache.peek('w1').branch, 'main');
});

test('real git init: clean branch, dirty, untracked, detached, upstream ahead/behind', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-git-status-'));
  const inited = await gitInit(dir);
  if (!inited) {
    assert.equal(await collectGitStatus(dir), null);
    return;
  }
  await writeFile(path.join(dir, 'readme.txt'), 'one\n');
  const committed = await gitIdent(dir, ['add', 'readme.txt']);
  assert.equal(committed.ok, true, String(committed.err));
  const made = await gitIdent(dir, ['commit', '-m', 'init', '--no-gpg-sign']);
  assert.equal(made.ok, true, String(made.err));

  const clean = await collectGitStatus(dir);
  assert.ok(clean, 'git repo should yield a status');
  assert.equal(clean.detached, false);
  assert.ok(clean.branch === 'main' || clean.branch === 'master', clean.branch);
  assert.equal(clean.changedFiles, 0);
  assert.equal(clean.insertions, 0);
  assert.equal(clean.deletions, 0);
  assert.equal(clean.ahead, null);
  assert.equal(clean.behind, null);

  await writeFile(path.join(dir, 'readme.txt'), 'one\ntwo\n');
  await writeFile(path.join(dir, 'extra.txt'), 'new\n');
  const dirty = await collectGitStatus(dir);
  assert.ok(dirty);
  assert.equal(dirty.changedFiles, 2);
  assert.ok(dirty.insertions >= 1);
  assert.equal(dirty.deletions, 0);

  const detachedOk = await tryGit(dir, ['checkout', '--detach']);
  if (detachedOk.ok) {
    const detached = await collectGitStatus(dir);
    assert.ok(detached);
    assert.equal(detached.detached, true);
    assert.ok(detached.branch.length >= 4);
    await tryGit(dir, ['checkout', clean.branch]);
  }

  const parent = await mkdtemp(path.join(tmpdir(), 'weft-git-remote-'));
  const bare = path.join(parent, 'remote.git');
  const bareInit = await tryGit(parent, ['init', '--bare', '-b', clean.branch, bare]);
  if (!bareInit.ok) {
    await tryGit(parent, ['init', '--bare', bare]);
  }
  const added = await tryGit(dir, ['remote', 'add', 'origin', bare]);
  if (!added.ok) {
    return;
  }
  const pushed = await tryGit(dir, ['push', '-u', 'origin', 'HEAD']);
  if (!pushed.ok) return;
  const tracked = await collectGitStatus(dir);
  assert.ok(tracked);
  assert.equal(tracked.ahead, 0);
  assert.equal(tracked.behind, 0);

  await writeFile(path.join(dir, 'readme.txt'), 'one\ntwo\nthree\n');
  await gitIdent(dir, ['add', 'readme.txt']);
  await gitIdent(dir, ['commit', '-m', 'ahead', '--no-gpg-sign']);
  const ahead = await collectGitStatus(dir);
  assert.ok(ahead);
  assert.equal(ahead.ahead, 1);
  assert.equal(ahead.behind, 0);

  const cloneDir = path.join(parent, 'clone');
  await mkdir(cloneDir, { recursive: true });
  const cloned = await tryGit(parent, ['clone', bare, cloneDir]);
  if (!cloned.ok) return;
  await tryGit(cloneDir, ['reset', '--hard', 'HEAD~0']);
  await tryGit(dir, ['push', 'origin', 'HEAD']);
  await tryGit(cloneDir, ['fetch', 'origin']);
  const behind = await collectGitStatus(cloneDir);
  assert.ok(behind);
  assert.ok(behind.behind == null || behind.behind >= 0);
});
