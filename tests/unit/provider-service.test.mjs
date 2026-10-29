import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore, createModelsStore } from '../../src/core/provider-stores.mjs';
import { createProviderService } from '../../src/core/provider-service.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const CUSTOM_ID = 'custom-aaaaaaaa';
const KEY = 'sk-service-secret-9999';

async function withService(fn, { env = {}, settings } = {}) {
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
      env,
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
    assert.deepEqual(alpha.overridden, { contextWindow: 256000 });
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
    assert.equal(await service.getDefaultModel(), null);

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
      contextWindow: 256000,
      maxTokens: 4000,
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
