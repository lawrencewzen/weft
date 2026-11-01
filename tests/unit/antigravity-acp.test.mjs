import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore, createModelsStore } from '../../src/core/provider-stores.mjs';
import { createProviderService } from '../../src/core/provider-service.mjs';
import { normalizeProvidersV3 } from '../../src/core/provider-config.mjs';
import { createKernelModels } from '../../src/kernel/models.mjs';
import { rememberAntigravityConversationCwd } from '../../src/kernel/antigravity-cwd.mjs';
import { runStateView } from '../../src/v2/views/run.ts';
import {
  AGY_ERR_NO_WORKSPACE,
  ANTIGRAVITY_ACP_ID,
  ANTIGRAVITY_ACP_MARKER,
  antigravityAcpLocalLogin,
  bindAntigravitySessionCwd,
  captureAntigravityWorkspaceOnStream,
  clearAntigravityCwdBindings,
  inspectAntigravityAcpAuth,
  noteAntigravityTurn,
  resolveAntigravityWorkspaceCwd,
} from '../../src/core/antigravity-acp.mjs';
import {
  AntigravityRuntime,
  createAntigravityProvider,
  setCwdResolver,
} from '../../src/vendor/antigravity-acp.mjs';
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

setCwdResolver((options) => resolveAntigravityWorkspaceCwd(options));

const AGY_MODEL = {
  id: 'gemini-3.8-flash',
  name: 'Gemini 3.8 Flash',
  provider: ANTIGRAVITY_ACP_ID,
  api: ANTIGRAVITY_ACP_ID,
  reasoning: false,
};

const VENDOR_PATH = fileURLToPath(new URL('../../src/vendor/antigravity-acp.mjs', import.meta.url));
const PACKAGE_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));
const EMPTY_HISTORY = createHash('sha256').update('').digest('hex');

function sessionState() {
  return {
    modes: {
      currentModeId: 'yolo',
      availableModes: [{ id: 'yolo', name: 'Yolo' }],
    },
    models: {
      currentModelId: AGY_MODEL.id,
      availableModels: [{ modelId: AGY_MODEL.id, name: AGY_MODEL.name }],
    },
  };
}

function fakeAcp(calls) {
  return (options) => {
    calls.push({ op: 'connection', cwd: options?.cwd });
    return {
      async initialize() {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: false } },
          authMethods: [],
        };
      },
      async newSession(cwd) {
        calls.push({ op: 'newSession', cwd });
        return { sessionId: `acp-${calls.length}`, ...sessionState() };
      },
      async loadSession(sessionId, cwd) {
        calls.push({ op: 'loadSession', cwd, sessionId });
        return sessionState();
      },
      async resumeSession(sessionId, cwd) {
        calls.push({ op: 'resumeSession', cwd, sessionId });
        throw new Error('resume should not run in this test');
      },
      async setMode() {},
      async setModel() {},
      async authenticate() {},
      async prompt() {
        return { stopReason: 'end_turn' };
      },
      async cancel() {},
      async close() {},
      getSessionState() {
        return sessionState();
      },
      process: {
        pid: 1,
        generation: 1,
        alive: true,
        ignoredStdoutNoiseLines: 0,
        stderrTail: '',
        exited: new Promise(() => {}),
      },
    };
  };
}

function harnessWithCwd(cwd) {
  return {
    async conversation() {
      return {
        async agent() {
          return cwd ? { cwd } : {};
        },
      };
    },
  };
}

function openAgy(calls, sessionStore) {
  const runtime = new AntigravityRuntime(fakeAcp(calls), 'yolo', sessionStore);
  const bundle = createAntigravityProvider(runtime);
  captureAntigravityWorkspaceOnStream(bundle.provider);
  return bundle;
}

