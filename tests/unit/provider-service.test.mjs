import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore, createModelsStore } from '../../src/core/provider-stores.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createProviderService,
  EXCLUDED_PROVIDER_IDS,
  POPULAR_PROVIDER_IDS,
} from '../../src/core/provider-service.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';
import { parseFetchedChatModels } from '../../src/kernel/models.mjs';
import {
  fakeKeyProvider,
  fakeOAuthProvider,
  waitUntil,
} from './provider-fakes.mjs';

const CUSTOM_ID = 'custom-aaaaaaaa';
const KEY = 'sk-service-secret-9999';

async function withService(fn, {
  env = {},
  settings,
  extraProviders,
  fetchImpl,
  now,
  loginTtlMs,
} = {}) {
  const dir = await makeTempDir('weft-provider-service-');
  const store = createSqliteStore(dir);
  const credentials = createCredentialStore(store);
  const modelsStore = createModelsStore(store);
  const changes = [];
  try {
    if (settings) await store.replaceSettings(settings);
    const service = createProviderService({
      store,
      credentials,
      modelsStore,
      env: { GROK_HOME: dir, ...env },
      extraProviders,
      fetchImpl,
      now,
      loginTtlMs,
      onChange() { changes.push(Date.now()); },
    });
    return await fn({ store, credentials, modelsStore, service, changes, dir });
  } finally {
    store.close();
    await removeTempDir(dir);
  }
}

function customSettings(overrides = {}) {
  return {
    version: 3,
    providers: [{
      id: CUSTOM_ID,
      kind: 'custom',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      enabled: ['alpha', 'beta'],
      overrides: {},
      ...overrides,
    }],
    defaultModel: { providerId: CUSTOM_ID, modelId: 'alpha' },
  };
}

test('listProviders reports builtin catalog, custom cache, auth types, and overrides', async () => {
  await withService(async ({ service, credentials, modelsStore }) => {
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: KEY }));
    await credentials.modify('google', async () => ({ type: 'oauth', access: 'tok' }));
    await modelsStore.write(CUSTOM_ID, {
      models: [
        {
          id: 'alpha',
          name: 'Alpha',
          input: ['text', 'image'],
          reasoning: true,
          contextWindow: 8000,
          maxTokens: 2000,
        },
        { id: 'beta', name: 'Beta', input: ['text'], contextWindow: 0, maxTokens: 0 },
      ],
    });
    const listed = await service.listProviders();
    const ds = listed.find((item) => item.id === 'deepseek');
    const google = listed.find((item) => item.id === 'google');
    const custom = listed.find((item) => item.id === CUSTOM_ID);
    assert.equal(ds.kind, 'builtin');
    assert.equal(ds.auth.type, 'api_key');
    assert.equal(ds.auth.keyTail, KEY.slice(-4));
    assert.equal(ds.models.some((item) => item.id === 'deepseek-flash'), true);
    const flash = ds.models.find((item) => item.id === 'deepseek-flash');
    assert.equal(flash.reasoning, true);
    assert.equal(flash.images, true);
    assert.equal(flash.enabled, false);
    assert.deepEqual(flash.thinkingLevels, ['off', 'low', 'high', 'max']);
    assert.equal(flash.defaultThinkingLevel, 'high');
    const pro = ds.models.find((item) => item.id === 'deepseek-v4-pro');
    if (pro) {
      assert.deepEqual(pro.thinkingLevels, ['off', 'high', 'max']);
      assert.equal(pro.defaultThinkingLevel, 'high');
    }

    assert.equal(google.auth.type, 'oauth');

    assert.equal(custom.kind, 'custom');
    assert.equal(custom.api, 'openai-completions');
    assert.equal(custom.baseUrl, 'http://127.0.0.1:9/v1');
    assert.equal(custom.auth.type, 'none');
    const alpha = custom.models.find((item) => item.id === 'alpha');
    assert.equal(alpha.enabled, true);
    assert.equal(alpha.images, true);
    assert.equal(alpha.reasoning, true);
    assert.equal(alpha.contextWindow, 256000);
    assert.deepEqual(alpha.overridden, { contextWindow: true });
    const beta = custom.models.find((item) => item.id === 'beta');
    assert.equal(beta.contextWindow, null);
    assert.equal(beta.enabled, true);
  }, {
    settings: {
      version: 3,
      providers: [
        { id: 'deepseek', kind: 'builtin', enabled: [], overrides: {} },
        { id: 'google', kind: 'builtin', enabled: ['gemini-2.5-pro'], overrides: {} },
        {
          id: CUSTOM_ID,
          kind: 'custom',
          name: 'Local',
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          enabled: ['alpha', 'beta'],
          overrides: { alpha: { contextWindow: 256000 } },
        },
      ],
      defaultModel: null,
    },
  });
});

