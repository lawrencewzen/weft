import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { APP_DB_FILE, createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore } from '../../src/core/provider-stores.mjs';
import {
  migrateAppSettingsToV3,
  SETTINGS_V2_BACKUP_ID,
} from '../../src/core/provider-migrate.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-provider-migrate-token';
const DS_KEY = 'sk-deepseek-secret-aaaa';
const GEM_KEY = 'sk-gemini-secret-bbbb';
const ZHIPU_KEY = 'sk-zhipu-secret-cccc';

function v2Settings() {
  return {
    version: 2,
    language: 'zh',
    theme: 'white',
    appearance: 'light',
    leftover: 'keep-me',
    sources: [
      {
        id: 'src-ds',
        kind: 'api',
        vendor: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: DS_KEY,
        models: ['deepseek-chat'],
        contextWindows: { 'deepseek-chat': 64000 },
      },
      {
        id: 'src-gem',
        kind: 'api',
        vendor: 'gemini',
        name: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: GEM_KEY,
        models: ['gemini-2.5-pro'],
      },
      {
        id: 'src-zhipu',
        kind: 'api',
        vendor: 'zhipu',
        name: '智谱',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: ZHIPU_KEY,
        models: ['glm-4'],
      },
      {
        id: 'grok',
        kind: 'grok',
        vendor: 'grok',
        name: 'Grok 订阅',
        baseUrl: '',
        apiKey: '',
        models: ['grok-build'],
      },
    ],
    models: { default: { sourceId: 'src-ds', model: 'deepseek-chat' } },
  };
}

async function withStore(fn) {
  const dir = await makeTempDir('weft-migrate-');
  const store = createSqliteStore(dir);
  try {
    return await fn(store, dir);
  } finally {
    try { store.close(); } catch { /* closed by fn */ }
    await removeTempDir(dir);
  }
}

function readRaw(dir, id) {
  const db = new DatabaseSync(path.join(dir, APP_DB_FILE));
  const row = db.prepare('SELECT json FROM settings WHERE id = ?').get(id);
  db.close();
  return row ? JSON.parse(row.json) : null;
}

