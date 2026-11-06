import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, ROOT } from './_root.mjs';
const { listBrowsableDirs, resolveAllowedWorkspacePath } = await load('src/core/workspace-guard.mjs');

function nativeReal(p) {
  return realpathSync.native(p);
}

// macOS keeps the temp dir under /private/var, which the guard treats as a system path.
async function tmpBase() {
  const sys = await fs.realpath(os.tmpdir());
  const parent = /^\/(private\/)?var\//.test(sys) ? path.join(ROOT, 'data', 'test-tmp') : sys;
  await fs.mkdir(parent, { recursive: true });
  return fs.realpath(await fs.mkdtemp(path.join(parent, 'piw-browse-')));
}

const made = [];
test.after(async () => {
  for (const dir of made) await fs.rm(dir, { recursive: true, force: true });
});

async function tree() {
  const base = await tmpBase();
  made.push(base);
  const root = path.join(base, 'root');
  await fs.mkdir(path.join(root, 'b-app', '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'a-notes', 'deep'), { recursive: true });
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
  await fs.writeFile(path.join(root, 'file.txt'), 'x');
  await fs.mkdir(path.join(base, 'outside'), { recursive: true });
  await fs.symlink(path.join(base, 'outside'), path.join(root, 'escape'));
  if (existsSync('/etc')) await fs.symlink('/etc', path.join(root, 'to-etc'));
  return { base, root };
}

async function withRoot(root, fn) {
  const prev = process.env.WEFT_WORKSPACE_ROOT;
  process.env.WEFT_WORKSPACE_ROOT = root;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.WEFT_WORKSPACE_ROOT;
    else process.env.WEFT_WORKSPACE_ROOT = prev;
  }
}

test('lists visible sub-folders, marks git repos, and can leave the start directory', async () => {
  const { base, root } = await tree();
  await withRoot(root, async () => {
    const top = await listBrowsableDirs('');
    assert.equal(top.path, root);
    assert.equal(top.root, nativeReal(root));
    assert.equal(top.parent, path.dirname(top.path));
    assert.equal(top.selectable, true);
    const names = ['a-notes', 'b-app', 'escape'];
    assert.deepEqual(top.entries.map((e) => e.name), names);
    assert.equal(top.entries.some((e) => e.name === 'to-etc'), false);
    assert.equal(top.entries.find((e) => e.name === 'b-app').git, true);
    const sub = await listBrowsableDirs(path.join(root, 'a-notes'));
    assert.equal(sub.parent, root);
    assert.deepEqual(sub.entries.map((e) => e.name), ['deep']);
    assert.equal(sub.selectable, true);

    const up = await listBrowsableDirs(top.parent);
    assert.equal(up.path, nativeReal(base));
    assert.deepEqual(up.entries.map((e) => e.name), ['outside', 'root']);
    const outside = await listBrowsableDirs(path.join(base, 'outside'));
    assert.equal(outside.path, nativeReal(path.join(base, 'outside')));
    const viaLink = await listBrowsableDirs(path.join(root, 'escape'));
    assert.equal(viaLink.path, outside.path);
  });
});

test('refuses sensitive paths and ones that do not exist; home and filesystem root are not workspaces', async () => {
  const { base, root } = await tree();
  await withRoot(root, async () => {
    await assert.rejects(listBrowsableDirs(path.join(root, 'missing')), (err) => err.status === 404);
    await assert.rejects(
      () => resolveAllowedWorkspacePath(os.homedir(), { dataDir: base }),
      (err) => err.code === 'E_PATH' && /path is forbidden/.test(err.message),
    );
    const homeListing = await listBrowsableDirs(os.homedir());
    assert.equal(homeListing.selectable, false);
    assert.equal(homeListing.entries.some((e) => e.name === '.ssh' || e.name === '.gnupg'), false);

    if (existsSync('/etc')) {
      await assert.rejects(listBrowsableDirs('/etc'), /path is forbidden/);
      await assert.rejects(
        () => resolveAllowedWorkspacePath(path.join(root, 'to-etc'), { dataDir: base }),
        (err) => err.code === 'E_PATH' && /path is forbidden/.test(err.message),
      );
    }
    if (process.platform !== 'win32') {
      const fsRoot = await listBrowsableDirs('/');
      assert.equal(fsRoot.parent, null);
      assert.equal(fsRoot.selectable, false);
      assert.equal(fsRoot.entries.some((e) => e.name === 'etc' || e.name === 'proc' || e.name === 'sys'), false);
      await assert.rejects(
        () => resolveAllowedWorkspacePath('/', { dataDir: base }),
        /path is forbidden/,
      );
    }

    const outside = path.join(base, 'outside');
    const allowed = await resolveAllowedWorkspacePath(outside, { dataDir: base });
    assert.equal(allowed, nativeReal(outside));
    const dataProject = path.join(base, 'workspaces', 'proj');
    await fs.mkdir(dataProject, { recursive: true });
    const fromData = await resolveAllowedWorkspacePath(dataProject, { dataDir: base });
    assert.equal(fromData, nativeReal(dataProject));
  });
});

async function aliasedRoot() {
  const base = await tmpBase();
  made.push(base);
  const outside = nativeReal(await fs.mkdtemp(path.join(base, 'out-')));
  let alias;
  let canonical;
  if (process.platform === 'win32') {
    const fromTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'weft-short-'));
    made.push(fromTmp);
    canonical = nativeReal(fromTmp);
    if (fromTmp !== canonical) alias = fromTmp;
  }
  if (!alias) {
    canonical = nativeReal(await fs.mkdtemp(path.join(base, 'real-')));
    alias = path.join(base, 'ws-alias');
    await fs.symlink(canonical, alias, process.platform === 'win32' ? 'junction' : undefined);
  }
  await fs.mkdir(path.join(canonical, 'inside'));
  assert.notEqual(alias, canonical);
  return { base, alias, canonical, outside };
}

test('alias root (8.3 or symlink) allows children and directories outside the alias', async () => {
  const { base, alias, canonical, outside } = await aliasedRoot();
  await withRoot(alias, async () => {
    const childViaAlias = path.join(alias, 'inside');
    const allowed = await resolveAllowedWorkspacePath(childViaAlias, { dataDir: base });
    assert.equal(allowed, nativeReal(childViaAlias));
    assert.equal(allowed, nativeReal(path.join(canonical, 'inside')));

    const allowedCanonical = await resolveAllowedWorkspacePath(path.join(canonical, 'inside'), { dataDir: base });
    assert.equal(allowedCanonical, nativeReal(path.join(canonical, 'inside')));

    const allowedOutside = await resolveAllowedWorkspacePath(outside, { dataDir: base });
    assert.equal(allowedOutside, nativeReal(outside));

    const listed = await listBrowsableDirs('');
    assert.equal(listed.root, canonical);
    assert.deepEqual(listed.entries.map((entry) => entry.name), ['inside']);
    assert.equal(listed.entries[0].path, path.join(canonical, 'inside'));

    const listedOutside = await listBrowsableDirs(outside);
    assert.equal(listedOutside.path, nativeReal(outside));
  });
});