test('custom models expose thinkingLevels from effort.supported_levels', async () => {
  await withService(async ({ service, modelsStore }) => {
    const parsed = parseFetchedChatModels({
      data: [
        { id: 'thinker', effort: { supported_levels: ['low', 'high', 'max'] } },
        { id: 'plain' },
      ],
    }, { providerId: CUSTOM_ID, api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1' });
    await modelsStore.write(CUSTOM_ID, { models: parsed });
    const listed = await service.listProviders();
    const custom = listed.find((item) => item.id === CUSTOM_ID);
    const thinker = custom.models.find((item) => item.id === 'thinker');
    const plain = custom.models.find((item) => item.id === 'plain');
    assert.equal(thinker.reasoning, true);
    assert.deepEqual(thinker.thinkingLevels, ['off', 'low', 'high', 'max']);
    assert.equal(thinker.defaultThinkingLevel, 'high');
    assert.equal(plain.reasoning, false);
    assert.deepEqual(plain.thinkingLevels, []);
    assert.equal(plain.defaultThinkingLevel, null);
  }, {
    settings: customSettings({ enabled: ['thinker', 'plain'] }),
  });
});

test('listProviders uses env auth when no stored key', async () => {
  await withService(async ({ service }) => {
    const listed = await service.listProviders();
    assert.equal(listed[0].auth.type, 'env');
    assert.equal(listed[0].auth.envVar, 'DEEPSEEK_API_KEY');
  }, {
    env: { DEEPSEEK_API_KEY: 'sk-from-env' },
    settings: {
      version: 3,
      providers: [{ id: 'deepseek', kind: 'builtin', enabled: ['deepseek-chat'], overrides: {} }],
      defaultModel: null,
    },
  });
});

test('default model, patch, remove, and onChange', async () => {
  await withService(async ({ service, credentials, modelsStore, store, changes }) => {
    assert.deepEqual(await service.getDefaultModel(), { providerId: CUSTOM_ID, modelId: 'alpha' });
    await service.setDefaultModel(CUSTOM_ID, 'beta');
    assert.deepEqual(await service.getDefaultModel(), { providerId: CUSTOM_ID, modelId: 'beta' });
    await service.setDefaultModel(CUSTOM_ID, null);
    assert.deepEqual(await service.getDefaultModel(), { providerId: CUSTOM_ID, modelId: 'alpha' });
    assert.equal((await store.getSettings()).defaultModel, null);

    await credentials.modify(CUSTOM_ID, async () => ({ type: 'api_key', key: KEY }));
    await modelsStore.write(CUSTOM_ID, { models: [{ id: 'alpha' }] });

    await service.patchProvider(CUSTOM_ID, {
      name: 'Renamed',
      enabled: ['alpha'],
      overrides: { alpha: { contextWindow: 256000, maxTokens: 4000 } },
      apiKey: 'sk-new-key-1111',
    });
    const listed = await service.listProviders();
    assert.equal(listed[0].name, 'Renamed');
    assert.deepEqual(listed[0].models.find((item) => item.id === 'alpha').overridden, {
      contextWindow: true,
      maxTokens: true,
    });
    assert.equal((await credentials.read(CUSTOM_ID)).key, 'sk-new-key-1111');

    await service.patchProvider(CUSTOM_ID, { overrides: null, apiKey: '' });
    const cleared = await service.listProviders();
    assert.deepEqual(cleared[0].models.find((item) => item.id === 'alpha').overridden, {});
    assert.equal(await credentials.read(CUSTOM_ID), undefined);

    await service.setDefaultModel(CUSTOM_ID, 'alpha');
    await service.removeProvider(CUSTOM_ID);
    assert.deepEqual(await service.listProviders(), []);
    assert.equal(await service.getDefaultModel(), null);
    assert.equal(await credentials.read(CUSTOM_ID), undefined);
    assert.equal(await modelsStore.read(CUSTOM_ID), undefined);
    const saved = await store.getSettings();
    assert.deepEqual(saved.providers, []);
    assert.ok(changes.length >= 4);
  }, { settings: customSettings() });
});

test('resolveTarget, contextWindowFor, hasAvailableModel, and conversation patch', async () => {
  await withService(async ({ service }) => {
    assert.deepEqual(await service.resolveTarget({}), {
      providerId: CUSTOM_ID,
      modelId: 'alpha',
    });
    assert.deepEqual(await service.resolveTarget({
      modelSourceId: CUSTOM_ID,
      modelId: 'beta',
    }), { providerId: CUSTOM_ID, modelId: 'beta' });
    assert.deepEqual(await service.resolveTarget({
      modelSourceId: CUSTOM_ID,
      modelId: 'missing',
    }), { providerId: CUSTOM_ID, modelId: 'alpha' });

    assert.equal(await service.contextWindowFor({}), 256000);
    assert.equal(await service.contextWindowFor({
      modelSourceId: CUSTOM_ID,
      modelId: 'beta',
    }), 128000);

    assert.equal(await service.hasAvailableModel(), true);
    assert.deepEqual(await service.resolveConversationModelPatch({}), { present: false });
    assert.deepEqual(await service.resolveConversationModelPatch({
      modelSourceId: CUSTOM_ID,
      modelId: 'beta',
    }), {
      present: true,
      ok: true,
      value: { modelSourceId: CUSTOM_ID, modelId: 'beta' },
    });
    assert.equal((await service.resolveConversationModelPatch({
      modelSourceId: CUSTOM_ID,
      modelId: 'nope',
    })).ok, false);
    assert.deepEqual(await service.resolveConversationModelPatch({
      modelSourceId: null,
      modelId: null,
    }), { present: true, ok: true, value: { modelSourceId: null, modelId: null } });
  }, {
    settings: customSettings({
      overrides: { alpha: { contextWindow: 256000 } },
    }),
  });
});

test('hasAvailableModel is false when nothing is configured', async () => {
  await withService(async ({ service }) => {
    assert.equal(await service.hasAvailableModel(), false);
    assert.equal(await service.resolveTarget({}), null);
    assert.equal(await service.contextWindowFor({}), null);
  });
});

test('unset or disabled defaultModel falls back to the first enabled model', async () => {
  await withService(async ({ service, store }) => {
    assert.equal((await store.getSettings()).defaultModel, null);
    assert.deepEqual(await service.getDefaultModel(), { providerId: CUSTOM_ID, modelId: 'alpha' });
    assert.deepEqual(await service.resolveTarget({}), { providerId: CUSTOM_ID, modelId: 'alpha' });
    assert.deepEqual(await service.resolveTarget({
      modelSourceId: CUSTOM_ID,
      modelId: 'beta',
    }), { providerId: CUSTOM_ID, modelId: 'beta' });
    assert.equal(await service.hasAvailableModel(), true);
    assert.equal(await service.contextWindowFor({}), 128000);
  }, {
    settings: {
      ...customSettings(),
      defaultModel: null,
    },
  });

  await withService(async ({ service }) => {
    assert.deepEqual(await service.getDefaultModel(), { providerId: CUSTOM_ID, modelId: 'alpha' });
    assert.deepEqual(await service.resolveTarget({}), { providerId: CUSTOM_ID, modelId: 'alpha' });
  }, {
    settings: {
      version: 3,
      providers: [{
        id: CUSTOM_ID,
        kind: 'custom',
        name: 'Local',
        baseUrl: 'http://127.0.0.1:9/v1',
        api: 'openai-completions',
        enabled: ['alpha', 'beta'],
        overrides: {},
      }],
      defaultModel: { providerId: CUSTOM_ID, modelId: 'gone' },
    },
  });

  await withService(async ({ service }) => {
    assert.equal(await service.getDefaultModel(), null);
    assert.equal(await service.resolveTarget({}), null);
    assert.equal(await service.hasAvailableModel(), false);
    assert.equal(await service.contextWindowFor({}), null);
  }, {
    settings: {
      version: 3,
      providers: [{
        id: CUSTOM_ID,
        kind: 'custom',
        name: 'Local',
        baseUrl: 'http://127.0.0.1:9/v1',
        api: 'openai-completions',
        enabled: [],
        overrides: {},
      }],
      defaultModel: null,
    },
  });
});

test('seedFromEnv writes one custom provider when settings are empty', async () => {
  await withService(async ({ service, credentials, store }) => {
    const seeded = await service.seedFromEnv({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: KEY,
      model: 'local-model',
    });
    assert.match(seeded.id, /^custom-[0-9a-f]{8}$/);
    const settings = await store.getSettings();
    assert.equal(settings.providers.length, 1);
    assert.deepEqual(settings.defaultModel, { providerId: seeded.id, modelId: 'local-model' });
    assert.equal((await credentials.read(seeded.id)).key, KEY);
    assert.equal(await service.seedFromEnv({
      baseUrl: 'http://127.0.0.1:10/v1',
      apiKey: 'other',
      model: 'x',
    }), null);
  });
});

const SECRET = 'sk-never-leak-this-key-42';

function deepseekFake(onCall) {
  return fakeKeyProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    models: ['deepseek-chat', 'deepseek-flash'],
    envVar: 'DEEPSEEK_API_KEY',
    onCall,
  });
}