async function drive(provider, sessionId) {
  const stream = provider.streamSimple(AGY_MODEL, {
    messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
  }, { sessionId });
  try {
    return await stream.result();
  } catch (err) {
    return {
      stopReason: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function sessionOps(calls) {
  return calls.filter((call) => call.op === 'newSession' || call.op === 'loadSession' || call.op === 'resumeSession');
}

test('runtime dependencies stay pinned and the plugin package is not installed', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  assert.equal(pkg.dependencies['pi-antigravity-acp-provider'], undefined);
  assert.equal(pkg.dependencies['@agentclientprotocol/sdk'], '1.8.0');
  assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'], '1.32.1');
  assert.equal(pkg.dependencies['proper-lockfile'], '4.1.2');
  assert.equal(pkg.dependencies.unzipper, '0.12.5');
  assert.equal(pkg.dependencies.zod, '4.6.7');
  assert.equal(pkg.dependencies.typebox, '1.3.27');
});

test('vendor bundle does not import pi-coding-agent', () => {
  const text = readFileSync(VENDOR_PATH, 'utf8');
  assert.equal(/from ["']@earendil-works\/pi-coding-agent["']/.test(text), false);
  assert.equal(/require\(["']@earendil-works\/pi-coding-agent["']\)/.test(text), false);
  assert.equal(text.includes('const cwd = process.cwd()'), false);
  assert.equal((text.match(/process\.cwd\(\)/g) || []).length, 6);
});

test('two workspaces get two ACP cwds and a chat without one does not use process.cwd()', async () => {
  clearAntigravityCwdBindings();
  const calls = [];
  const { provider, runtime } = openAgy(calls);
  const serverCwd = process.cwd();
  try {
    await rememberAntigravityConversationCwd(harnessWithCwd('/ws/alpha'), {}, 11, 'sess-alpha');
    await rememberAntigravityConversationCwd(harnessWithCwd('/ws/beta'), {}, 22, 'sess-beta');
    await rememberAntigravityConversationCwd(harnessWithCwd(''), {}, 33, 'sess-bare');
    const [alpha, beta, bare] = await Promise.all([
      drive(provider, 'sess-alpha'),
      drive(provider, 'sess-beta'),
      drive(provider, 'sess-bare'),
    ]);
    const ops = sessionOps(calls);
    assert.deepEqual(
      ops.map((call) => call.cwd).sort(),
      ['/ws/alpha', '/ws/beta'],
    );
    assert.equal(ops.every((call) => call.op === 'newSession'), true);
    assert.equal(ops.some((call) => call.cwd === serverCwd), false);
    assert.equal(calls.some((call) => call.cwd === serverCwd), false);
    assert.equal(alpha.stopReason, 'stop');
    assert.equal(beta.stopReason, 'stop');
    assert.equal(bare.stopReason, 'error');
    assert.match(String(bare.errorMessage || ''), new RegExp(AGY_ERR_NO_WORKSPACE));
  } finally {
    clearAntigravityCwdBindings();
    await runtime.close();
  }
});

test('first turns keep workspaces apart before the provider session id is stored', async () => {
  clearAntigravityCwdBindings();
  const calls = [];
  const { provider, runtime } = openAgy(calls);
  try {
    async function firstTurn(cwd, sessionId) {
      noteAntigravityTurn(cwd);
      await Promise.resolve();
      return drive(provider, sessionId);
    }
    await Promise.all([
      firstTurn('/ws/one', 'fresh-one'),
      firstTurn('/ws/two', 'fresh-two'),
    ]);
    const ops = sessionOps(calls);
    assert.deepEqual(ops.map((call) => call.cwd).sort(), ['/ws/one', '/ws/two']);
    assert.equal(ops.every((call) => call.cwd !== process.cwd()), true);
  } finally {
    clearAntigravityCwdBindings();
    await runtime.close();
  }
});

test('a saved ACP session reloads only when its cwd is the conversation workspace', async () => {
  clearAntigravityCwdBindings();
  bindAntigravitySessionCwd('sess-keep', '/ws/keep');
  const kept = [];
  const store = {
    record: {
      piSessionId: 'sess-keep',
      acpSessionId: 'acp-saved',
      acpModelId: AGY_MODEL.id,
      cwd: '/ws/keep',
      messageCount: 0,
      historyFingerprint: EMPTY_HISTORY,
      lastActive: Date.now(),
    },
    get(id) {
      return this.record?.piSessionId === id ? this.record : undefined;
    },
    save(next) { this.record = next; },
    remove(id) {
      if (this.record?.piSessionId === id) this.record = undefined;
    },
    clear() { this.record = undefined; },
  };
  const keptBundle = openAgy(kept, store);
  try {
    const done = await drive(keptBundle.provider, 'sess-keep');
    assert.equal(done.stopReason, 'stop');
    assert.deepEqual(sessionOps(kept), [
      { op: 'loadSession', cwd: '/ws/keep', sessionId: 'acp-saved' },
    ]);
    assert.equal(store.record.cwd, '/ws/keep');
  } finally {
    await keptBundle.runtime.close();
  }

  clearAntigravityCwdBindings();
  bindAntigravitySessionCwd('sess-move', '/ws/move');
  const moved = [];
  const stale = {
    record: {
      piSessionId: 'sess-move',
      acpSessionId: 'acp-old',
      acpModelId: AGY_MODEL.id,
      cwd: process.cwd(),
      messageCount: 0,
      historyFingerprint: EMPTY_HISTORY,
      lastActive: Date.now(),
    },
    get(id) {
      return this.record?.piSessionId === id ? this.record : undefined;
    },
    save(next) { this.record = next; },
    remove(id) {
      if (this.record?.piSessionId === id) this.record = undefined;
    },
    clear() { this.record = undefined; },
  };
  const movedBundle = openAgy(moved, stale);
  try {
    await drive(movedBundle.provider, 'sess-move');
    const ops = sessionOps(moved);
    assert.equal(ops.some((call) => call.op === 'loadSession' || call.op === 'resumeSession'), false);
    assert.deepEqual(ops, [{ op: 'newSession', cwd: '/ws/move' }]);
    assert.equal(ops[0].cwd === process.cwd(), false);
    assert.equal(stale.record.cwd, '/ws/move');
  } finally {
    clearAntigravityCwdBindings();
    await movedBundle.runtime.close();
  }
});

test('a missing Antigravity workspace is a zh and en phrase', () => {
  const zh = runStateView({
    status: 'failed',
    lang: 'zh',
    llmError: { code: 'E_LLM', message: AGY_ERR_NO_WORKSPACE },
  });
  const en = runStateView({
    status: 'failed',
    lang: 'en',
    llmError: { code: 'E_LLM', message: AGY_ERR_NO_WORKSPACE },
  });
  assert.match(zh.error.message, /没有绑定工作区/);
  assert.match(en.error.message, /no workspace/i);
  assert.equal(zh.error.message.includes(process.cwd()), false);
  const other = runStateView({
    status: 'failed',
    lang: 'zh',
    llmError: { code: 'E_LLM', message: 'provider exploded' },
  });
  assert.equal(other.error.message, 'provider exploded');
});
