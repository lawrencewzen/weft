import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import {
  attachProvidersTopic,
  entitiesFromSnapshot,
  PROVIDERS_TOPIC,
} from '../../src/v2/stream/providers-topic.ts';
import { providersSnapshotFrom } from '../../src/v2/views/providers.ts';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore, createModelsStore } from '../../src/core/provider-stores.mjs';
import { createProviderService } from '../../src/core/provider-service.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';
import { fakeKeyProvider } from './provider-fakes.mjs';

function collectFrames() {
  const frames = [];
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  return {
    hub,
    frames,
    connect() {
      return hub.connect({
        topics: [PROVIDERS_TOPIC],
        send: (frame) => frames.push(frame),
      });
    },
  };
}

test('entitiesFromSnapshot emits provider rows and defaults/self', () => {
  const snap = providersSnapshotFrom({
    providers: [{
      id: 'deepseek',
      kind: 'builtin',
      name: 'DeepSeek',
      auth: { type: 'api_key', keyTail: '9999' },
      lastTest: { ok: true, at: 1_700_000_000_000 },
      models: [{
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        enabled: true,
        contextWindow: 8000,
        maxTokens: 2000,
        images: false,
        reasoning: false,
        overridden: {},
      }],
    }],
    defaultModel: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  }, 'zh');
  const entities = entitiesFromSnapshot(snap);
  assert.equal(entities.some((item) => item.entity === 'provider' && item.id === 'deepseek'), true);
  const defaults = entities.find((item) => item.entity === 'defaults' && item.id === 'self');
  assert.deepEqual(defaults.value, {
    model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  });
});

test('providers topic upserts after connect and removes after delete', async () => {
  const dir = await makeTempDir('weft-providers-topic-');
  const store = createSqliteStore(dir);
  const credentials = createCredentialStore(store);
  const modelsStore = createModelsStore(store);
  const { hub, frames, connect } = collectFrames();
  let topic;
  const service = createProviderService({
    store,
    credentials,
    modelsStore,
    extraProviders: [fakeKeyProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      models: ['deepseek-chat'],
      envVar: 'DEEPSEEK_API_KEY',
    })],
    onChange() { topic?.notify(); },
  });
  topic = attachProvidersTopic(hub, {
    loader: {
      listProviders: () => service.listProviders(),
      getDefaultModel: () => service.getDefaultModel(),
    },
  });
  try {
    const session = connect();
    await session.ready;
    assert.equal(frames[0]?.event, 'snapshot');

    await service.connectApiKey('deepseek', 'sk-ok-123456');
    await service.patchProvider('deepseek', { defaultModel: 'deepseek-chat' });
    const upsertAt = Date.now();
    while (Date.now() - upsertAt < 2_000) {
      const upserts = frames.filter((item) => item.event === 'upsert');
      if (
        upserts.some((item) => item.data.entity === 'provider' && item.data.id === 'deepseek')
        && upserts.some((item) => item.data.entity === 'defaults' && item.data.id === 'self')
      ) break;
      await sleep(20);
    }
    const upserts = frames.filter((item) => item.event === 'upsert');
    assert.equal(upserts.some((item) => item.data.entity === 'provider' && item.data.id === 'deepseek'), true);
    assert.equal(upserts.some((item) => item.data.entity === 'defaults' && item.data.id === 'self'), true);
    const providerFrame = [...upserts].reverse().find((item) => item.data.entity === 'provider');
    assert.equal(JSON.stringify(providerFrame.data.value).includes('sk-ok-123456'), false);

    await service.removeProvider('deepseek');
    const rmAt = Date.now();
    while (Date.now() - rmAt < 2_000) {
      if (frames.some((item) => item.event === 'remove' && item.data.entity === 'provider' && item.data.id === 'deepseek')) {
        break;
      }
      await sleep(20);
    }
    assert.equal(frames.some((item) => item.event === 'remove' && item.data.entity === 'provider' && item.data.id === 'deepseek'), true);
    session.close();
  } finally {
    topic.dispose();
    hub.dispose();
    store.close();
    await removeTempDir(dir);
  }
});