test('connectApiKey verifies then saves; failure does not persist the key', async () => {
  let allow = false;
  await withService(async ({ service, credentials, store, changes }) => {
    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args) => { logs.push(args.map(String).join(' ')); };
    try {
      await assert.rejects(
        () => service.connectApiKey('deepseek', SECRET),
        (err) => {
          assert.equal(err.code, 'E_AUTH');
          assert.equal(String(err.message).includes(SECRET), false);
          return true;
        },
      );
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.equal(await credentials.read('deepseek'), undefined);
    assert.deepEqual((await store.getSettings()).providers, []);
    const dumped = JSON.stringify({ logs, settings: await store.getSettings() });
    assert.equal(dumped.includes(SECRET), false);

    allow = true;
    const saved = await service.connectApiKey('deepseek', SECRET);
    assert.equal(saved.id, 'deepseek');
    assert.equal(saved.auth.type, 'api_key');
    assert.equal(saved.auth.keyTail, SECRET.slice(-4));
    assert.equal(saved.status.state, 'ok');
    assert.equal(typeof saved.status.testedAt, 'number');
    assert.deepEqual(saved.models.filter((item) => item.enabled).map((item) => item.id), [
      'deepseek-chat',
      'deepseek-flash',
    ]);
    assert.equal((await credentials.read('deepseek')).key, SECRET);
    assert.ok(changes.length >= 1);
    assert.equal(JSON.stringify(saved).includes(SECRET), false);
  }, {
    extraProviders: [deepseekFake(() => (allow
      ? { ok: true }
      : { ok: false, status: 401, errorMessage: 'invalid api key' }))],
  });
});

