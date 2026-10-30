import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  XAI_OAUTH_CLIENT_ID,
  grokAuthPath,
  grokHomeDir,
  inspectGrokAuth,
  grokAuthToXaiCredential,
  detectGrokLocalLogin,
  loadGrokXaiCredential,
} from '../../src/core/grok-local-login.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const ACCESS = 'access-fixture-aaa';
const REFRESH = 'refresh-fixture-bbb';
const ACCOUNT = 'tester@x.com';

function sampleEntry(extra = {}) {
  return {
    key: ACCESS,
    refresh_token: REFRESH,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    email: ACCOUNT,
    ...extra,
  };
}

function preferredRoot(entry = sampleEntry()) {
  return { [`https://auth.x.ai::${XAI_OAUTH_CLIENT_ID}`]: entry };
}

test('stub env without HOME does not fall back to the real homedir', () => {
  assert.equal(grokHomeDir({}), '');
  assert.equal(grokAuthPath({}), '');
  assert.deepEqual(detectGrokLocalLogin({}), { detected: false });
  assert.equal(loadGrokXaiCredential({}), null);
});

test('inspectGrokAuth reports detected + account and never includes tokens', () => {
  const view = inspectGrokAuth(preferredRoot());
  assert.equal(view.detected, true);
  assert.equal(view.account, ACCOUNT);
  assert.equal('key' in view, false);
  assert.equal('refresh_token' in view, false);
  assert.equal('access' in view, false);
  assert.equal('refresh' in view, false);
  assert.deepEqual(Object.keys(view).sort(), ['account', 'detected']);
});

test('inspectGrokAuth is false when the file has no xAI entry', () => {
  assert.deepEqual(inspectGrokAuth(null), { detected: false });
  assert.deepEqual(inspectGrokAuth({}), { detected: false });
  assert.deepEqual(inspectGrokAuth({ other: { key: ACCESS } }), { detected: false });
});

test('grokAuthToXaiCredential maps key/refresh_token/expires_at', () => {
  const cred = grokAuthToXaiCredential(preferredRoot());
  assert.equal(cred.type, 'oauth');
  assert.equal(cred.access, ACCESS);
  assert.equal(cred.refresh, REFRESH);
  assert.equal(cred.account, ACCOUNT);
  assert.equal(typeof cred.expires, 'number');
  assert.equal(Number.isFinite(cred.expires), true);
});

test('conversion returns null when refresh or access is missing', () => {
  assert.equal(grokAuthToXaiCredential(preferredRoot({ key: '', refresh_token: REFRESH })), null);
  assert.equal(grokAuthToXaiCredential(preferredRoot({ refresh_token: '' })), null);
});

test('detectGrokLocalLogin reads a temp HOME auth.json and omits tokens', async () => {
  const dir = await makeTempDir('weft-grok-auth-');
  try {
    mkdirSync(path.join(dir, '.grok'), { recursive: true });
    writeFileSync(
      path.join(dir, '.grok', 'auth.json'),
      JSON.stringify(preferredRoot()),
      'utf8',
    );
    const env = { HOME: dir, USERPROFILE: dir };
    assert.equal(grokAuthPath(env), path.join(dir, '.grok', 'auth.json'));
    const view = detectGrokLocalLogin(env);
    assert.equal(view.detected, true);
    assert.equal(view.account, ACCOUNT);
    const dumped = JSON.stringify(view);
    assert.equal(dumped.includes(ACCESS), false);
    assert.equal(dumped.includes(REFRESH), false);
    const cred = loadGrokXaiCredential(env);
    assert.equal(cred.type, 'oauth');
    assert.equal(cred.access, ACCESS);
  } finally {
    await removeTempDir(dir);
  }
});

test('detectGrokLocalLogin is false when auth.json is missing or invalid', async () => {
  const dir = await makeTempDir('weft-grok-missing-');
  try {
    const env = { HOME: dir, USERPROFILE: dir };
    assert.deepEqual(detectGrokLocalLogin(env), { detected: false });
    mkdirSync(path.join(dir, '.grok'), { recursive: true });
    writeFileSync(path.join(dir, '.grok', 'auth.json'), '{not-json', 'utf8');
    assert.deepEqual(detectGrokLocalLogin(env), { detected: false });
  } finally {
    await removeTempDir(dir);
  }
});
