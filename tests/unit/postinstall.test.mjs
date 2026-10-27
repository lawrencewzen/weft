import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NOT_BUILT_HINT, copyBrandIcons, isMissingVite, tryBuildWeb } from '../../scripts/postinstall.mjs';

test('isMissingVite recognizes module-not-found errors for vite', () => {
  assert.equal(isMissingVite(Object.assign(new Error("Cannot find package 'vite'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  })), true);
  assert.equal(isMissingVite(Object.assign(new Error("Cannot find module 'vite'"), {
    code: 'MODULE_NOT_FOUND',
  })), true);
  assert.equal(isMissingVite(new Error('build failed')), false);
});

test('postinstall continues when vite is missing', () => {
  const logs = [];
  let spawned = false;
  const status = tryBuildWeb({
    resolveVite() {
      const err = new Error("Cannot find package 'vite' imported from scripts/postinstall.mjs");
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    },
    spawn() {
      spawned = true;
      return { status: 1 };
    },
    write(text) {
      logs.push(text);
    },
  });
  assert.equal(status, 0);
  assert.equal(spawned, false);
  assert.equal(logs.join(''), `${NOT_BUILT_HINT}\n`);
});

test('copyBrandIcons copies only the flat SVG set and clears the old directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'weft-icons-'));
  const srcDir = path.join(root, 'src');
  const destDir = path.join(root, 'dest');
  try {
    await writeFile(path.join(root, 'keep.txt'), 'x');
    await (await import('node:fs/promises')).mkdir(srcDir);
    await (await import('node:fs/promises')).mkdir(destDir);
    await writeFile(path.join(srcDir, 'grok.svg'), '<svg/>');
    await writeFile(path.join(srcDir, 'notes.md'), '# not an icon');
    await writeFile(path.join(destDir, 'stale.svg'), '<svg/>');

    assert.equal(copyBrandIcons({ srcDir, destDir }), 1);
    assert.deepEqual((await readdir(destDir)).sort(), ['grok.svg']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('copyBrandIcons is a no-op when the icon package is absent', () => {
  assert.equal(copyBrandIcons({ srcDir: '/nonexistent/icons', destDir: '/nonexistent/dest' }), 0);
});