test('connectEnv uses the process env and does not store a key', async () => {
  await withService(async ({ service, credentials }) => {
    const saved = await service.connectEnv('deepseek');
    assert.equal(saved.auth.type, 'env');
    assert.equal(saved.auth.envVar, 'DEEPSEEK_API_KEY');
    assert.equal(saved.status.state, 'ok');
    assert.equal(await credentials.read('deepseek'), undefined);
  }, {
    env: { DEEPSEEK_API_KEY: 'sk-from-env-value' },
    extraProviders: [deepseekFake()],
  });
});

test('connectEnv fails when the env var is missing', async () => {
  await withService(async ({ service, store }) => {
    await assert.rejects(() => service.connectEnv('deepseek'), (err) => {
      assert.equal(err.code, 'E_BAD_REQUEST');
      assert.equal(err.phrase, 'src_err_env');
      return true;
    });
    assert.deepEqual((await store.getSettings()).providers, []);
  }, { extraProviders: [deepseekFake()] });
});

test('new builtin with more than 6 models enables none', async () => {
  const models = Array.from({ length: 7 }, (_, i) => `m${i}`);
  await withService(async ({ service }) => {
    const saved = await service.connectApiKey('groq', 'sk-ok-123456');
    assert.deepEqual(saved.models.filter((item) => item.enabled), []);
    assert.equal(saved.models.length, 7);
  }, {
    extraProviders: [fakeKeyProvider({ id: 'groq', name: 'Groq', models })],
  });
});

