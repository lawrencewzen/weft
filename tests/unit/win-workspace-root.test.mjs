import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateResponse } from '../../src/v2/validate.ts';
import { phrase } from '../../src/v2/phrases/index.ts';
import {
  filesystemRootParent,
  listBrowsableDirs,
  listWindowsDrives,
  pathIsSensitive,
  resolveAllowedWorkspacePath,
  windowsSystemRoot,
} from '../../src/core/workspace-guard.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const HOME = 'C:\\Users\\x';
const SYSTEM = 'C:\\Windows';

function winSensitive(resolved, home = HOME, systemRoot = SYSTEM) {
  return pathIsSensitive(resolved, { home, platform: 'win32', systemRoot });
}

test('windows sensitive paths ignore case and still allow drive roots', () => {
  assert.equal(windowsSystemRoot({}), 'C:\\Windows');
  assert.equal(windowsSystemRoot({ SystemRoot: '  D:\\Win  ' }), 'D:\\Win');
  assert.equal(windowsSystemRoot({ SYSTEMROOT: 'C:\\WINDOWS' }), 'C:\\WINDOWS');

  assert.equal(winSensitive('C:\\USERS\\X\\.SSH'), true);
  assert.equal(winSensitive('C:\\users\\x\\.ssh\\id_ed25519'), true);
  assert.equal(winSensitive('C:\\Users\\x\\.GNUPG'), true);
  assert.equal(winSensitive('c:\\users\\x\\.gnupg\\private-keys-v1.d'), true);
  assert.equal(winSensitive('C:\\Windows\\System32'), true);
  assert.equal(winSensitive('c:\\windows\\system32\\drivers'), true);
  assert.equal(winSensitive('C:\\WINDOWS'), true);
  assert.equal(winSensitive('C:\\Windows\\System32', HOME, windowsSystemRoot({})), true);
  assert.equal(winSensitive('D:\\work'), false);
  assert.equal(winSensitive('D:\\'), false);
  assert.equal(winSensitive('d:/'), false);
  assert.equal(winSensitive('C:\\'), false);
  assert.equal(winSensitive('C:\\Users\\x'), false);
  assert.equal(winSensitive('C:\\Windows.old'), false);
  assert.equal(winSensitive('C:\\WindowsApps'), false);

  assert.equal(filesystemRootParent('D:\\', 'win32'), '');
  assert.equal(filesystemRootParent('D:/', 'win32'), '');
  assert.equal(filesystemRootParent('C:\\', 'win32'), '');
  assert.equal(filesystemRootParent('D:\\work', 'win32'), undefined);
  assert.equal(filesystemRootParent('/', 'linux'), null);
  assert.equal(filesystemRootParent('/tmp', 'linux'), undefined);

  assert.equal(pathIsSensitive('/home/x/.gnupg', { home: '/home/x', platform: 'linux' }), true);
  assert.equal(pathIsSensitive('/home/x/.ssh', { home: '/home/x', platform: 'linux' }), true);
  assert.equal(pathIsSensitive('/home/x', { home: '/home/x', platform: 'linux' }), false);
  assert.equal(pathIsSensitive('/', { home: '/home/x', platform: 'linux' }), false);
  assert.equal(pathIsSensitive('/etc/ssh', { home: '/home/x', platform: 'linux' }), true);
  assert.equal(pathIsSensitive('D:\\work', { home: HOME, platform: 'linux', systemRoot: SYSTEM }), false);
});

