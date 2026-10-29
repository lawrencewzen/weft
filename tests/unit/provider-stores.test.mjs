import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { APP_DB_FILE, createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore, createModelsStore } from '../../src/core/provider-stores.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const SECRET = 'sk-unit-store-secret';

async function withStore(fn) {
  const dir = await makeTempDir('weft-provider-stores-');
  const store = createSqliteStore(dir);
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    await removeTempDir(dir);
  }
}

function aborted() {
  const signal = AbortSignal.abort();
  return { signal };
}

test('old sqlite gains provider tables without touching settings', async () => {
  const dir = await makeTempDir('weft-provider-old-db-');
  const dbPath = path.join(dir, APP_DB_FILE);
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE settings (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (7);
      INSERT INTO settings (id, json) VALUES ('app', '{"version":2,"language":"en","sources":[],"models":{}}');
    `);
    db.close();

    const store = createSqliteStore(dir);
    try {
      const settings = await store.getSettings();
      assert.equal(settings.language, 'en');
      assert.equal(settings.version, 2);
      assert.deepEqual(settings.sources, []);

      await store.putProviderCredential('deepseek', { type: 'api_key', key: SECRET });
      await store.putProviderModels('deepseek', { models: [{ id: 'deepseek-chat' }], etag: '"e1"' });
      const cred = await store.getProviderCredential('deepseek');
      const models = await store.getProviderModels('deepseek');
      assert.equal(cred.type, 'api_key');
      assert.equal(cred.key, SECRET);
      assert.equal(models.etag, '"e1"');
    } finally {
      store.close();
    }

    const check = new DatabaseSync(dbPath);
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    check.close();
    assert.ok(tables.includes('provider_credentials'));
    assert.ok(tables.includes('provider_models'));
    assert.ok(tables.includes('settings'));
  } finally {
    await removeTempDir(dir);
  }
});

test('CredentialStore read/write/delete and list omits secrets', async () => {
  await withStore(async (store) => {
    const creds = createCredentialStore(store);
    assert.equal(await creds.read('p1'), undefined);

    await creds.modify('p1', async () => ({ type: 'api_key', key: SECRET, env: { X: '1' } }));
    const got = await creds.read('p1');
    assert.equal(got.type, 'api_key');
    assert.equal(got.key, SECRET);
    assert.equal(got.env.X, '1');

    const listed = await creds.list();
    assert.deepEqual(listed, [{ providerId: 'p1', type: 'api_key' }]);
    assert.equal(Object.keys(listed[0]).sort().join(','), 'providerId,type');
    assert.equal(JSON.stringify(listed).includes(SECRET), false);

    await creds.delete('p1');
    assert.equal(await creds.read('p1'), undefined);
    assert.deepEqual(await creds.list(), []);
  });
});

test('CredentialStore modify serializes concurrent writes', async () => {
  await withStore(async (store) => {
    const creds = createCredentialStore(store);
    await creds.modify('p1', async () => ({ type: 'api_key', key: '0' }));
    await Promise.all([
      creds.modify('p1', async (current) => {
        const n = Number(current.key);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { type: 'api_key', key: String(n + 1) };
      }),
      creds.modify('p1', async (current) => {
        const n = Number(current.key);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { type: 'api_key', key: String(n + 1) };
      }),
    ]);
    const got = await creds.read('p1');
    assert.equal(got.key, '2');
  });
});

test('CredentialStore modify undefined leaves the row (pi-ai InMemoryCredentialStore)', async () => {
  await withStore(async (store) => {
    const creds = createCredentialStore(store);
    await creds.modify('p1', async () => ({ type: 'api_key', key: SECRET }));
    const after = await creds.modify('p1', async () => undefined);
    assert.equal(after.key, SECRET);
    const got = await creds.read('p1');
    assert.equal(got.key, SECRET);
  });
});

test('CredentialStore and ModelsStore honor an already-aborted signal', async () => {
  await withStore(async (store) => {
    const creds = createCredentialStore(store);
    const models = createModelsStore(store);
    const opts = aborted();
    await assert.rejects(() => creds.read('p1', opts));
    await assert.rejects(() => creds.list(opts));
    await assert.rejects(() => creds.modify('p1', async () => ({ type: 'api_key', key: 'x' }), opts));
    await assert.rejects(() => creds.delete('p1', opts));
    await assert.rejects(() => models.read('p1', opts));
    await assert.rejects(() => models.write('p1', { models: [] }, opts));
    await assert.rejects(() => models.delete('p1', opts));
  });
});

test('ModelsStore read/write/delete', async () => {
  await withStore(async (store) => {
    const models = createModelsStore(store);
    assert.equal(await models.read('p1'), undefined);
    const entry = {
      models: [{ id: 'm1', name: 'M1' }],
      lastModified: 1,
      checkedAt: 2,
      etag: '"abc"',
    };
    await models.write('p1', entry);
    const got = await models.read('p1');
    assert.deepEqual(got, entry);
    got.models = [];
    const again = await models.read('p1');
    assert.equal(again.models[0].id, 'm1');
    await models.delete('p1');
    assert.equal(await models.read('p1'), undefined);
  });
});

test('createModels login persists api_key and getAuth reads it', async () => {
  await withStore(async (store) => {
    const credentials = createCredentialStore(store);
    const modelsStore = createModelsStore(store);
    const models = createModels({ credentials, modelsStore });
    models.setProvider(createProvider({
      id: 'weft-fake',
      name: 'Fake',
      auth: {
        apiKey: {
          name: 'Fake key',
          async login(interaction) {
            const key = await interaction.prompt({ type: 'secret', message: 'Enter key' });
            return { type: 'api_key', key };
          },
          async resolve({ credential }) {
            if (credential?.key) return { auth: { apiKey: credential.key }, source: 'stored credential' };
            return undefined;
          },
        },
      },
      models: [{
        id: 'fake-1',
        name: 'Fake 1',
        api: 'openai-completions',
        provider: 'weft-fake',
        baseUrl: 'http://127.0.0.1:9/v1',
        reasoning: Boolean(0),
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8000,
        maxTokens: 2000,
      }],
      api: {
        stream() { throw new Error('stream unused'); },
        streamSimple() { throw new Error('streamSimple unused'); },
      },
    }));

    const credential = await models.login('weft-fake', 'api_key', {
      prompt: async () => SECRET,
      notify() {},
    });
    assert.equal(credential.type, 'api_key');
    assert.equal(credential.key, SECRET);

    const auth = await models.getAuth('weft-fake');
    assert.equal(auth.auth.apiKey, SECRET);
    assert.equal(auth.source, 'stored credential');

    const listed = await credentials.list();
    assert.deepEqual(listed, [{ providerId: 'weft-fake', type: 'api_key' }]);
    assert.equal(JSON.stringify(listed).includes(SECRET), false);
  });
});