test('OAuth session: notify, prompt, answer, done', async () => {
  await withService(async ({ service, credentials }) => {
    const started = await service.startOAuth('google');
    assert.ok(['pending', 'prompt'].includes(started.state));
    assert.equal(started.providerId, 'google');

    const prompted = await waitUntil(async () => {
      const session = service.getSession(started.id);
      return session.state === 'prompt' ? session : null;
    });
    assert.equal(prompted.prompt.type, 'manual_code');
    assert.deepEqual(prompted.events.map((item) => item.type), ['auth_url', 'device_code', 'info']);
    assert.equal(prompted.events[0].url, 'https://example.test/auth');
    assert.equal(prompted.events[1].userCode, 'ABCD-1234');

    const answered = await service.answerSession(started.id, 'user-code');
    assert.ok(['pending', 'done', 'prompt'].includes(answered.state));

    const done = await waitUntil(async () => {
      const session = service.getSession(started.id);
      return session.state === 'done' ? session : null;
    });
    assert.equal(done.provider.id, 'google');
    assert.equal(done.provider.auth.type, 'oauth');
    assert.equal(done.provider.auth.account, 'tester@example.test');
    assert.equal((await credentials.read('google')).type, 'oauth');
  }, { extraProviders: [fakeOAuthProvider({ id: 'google', name: 'Google' })] });
});