test('view=drives lists ready letters and one hung drive does not block the rest', async () => {
  let accessCalls = 0;
  await assert.rejects(
    () => listWindowsDrives({
      platform: 'linux',
      access() { accessCalls += 1; return Promise.resolve(); },
    }),
    (err) => err.status === 404 && err.code === 'E_PATH' && /not allowed/.test(err.message),
  );
  await assert.rejects(
    () => listBrowsableDirs('D:\\', { view: 'drives', platform: 'darwin' }),
    (err) => err.status === 404 && err.code === 'E_PATH',
  );
  assert.equal(accessCalls, 0);

  const started = Date.now();
  const seen = [];
  const listed = await listWindowsDrives({
    platform: 'win32',
    root: 'D:\\work',
    timeoutMs: 80,
    access(target) {
      seen.push({ target, at: Date.now() - started });
      if (target.startsWith('A:')) return new Promise(() => {});
      if (target.startsWith('B:')) return Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }));
      if (target === 'C:\\' || target === 'D:\\') return Promise.resolve();
      return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    },
  });
  const elapsed = Date.now() - started;
  const a = seen.find((row) => row.target === 'A:\\');
  const d = seen.find((row) => row.target === 'D:\\');
  assert.ok(a && d, JSON.stringify(seen));
  assert.ok(d.at - a.at < 40, `D: started ${d.at - a.at}ms after A:`);
  assert.ok(elapsed < 500, `drive list took ${elapsed}ms`);
  assert.equal(listed.root, 'D:\\work');
  assert.equal(listed.path, '');
  assert.equal(listed.parent, null);
  assert.equal(listed.selectable, false);
  assert.equal(listed.git, false);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.entries, [
    { name: 'C:', path: 'C:\\', git: false },
    { name: 'D:', path: 'D:\\', git: false },
  ]);

  const viaView = await listBrowsableDirs(null, {
    view: 'drives',
    platform: 'win32',
    root: 'D:\\work',
    timeoutMs: 20,
    access(target) {
      return target === 'D:\\' ? Promise.resolve() : Promise.reject(new Error('no'));
    },
  });
  assert.deepEqual(viaView.entries, [{ name: 'D:', path: 'D:\\', git: false }]);
  assert.equal(viaView.path, '');
  assert.equal(viaView.parent, null);
});

function nativeReal(p) {
  return realpathSync.native(p);
}

function swapCase(text) {
  return text.replace(/[A-Za-z]/g, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
}

async function ensureDir(dir) {
  try {
    return { path: nativeReal(dir), created: false };
  } catch {
    await fs.mkdir(dir, { recursive: true });
    return { path: nativeReal(dir), created: true };
  }
}

test('win32 refuses mixed-case sensitive directories and junctions, and allows a drive root', async () => {
  if (process.platform !== 'win32') return;
  const dataDir = await makeTempDir('weft-win-guard-');
  const made = [];
  const ssh = await ensureDir(path.join(os.homedir(), '.ssh'));
  const gnupg = await ensureDir(path.join(os.homedir(), '.gnupg'));
  if (ssh.created) made.push(ssh.path);
  if (gnupg.created) made.push(gnupg.path);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'weft-win-work-'));
  const systemRoot = windowsSystemRoot();
  const system32 = path.join(systemRoot, 'System32');
  const linked = path.join(work, 'via-system');
  const sshLink = path.join(work, 'via-ssh');
  const okLink = path.join(work, 'via-proj');
  try {
    await assert.rejects(
      () => resolveAllowedWorkspacePath(swapCase(ssh.path), { dataDir }),
      (err) => err.status === 400 && err.code === 'E_PATH',
    );
    await assert.rejects(
      () => resolveAllowedWorkspacePath(swapCase(gnupg.path), { dataDir }),
      (err) => err.status === 400 && err.code === 'E_PATH',
    );
    await assert.rejects(
      () => resolveAllowedWorkspacePath(swapCase(system32), { dataDir }),
      (err) => err.status === 400 && err.code === 'E_PATH',
    );
    await assert.rejects(
      () => listBrowsableDirs(system32),
      (err) => err.status === 400 && err.code === 'E_PATH',
    );

    const allowedWork = await resolveAllowedWorkspacePath(work, { dataDir });
    assert.equal(allowedWork, nativeReal(work));

    const drive = path.parse(nativeReal(work)).root;
    const driveListed = await listBrowsableDirs(drive);
    assert.equal(driveListed.parent, '');
    assert.equal(driveListed.selectable, true);
    const allowedDrive = await resolveAllowedWorkspacePath(drive, { dataDir });
    assert.equal(path.win32.resolve(allowedDrive).toLowerCase(), path.win32.resolve(drive).toLowerCase());

    if (existsSync('D:\\')) {
      const dListed = await listBrowsableDirs('D:\\');
      assert.equal(dListed.parent, '');
      assert.equal(dListed.selectable, true);
      const allowedD = await resolveAllowedWorkspacePath('D:\\', { dataDir });
      assert.equal(path.win32.parse(allowedD).root.toLowerCase(), 'd:\\');
    }

    await fs.symlink(system32, linked, 'junction');
    await assert.rejects(
      () => resolveAllowedWorkspacePath(linked, { dataDir }),
      (err) => err.status === 400 && err.code === 'E_PATH',
    );
    await fs.symlink(ssh.path, sshLink, 'junction');
    await assert.rejects(
      () => resolveAllowedWorkspacePath(sshLink, { dataDir }),
      (err) => err.status === 400 && err.code === 'E_PATH',
    );
    const realProj = path.join(work, 'real-proj');
    await fs.mkdir(realProj);
    await fs.symlink(realProj, okLink, 'junction');
    const allowedLink = await resolveAllowedWorkspacePath(okLink, { dataDir });
    assert.equal(allowedLink, nativeReal(realProj));

    const listed = await listBrowsableDirs(work);
    const names = listed.entries.map((entry) => entry.name);
    assert.equal(names.includes('via-system'), false);
    assert.equal(names.includes('via-ssh'), false);
    assert.equal(names.includes('via-proj'), true);
  } finally {
    for (const link of [linked, sshLink, okLink]) {
      await fs.rm(link, { recursive: false, force: true }).catch(() => {});
    }
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    await removeTempDir(dataDir);
    for (const dir of made.reverse()) {
      await fs.rmdir(dir).catch(() => {});
    }
  }
});

