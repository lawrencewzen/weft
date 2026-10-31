import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore, createModelsStore } from '../../src/core/provider-stores.mjs';
import { createProviderService } from '../../src/core/provider-service.mjs';
import { normalizeProvidersV3 } from '../../src/core/provider-config.mjs';
import { createKernelModels } from '../../src/kernel/models.mjs';
import {
  ANTIGRAVITY_ACP_ID,
  ANTIGRAVITY_ACP_MARKER,
  antigravityAcpLocalLogin,
  inspectAntigravityAcpAuth,
} from '../../src/core/antigravity-acp.mjs';
import { fakeOAuthProvider, waitUntil } from './provider-fakes.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

function writeAgySettings(dir, authType = 'oauth-personal') {
  mkdirSync(path.join(dir, 'antigravity-acp'), { recursive: true });
  writeFileSync(
    path.join(dir, 'antigravity-acp', 'settings.json'),
    JSON.stringify({ auth: { type: authType } }),
  );
}

function writeAgyToken(dir, refresh = 'refresh-token-value') {
  mkdirSync(path.join(dir, 'antigravity-acp'), { recursive: true });
  writeFileSync(
    path.join(dir, 'antigravity-acp', 'acp_token.json'),
    JSON.stringify({ refresh_token: refresh }),
  );
}

async function withService(fn, { env = {}, extraProviders, settings } = {}) {
  const dir = await makeTempDir('weft-agy-acp-');
  const store = createSqliteStore(dir);
  const credentials = createCredentialStore(store);
  const modelsStore = createModelsStore(store);
  try {
    if (settings) await store.replaceSettings(settings);
    const service = createProviderService({
      store,
      credentials,
      modelsStore,
      env,
      extraProviders,
    });
    return await fn({ store, credentials, service, dir });
  } finally {
    store.close();
    await removeTempDir(dir);
  }
}

test('inspectAntigravityAcpAuth detects settings-only (keychain) and refreshable token', async () => {
  const dir = await makeTempDir('weft-agy-auth-');
  try {
    const env = { GEMINI_HOME: dir, HOME: dir };
    assert.equal(inspectAntigravityAcpAuth(env).status, 'missing');
    assert.equal(antigravityAcpLocalLogin(env).detected, false);

    writeAgySettings(dir);
    assert.equal(inspectAntigravityAcpAuth(env).status, 'configured-not-authenticated');
    assert.equal(antigravityAcpLocalLogin(env).detected, true);

    writeAgyToken(dir);
    const health = inspectAntigravityAcpAuth(env);
    assert.equal(health.status, 'oauth-refreshable');
    assert.equal(health.authType, 'oauth-personal');
    const dumped = JSON.stringify(health);
    assert.equal(dumped.includes('refresh-token-value'), false);
  } finally {
    await removeTempDir(dir);
  }
});