test('OAuth cancel aborts the in-flight session', async () => {
  await withService(async ({ service, store }) => {
    const started = await service.startOAuth('google');
    await waitUntil(async () => service.getSession(started.id).state === 'prompt');
    const cancelled = await service.cancelSession(started.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.deepEqual((await store.getSettings()).providers, []);
  }, { extraProviders: [fakeOAuthProvider({ id: 'google', name: 'Google' })] });
});

test('OAuth expire marks the session error', async () => {
  let now = 1_000;
  await withService(async ({ service }) => {
    const started = await service.startOAuth('google');
    await waitUntil(async () => service.getSession(started.id).state === 'prompt');
    now = 1_000 + 60_000;
    const expired = service.getSession(started.id);
    assert.equal(expired.state, 'error');
    assert.equal(expired.errorPhrase, 'src_err_expired');
  }, {
    extraProviders: [fakeOAuthProvider({ id: 'google', name: 'Google' })],
    now: () => now,
    loginTtlMs: 10_000,
  });
});

test('starting a second OAuth session cancels the first', async () => {
  await withService(async ({ service }) => {
    const first = await service.startOAuth('google');
    await waitUntil(async () => service.getSession(first.id).state === 'prompt');
    const second = await service.startOAuth('google');
    assert.notEqual(second.id, first.id);
    assert.equal(service.getSession(first.id).state, 'cancelled');
    await service.cancelSession(second.id);
  }, { extraProviders: [fakeOAuthProvider({ id: 'google', name: 'Google' })] });
});

test('addCustom fetches /models then saves; failure does not save', async () => {
  await withService(async ({ service, store, credentials }) => {
    await assert.rejects(() => service.addCustom({
      name: 'Local',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      apiKey: SECRET,
    }), (err) => {
      assert.equal(err.code, 'E_AUTH');
      assert.equal(String(err.message).includes(SECRET), false);
      return true;
    });
    assert.deepEqual((await store.getSettings()).providers, []);
    assert.equal((await credentials.list()).length, 0);
  }, {
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'unauthorized' }),
    }),
  });

  await withService(async ({ service, credentials, modelsStore }) => {
    const created = await service.addCustom({
      name: 'Local',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      apiKey: 'sk-custom-ok',
    });
    assert.match(created.id, /^custom-[0-9a-f]{8}$/);
    assert.equal(created.kind, 'custom');
    assert.equal(created.name, 'Local');
    assert.equal(created.models.length, 2);
    assert.equal(created.models.every((item) => item.enabled), true);
    assert.equal(created.status.state, 'ok');
    assert.equal((await credentials.read(created.id)).key, 'sk-custom-ok');
    assert.equal((await modelsStore.read(created.id)).models.length, 2);
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta' }] }),
    }),
  });
});

test('testProvider writes lastTest ok or error', async () => {
  let fail = false;
  await withService(async ({ service }) => {
    await service.connectApiKey('deepseek', 'sk-ok-123456');
    const ok = await service.testProvider('deepseek');
    assert.equal(ok.status.state, 'ok');
    fail = true;
    await assert.rejects(() => service.testProvider('deepseek'), (err) => {
      assert.equal(err.code, 'E_NETWORK');
      return true;
    });
    const listed = await service.listProviders();
    assert.equal(listed[0].status.state, 'error');
  }, {
    extraProviders: [deepseekFake(() => (fail
      ? { ok: false, status: 0, errorMessage: 'fetch failed' }
      : { ok: true }))],
  });
});

test('listAvailable sorts popular first, excludes blocked ids, and marks connected', async () => {
  await withService(async ({ service }) => {
    const listed = await service.listAvailable();
    const ids = listed.map((item) => item.id);
    for (const blocked of EXCLUDED_PROVIDER_IDS) {
      assert.equal(ids.includes(blocked), false, blocked);
    }
    const popular = listed.filter((item) => item.popular).map((item) => item.id);
    const expectedPopular = POPULAR_PROVIDER_IDS.filter((id) => ids.includes(id));
    assert.deepEqual(popular, expectedPopular);
    assert.deepEqual(listed.slice(0, popular.length).map((item) => item.id), popular);
    const rest = listed.filter((item) => !item.popular);
    const restNames = rest.map((item) => item.name);
    assert.deepEqual(restNames, [...restNames].sort((a, b) => a.localeCompare(b, 'zh-CN')));
    const ds = listed.find((item) => item.id === 'deepseek');
    assert.equal(ds.connected, false);
    assert.equal(ds.envVar, 'DEEPSEEK_API_KEY');
    assert.equal(ds.envDetected, false);
  });

  await withService(async ({ service }) => {
    const listed = await service.listAvailable();
    const ds = listed.find((item) => item.id === 'deepseek');
    assert.equal(ds.connected, true);
    assert.equal(ds.envDetected, true);
  }, {
    env: { DEEPSEEK_API_KEY: 'sk-env' },
    settings: {
      version: 3,
      providers: [{ id: 'deepseek', kind: 'builtin', enabled: ['deepseek-chat'], overrides: {} }],
      defaultModel: null,
    },
  });
});