test('workspace-root dirs view=drives on v2 and the old API', { timeout: 40_000 }, async () => {
  const wsRoot = await makeTempDir('weft-drives-root-');
  await fs.mkdir(path.join(wsRoot, 'keep'));
  const srv = await startServer({
    token: 'win-drives-token',
    env: { WEFT_LLM: 'faux', WEFT_WORKSPACE_ROOT: wsRoot },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const v2 = await fetch(`${srv.base}/api/v2/workspace-root/dirs?view=drives`, {
      headers: { authorization: `Bearer ${discovery.token}` },
    });
    const v2Text = await v2.text();
    const v2Body = v2Text ? JSON.parse(v2Text) : null;
    const old = await request(srv.base, 'GET', '/api/workspace-root/dirs?view=drives', null, 'win-drives-token');

    if (process.platform === 'win32') {
      assert.equal(v2.status, 200, v2Text);
      assert.equal(validateResponse('/api/v2/workspace-root/dirs', 'GET', 200, v2Body).ok, true);
      assert.equal(v2Body.path, '');
      assert.equal(v2Body.parent, null);
      assert.equal(v2Body.selectable, false);
      assert.equal(v2Body.git, false);
      assert.ok(v2Body.entries.some((entry) => entry.name === 'C:' && entry.path === 'C:\\' && entry.git === false));
      assert.equal(old.status, 200, old.text);
      assert.equal(old.body.path, '');
      assert.equal(old.body.parent, null);
      assert.equal(old.body.selectable, false);
      assert.equal(old.body.git, false);
      assert.ok(old.body.entries.some((entry) => entry.name === 'C:' && entry.path === 'C:\\'));
    } else {
      assert.equal(v2.status, 404, v2Text);
      assert.equal(v2Body.code, 'E_PATH');
      assert.equal(v2Body.error, phrase('zh', 'ws_err_path'));
      assert.equal(validateResponse('/api/v2/workspace-root/dirs', 'GET', 404, v2Body).ok, true, JSON.stringify(v2Body));
      assert.equal(old.status, 404, old.text);
      assert.equal(old.body.code, 'E_PATH');
    }

    const other = await fetch(
      `${srv.base}/api/v2/workspace-root/dirs?view=other`,
      { headers: { authorization: `Bearer ${discovery.token}` } },
    );
    const otherBody = await other.json();
    assert.equal(other.status, 200, JSON.stringify(otherBody));
    assert.equal(otherBody.entries.some((entry) => entry.name === 'keep'), true);
  } finally {
    await stopServer(srv);
    await removeTempDir(wsRoot);
  }
});