test('v2 settings migrate to v3 with credentials, remapped conversations, and a backup', async () => {
  await withStore(async (store, dir) => {
    const ws = await store.createWorkspace({ name: 'w', path: dir });
    const bound = await store.createConversation({
      workspaceId: ws.id,
      title: 'ds',
      modelSourceId: 'src-ds',
      modelId: 'deepseek-chat',
    });
    const dropped = await store.createConversation({
      workspaceId: ws.id,
      title: 'grok',
      modelSourceId: 'grok',
      modelId: 'grok-build',
    });
    await store.putSettingsRaw('app', v2Settings());

    const first = await migrateAppSettingsToV3(store);
    assert.equal(first.migrated, true);

    const settings = await store.getSettings();
    assert.equal(settings.version, 3);
    assert.equal(settings.leftover, 'keep-me');
    assert.equal(settings.sources, undefined);
    assert.equal(settings.apiKey, undefined);
    assert.deepEqual(settings.defaultModel, { providerId: 'deepseek', modelId: 'deepseek-chat' });
    const byId = Object.fromEntries(settings.providers.map((item) => [item.id, item]));
    assert.equal(byId.deepseek.kind, 'builtin');
    assert.deepEqual(byId.deepseek.enabled, ['deepseek-chat']);
    assert.equal(byId.deepseek.overrides['deepseek-chat'].contextWindow, 64000);
    assert.equal(byId.google.kind, 'builtin');
    const zhipu = settings.providers.find((item) => item.kind === 'custom');
    assert.ok(zhipu);
    assert.match(zhipu.id, /^custom-[0-9a-f]{8}$/);
    assert.equal(zhipu.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(settings.providers.some((item) => item.id === 'grok'), false);

    const raw = JSON.stringify(await store.getSettingsRaw('app'));
    assert.equal(raw.includes(DS_KEY), false);
    assert.equal(raw.includes(GEM_KEY), false);
    assert.equal(raw.includes(ZHIPU_KEY), false);

    const creds = createCredentialStore(store);
    assert.equal((await creds.read('deepseek')).key, DS_KEY);
    assert.equal((await creds.read('google')).key, GEM_KEY);
    assert.equal((await creds.read(zhipu.id)).key, ZHIPU_KEY);

    const backup = await store.getSettingsRaw(SETTINGS_V2_BACKUP_ID);
    assert.equal(backup.version, 2);
    assert.equal(backup.sources[0].apiKey, DS_KEY);

    const liveBound = await store.getConversation(bound.id);
    assert.equal(liveBound.modelSourceId, 'deepseek');
    assert.equal(liveBound.modelId, 'deepseek-chat');
    const liveDropped = await store.getConversation(dropped.id);
    assert.equal(liveDropped.modelSourceId, null);
    assert.equal(liveDropped.modelId, null);

    const second = await migrateAppSettingsToV3(store);
    assert.equal(second.migrated, false);
    const again = await store.getSettings();
    assert.deepEqual(again.providers, settings.providers);
    assert.deepEqual(again.defaultModel, settings.defaultModel);
    const backupAgain = await store.getSettingsRaw(SETTINGS_V2_BACKUP_ID);
    assert.deepEqual(backupAgain, backup);
  });
});

test('existing v2 backup is kept and a failed migrate does not write v3', async () => {
  await withStore(async (store) => {
    const marker = { version: 2, sources: [], marker: 'keep-backup' };
    await store.putSettingsRaw(SETTINGS_V2_BACKUP_ID, marker);
    await store.putSettingsRaw('app', v2Settings());
    const first = await migrateAppSettingsToV3(store);
    assert.equal(first.migrated, true);
    const backup = await store.getSettingsRaw(SETTINGS_V2_BACKUP_ID);
    assert.equal(backup.marker, 'keep-backup');
  });

  await withStore(async (store) => {
    await store.putSettingsRaw('app', v2Settings());
    const logs = [];
    const result = await migrateAppSettingsToV3(store, {
      log: { error(line) { logs.push(String(line)); } },
      credentials: {
        modify() { throw new Error('credential write failed'); },
      },
    });
    assert.equal(result.migrated, false);
    assert.ok(result.error);
    assert.match(logs.join('\n'), /WEFT_SETTINGS_MIGRATE_V3/);
    const raw = await store.getSettingsRaw('app');
    assert.equal(raw.version, 2);
    assert.equal(await store.getSettingsRaw(SETTINGS_V2_BACKUP_ID), null);
    assert.equal(await store.getProviderCredential('deepseek'), undefined);
  });
});

test('starting the server migrates a real v2 row and a second boot is a no-op', async () => {
  const dir = await makeTempDir('weft-migrate-boot-');
  const store = createSqliteStore(dir);
  const ws = await store.createWorkspace({ name: 'w', path: dir });
  await store.createConversation({
    workspaceId: ws.id,
    title: 'ds',
    modelSourceId: 'src-ds',
    modelId: 'deepseek-chat',
  });
  await store.createConversation({
    workspaceId: ws.id,
    title: 'grok',
    modelSourceId: 'grok',
    modelId: 'grok-build',
  });
  await store.putSettingsRaw('app', v2Settings());
  store.close();

  const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);
  let srv = await startServer({ token: TOKEN, dataDir: dir, env: { WEFT_LLM: 'faux' } });
  try {
    const got = await request(srv.base, 'GET', '/api/settings');
    assert.equal(got.status, 200, got.text);
    assert.equal(got.body.version, 3);
    assert.equal(got.body.sources, undefined);
    assert.equal(got.body.apiKey, undefined);
    assert.equal(JSON.stringify(got.body).includes(DS_KEY), false);
    assert.deepEqual(got.body.defaultModel, { providerId: 'deepseek', modelId: 'deepseek-chat' });
    assert.equal(got.body.providers.some((item) => item.id === 'deepseek'), true);
    await stopServer(srv);
    srv = null;

    const backup = readRaw(dir, SETTINGS_V2_BACKUP_ID);
    assert.equal(backup.version, 2);
    const v3 = readRaw(dir, 'app');
    const snapshot = JSON.stringify(v3);
    srv = await startServer({ token: TOKEN, dataDir: dir, env: { WEFT_LLM: 'faux' } });
    const again = await request(srv.base, 'GET', '/api/settings');
    assert.equal(again.status, 200);
    assert.equal(again.body.version, 3);
    assert.deepEqual(readRaw(dir, 'app'), v3);
    assert.equal(JSON.stringify(readRaw(dir, 'app')), snapshot);
  } finally {
    await stopServer(srv);
    await removeTempDir(dir);
  }
});