test('patch defaultModel and DELETE clear credentials and the default', async () => {
  await withService(async ({ service, credentials, store }) => {
    await service.connectApiKey('deepseek', 'sk-ok-123456');
    await service.patchProvider('deepseek', { defaultModel: 'deepseek-chat' });
    assert.deepEqual(await service.getDefaultModel(), {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
    });
    await service.patchProvider('deepseek', {
      enabled: ['deepseek-chat'],
      overrides: { 'deepseek-chat': { contextWindow: 64000 } },
    });
    const patched = (await service.listProviders())[0];
    assert.equal(patched.models.find((item) => item.id === 'deepseek-chat').enabled, true);
    assert.equal(patched.models.find((item) => item.id === 'deepseek-chat').overridden.contextWindow, true);

    await service.patchProvider('deepseek', {
      overrides: { 'deepseek-chat': { contextWindow: null } },
      defaultModel: null,
    });
    const cleared = (await service.listProviders())[0];
    assert.deepEqual(cleared.models.find((item) => item.id === 'deepseek-chat').overridden, {});
    assert.deepEqual(await service.getDefaultModel(), {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
    });
    assert.equal((await store.getSettings()).defaultModel, null);

    await service.patchProvider('deepseek', { defaultModel: 'deepseek-chat' });
    await service.removeProvider('deepseek');
    assert.deepEqual(await service.listProviders(), []);
    assert.equal(await credentials.read('deepseek'), undefined);
    assert.equal(await service.getDefaultModel(), null);
    assert.deepEqual((await store.getSettings()).providers, []);
  }, { extraProviders: [deepseekFake()] });
});

test('listAvailable includes xai as Grok oauth-only, drops oauth elsewhere, excludes copilot', async () => {
  await withService(async ({ service }) => {
    const listed = await service.listAvailable();
    const ids = listed.map((item) => item.id);
    assert.equal(ids.includes('xai'), true);
    assert.equal(ids.includes('github-copilot'), false);
    assert.equal(EXCLUDED_PROVIDER_IDS.has('xai'), false);
    const xai = listed.find((item) => item.id === 'xai');
    assert.equal(xai.name, 'Grok');
    assert.deepEqual(xai.authMethods, ['oauth']);
    assert.equal(xai.localLogin.detected, false);
    assert.equal('account' in xai.localLogin, false);
    const dumped = JSON.stringify(xai);
    assert.equal(dumped.includes('refresh_token'), false);
    assert.equal(/"access"/.test(dumped), false);
    const anthropic = listed.find((item) => item.id === 'anthropic');
    assert.ok(anthropic);
    assert.deepEqual(anthropic.authMethods, ['api_key']);
    const openai = listed.find((item) => item.id === 'openai');
    assert.deepEqual(openai.authMethods, ['api_key']);
    for (const item of listed) {
      if (item.id === 'xai') continue;
      assert.equal(item.authMethods.includes('oauth'), false, item.id);
      assert.equal(item.authMethods.length > 0, true, item.id);
    }
  });
});

function writeGrokAuth(home, entry) {
  mkdirSync(path.join(home, '.grok'), { recursive: true });
  writeFileSync(path.join(home, '.grok', 'auth.json'), JSON.stringify({
    'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': entry,
  }), 'utf8');
}

