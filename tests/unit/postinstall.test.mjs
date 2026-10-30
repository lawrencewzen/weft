import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOT_BUILT_HINT, isMissingVite, tryBuildWeb } from '../../scripts/postinstall.mjs';

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