test('normalizeProvidersV3 keeps antigravity-acp as a builtin id', () => {
  const out = normalizeProvidersV3([{
    id: ANTIGRAVITY_ACP_ID,
    kind: 'builtin',
    enabled: ['gemini-3.8-flash'],
    overrides: {},
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, ANTIGRAVITY_ACP_ID);
  assert.equal(out[0].kind, 'builtin');
  assert.deepEqual(out[0].enabled, ['gemini-3.8-flash']);
});

test('listAvailable exposes antigravity-acp as oauth with localLogin', async () => {
  const dir = await makeTempDir('weft-agy-avail-');
  try {
    writeAgySettings(dir);
    await withService(async ({ service }) => {
      const listed = await service.listAvailable();
      const agy = listed.find((item) => item.id === ANTIGRAVITY_ACP_ID);
      assert.ok(agy);
      assert.deepEqual(agy.authMethods, ['oauth']);
      assert.equal(agy.localLogin.detected, true);
      assert.equal(agy.popular, false);
      const dumped = JSON.stringify(agy);
      assert.equal(dumped.includes('refresh_token'), false);
    }, {
      env: { GEMINI_HOME: dir, HOME: dir },
      extraProviders: [fakeOAuthProvider({
        id: ANTIGRAVITY_ACP_ID,
        name: 'Google Antigravity (ACP)',
        models: ['gemini-3.8-flash'],
      })],
    });
  } finally {
    await removeTempDir(dir);
  }
});

test('connectLocalLogin saves a marker credential for antigravity-acp without probing', async () => {
  const dir = await makeTempDir('weft-agy-connect-');
  try {
    writeAgySettings(dir);
    await withService(async ({ service, credentials }) => {
      const provider = await service.connectLocalLogin(ANTIGRAVITY_ACP_ID);
      assert.equal(provider.id, ANTIGRAVITY_ACP_ID);
      assert.equal(provider.auth.type, 'oauth');
      assert.equal(provider.status.state, 'ok');
      assert.equal(provider.models.some((item) => item.id === 'gemini-3.8-flash' && item.enabled), true);
      const cred = await credentials.read(ANTIGRAVITY_ACP_ID);
      assert.equal(cred.type, 'oauth');
      assert.equal(cred.access, ANTIGRAVITY_ACP_MARKER);
      assert.equal(cred.refresh, ANTIGRAVITY_ACP_MARKER);
      const dumped = JSON.stringify(provider);
      assert.equal(dumped.includes(ANTIGRAVITY_ACP_MARKER), false);
    }, {
      env: { GEMINI_HOME: dir, HOME: dir },
      extraProviders: [fakeOAuthProvider({
        id: ANTIGRAVITY_ACP_ID,
        name: 'Google Antigravity (ACP)',
        models: ['gemini-3.8-flash', 'gemini-4-argon'],
      })],
    });
  } finally {
    await removeTempDir(dir);
  }
});

test('connectLocalLogin rejects antigravity-acp when local login is missing', async () => {
  const dir = await makeTempDir('weft-agy-missing-');
  try {
    await withService(async ({ service }) => {
      await assert.rejects(() => service.connectLocalLogin(ANTIGRAVITY_ACP_ID), (err) => {
        assert.equal(err.code, 'E_BAD_REQUEST');
        assert.equal(err.phrase, 'src_err_agy_login');
        return true;
      });
    }, {
      env: { GEMINI_HOME: dir, HOME: dir },
      extraProviders: [fakeOAuthProvider({
        id: ANTIGRAVITY_ACP_ID,
        name: 'Google Antigravity (ACP)',
        models: ['gemini-3.8-flash'],
      })],
    });
  } finally {
    await removeTempDir(dir);
  }
});

test('startOAuth maps info links to auth_url for antigravity-acp', async () => {
  await withService(async ({ service }) => {
    const started = await service.startOAuth(ANTIGRAVITY_ACP_ID);
    const prompted = await waitUntil(async () => {
      const session = service.getSession(started.id);
      return session.state === 'prompt' ? session : null;
    });
    const auth = prompted.events.find((item) => item.type === 'auth_url');
    assert.equal(auth?.url, 'https://accounts.google.test/auth');
    assert.match(String(auth?.instructions || ''), /localhost/i);
  }, {
    extraProviders: [fakeOAuthProvider({
      id: ANTIGRAVITY_ACP_ID,
      name: 'Google Antigravity (ACP)',
      models: ['gemini-3.8-flash'],
      async onLogin(interaction) {
        interaction.notify({
          type: 'info',
          message: 'Open this URL then paste the localhost callback.',
          links: [{ url: 'https://accounts.google.test/auth', label: 'Google authorization' }],
        });
        await interaction.prompt({
          type: 'manual_code',
          message: 'Paste the callback URL',
          placeholder: 'http://127.0.0.1/?code=',
        });
        return {
          type: 'oauth',
          access: ANTIGRAVITY_ACP_MARKER,
          refresh: ANTIGRAVITY_ACP_MARKER,
          expires: Date.now() + 3_600_000,
        };
      },
    })],
  });
});

test('createKernelModels installs extra antigravity-acp provider', async () => {
  const extra = fakeOAuthProvider({
    id: ANTIGRAVITY_ACP_ID,
    name: 'Google Antigravity (ACP)',
    models: ['gemini-3.8-flash'],
  });
  const settings = {
    version: 3,
    providers: [{
      id: ANTIGRAVITY_ACP_ID,
      kind: 'builtin',
      enabled: ['gemini-3.8-flash'],
      overrides: {},
    }],
    defaultModel: { providerId: ANTIGRAVITY_ACP_ID, modelId: 'gemini-3.8-flash' },
  };
  const models = createModels();
  const routes = createKernelModels({
    models,
    getSettings: async () => settings,
    extraProviders: [extra],
  });
  const ref = await routes.modelFor({});
  assert.deepEqual(ref, { provider: ANTIGRAVITY_ACP_ID, modelId: 'gemini-3.8-flash' });
  assert.ok(models.getModel(ANTIGRAVITY_ACP_ID, 'gemini-3.8-flash'));
});