test('listAvailable localLogin detects Grok CLI auth and never returns tokens', async () => {
  const access = 'access-fixture-list';
  const refresh = 'refresh-fixture-list';
  const home = await makeTempDir('weft-grok-home-');
  try {
    writeGrokAuth(home, {
      key: access,
      refresh_token: refresh,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      email: 'lawrence@x.com',
    });
    await withService(async ({ service }) => {
      const listed = await service.listAvailable();
      const xai = listed.find((item) => item.id === 'xai');
      assert.equal(xai.localLogin.detected, true);
      assert.equal(xai.localLogin.account, 'lawrence@x.com');
      const dumped = JSON.stringify(listed);
      assert.equal(dumped.includes(access), false);
      assert.equal(dumped.includes(refresh), false);
      assert.equal('credential' in xai.localLogin, false);
      assert.equal('key' in xai.localLogin, false);
      assert.equal('access' in xai.localLogin, false);
    }, { env: { GROK_HOME: home } });
  } finally {
    await removeTempDir(home);
  }
});

test('listAvailable localLogin is false when auth.json is missing or malformed', async () => {
  const home = await makeTempDir('weft-grok-bad-');
  try {
    await withService(async ({ service }) => {
      const xai = (await service.listAvailable()).find((item) => item.id === 'xai');
      assert.deepEqual(xai.localLogin, { detected: false });
    }, { env: { GROK_HOME: home } });

    mkdirSync(path.join(home, '.grok'), { recursive: true });
    writeFileSync(path.join(home, '.grok', 'auth.json'), '{not-json', 'utf8');
    await withService(async ({ service }) => {
      const xai = (await service.listAvailable()).find((item) => item.id === 'xai');
      assert.equal(xai.localLogin.detected, false);
    }, { env: { GROK_HOME: home } });

    writeGrokAuth(home, { email: 'nobody@x.com' });
    await withService(async ({ service }) => {
      const xai = (await service.listAvailable()).find((item) => item.id === 'xai');
      assert.equal(xai.localLogin.detected, false);
    }, { env: { GROK_HOME: home } });
  } finally {
    await removeTempDir(home);
  }
});

test('connectLocalLogin imports Grok CLI oauth creds and probes', async () => {
  const access = 'access-fixture-connect';
  const refresh = 'refresh-fixture-connect';
  const home = await makeTempDir('weft-grok-connect-');
  try {
    writeGrokAuth(home, {
      key: access,
      refresh_token: refresh,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      email: 'tester@x.com',
    });
    await withService(async ({ service, credentials }) => {
      const saved = await service.connectLocalLogin('xai');
      assert.equal(saved.id, 'xai');
      assert.equal(saved.auth.type, 'oauth');
      assert.equal(saved.auth.account, 'tester@x.com');
      const dumped = JSON.stringify(saved);
      assert.equal(dumped.includes(access), false);
      assert.equal(dumped.includes(refresh), false);
      const cred = await credentials.read('xai');
      assert.equal(cred.type, 'oauth');
      assert.equal(cred.access, access);
      assert.equal(cred.refresh, refresh);
    }, {
      env: { GROK_HOME: home },
      extraProviders: [fakeOAuthProvider({ id: 'xai', name: 'Grok', models: ['grok-3'] })],
    });
  } finally {
    await removeTempDir(home);
  }
});

test('connectLocalLogin rejects non-xai and missing local login', async () => {
  await withService(async ({ service }) => {
    await assert.rejects(() => service.connectLocalLogin('anthropic'), (err) => {
      assert.equal(err.code, 'E_BAD_REQUEST');
      return true;
    });
    await assert.rejects(() => service.connectLocalLogin('xai'), (err) => {
      assert.equal(err.code, 'E_BAD_REQUEST');
      assert.equal(err.phrase, 'src_err_local_login');
      return true;
    });
  }, {
    extraProviders: [fakeOAuthProvider({ id: 'xai', name: 'Grok', models: ['grok-3'] })],
  });
});

test('patchProvider can rename a builtin provider', async () => {
  await withService(async ({ service }) => {
    await service.connectApiKey('deepseek', 'sk-ok-123456');
    await service.patchProvider('deepseek', { name: 'My DeepSeek' });
    const listed = await service.listProviders();
    assert.equal(listed[0].name, 'My DeepSeek');
    assert.equal(listed[0].nameCustom, true);
  }, { extraProviders: [deepseekFake()] });
});


