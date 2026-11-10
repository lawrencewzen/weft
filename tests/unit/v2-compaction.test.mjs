import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { validateResponse } from '../../src/v2/validate.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import { attachConversationTopic } from '../../src/v2/stream/conversation-topic.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { projectViewUpdate, createViewProjector, createMapContext } from '../../src/kernel/events.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const TOKEN = 'v2-compaction-token';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function v2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

test('settings trigger percent persists, rejects illegal values, and compact is admitted', { timeout: 40_000 }, async () => {
  const dataDir = await makeTempDir('weft-compact-http-');
  const seed = createSqliteStore(dataDir);
  await seed.putSettingsRaw('app', { version: 3, language: 'zh', providers: [
      { id: 'custom-abcdef01', kind: 'custom', name: 'C', baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', enabled: ['m128'] },
      { id: 'custom-abcdef02', kind: 'custom', name: 'D', baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', enabled: [] },
    ] });
  const cached = (id) => ({ models: [{ id, name: id.toUpperCase(), contextWindow: 128000, maxTokens: 4096, input: ['text'], reasoning: false }] });
  seed.putProviderModels('custom-abcdef01', cached('m128'));
  seed.putProviderModels('custom-abcdef02', cached('off128'));
  seed.close();
  const srv = await startServer({
    dataDir,
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ok' },
  });
  try {
    const discovery = await readDiscovery(dataDir);
    const anon = await v2(srv.base, 'GET', '/api/v2/settings');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.code, 'E_UNAUTHORIZED');

    const initial = await v2(srv.base, 'GET', '/api/v2/settings', discovery.token);
    assert.equal(initial.status, 200, initial.text);
    const fauxEarly = { providerId: 'custom-abcdef01', modelId: 'm128', name: 'm128', percent: 70 };
    assert.deepEqual(initial.body, { compaction: { triggerPercent: 80, effective: [fauxEarly] }, closeAction: 'ask' });
    assert.equal(validateResponse('/api/v2/settings', 'GET', 200, initial.body).ok, true);

    for (const triggerPercent of [59, 91, 80.5, '80', true]) {
      const rejected = await v2(srv.base, 'PUT', '/api/v2/settings', discovery.token, {
        compaction: { triggerPercent },
      });
      assert.equal(rejected.status, 400, JSON.stringify(triggerPercent));
      assert.equal(rejected.body.code, 'E_BAD_REQUEST');
    }
    const still = await v2(srv.base, 'GET', '/api/v2/settings', discovery.token);
    assert.equal(still.body.compaction.triggerPercent, 80);

    const saved = await v2(srv.base, 'PUT', '/api/v2/settings', discovery.token, {
      compaction: { triggerPercent: 70 },
    });
    assert.equal(saved.status, 200, saved.text);
    // At 70 the 128k model's real start (70%) is no longer earlier than p, so it drops out.
    assert.deepEqual(saved.body, { compaction: { triggerPercent: 70, effective: [] }, closeAction: 'ask' });
    const reset = await v2(srv.base, 'PUT', '/api/v2/settings', discovery.token, {
      compaction: { triggerPercent: 90 },
    });
    assert.deepEqual(reset.body, { compaction: { triggerPercent: 90, effective: [fauxEarly] }, closeAction: 'ask' });
    assert.equal(validateResponse('/api/v2/settings', 'PUT', 200, reset.body).ok, true);
    const back = await v2(srv.base, 'PUT', '/api/v2/settings', discovery.token, {
      compaction: { triggerPercent: 70 },
    });
    assert.equal(back.body.compaction.triggerPercent, 70);
    const legacy = await request(srv.base, 'GET', '/api/settings', undefined, TOKEN);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.compaction.triggerPercent, 70);

    const legacyPut = await request(srv.base, 'PUT', '/api/settings', {
      compaction: { triggerPercent: 61 },
    }, TOKEN);
    assert.equal(legacyPut.status, 200, JSON.stringify(legacyPut.body));
    assert.equal(legacyPut.body.compaction.triggerPercent, 61);
    const legacyBad = await request(srv.base, 'PUT', '/api/settings', {
      compaction: { triggerPercent: 50 },
    }, TOKEN);
    assert.equal(legacyBad.status, 400);
    const afterBad = await v2(srv.base, 'GET', '/api/v2/settings', discovery.token);
    assert.equal(afterBad.body.compaction.triggerPercent, 61);
    const unchanged = await v2(srv.base, 'PUT', '/api/v2/settings', discovery.token, {});
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.body.compaction.triggerPercent, 61);
    assert.equal(unchanged.body.closeAction, 'ask');
    assert.equal(validateResponse('/api/v2/settings', 'PUT', 200, unchanged.body).ok, true);

    for (const closeAction of ['tray', 'quit', 'ask']) {
      const put = await v2(srv.base, 'PUT', '/api/v2/settings', discovery.token, { closeAction });
      assert.equal(put.status, 200, put.text);
      assert.equal(put.body.closeAction, closeAction);
      assert.equal(put.body.compaction.triggerPercent, 61);
      assert.equal(validateResponse('/api/v2/settings', 'PUT', 200, put.body).ok, true);
      const got = await v2(srv.base, 'GET', '/api/v2/settings', discovery.token);
      assert.equal(got.status, 200, got.text);
      assert.equal(got.body.closeAction, closeAction);
      assert.equal(got.body.compaction.triggerPercent, 61);
      assert.equal(validateResponse('/api/v2/settings', 'GET', 200, got.body).ok, true);
    }

    for (const closeAction of ['minimize', '', null, 1, true, 'ASK', 'tray ']) {
      const rejected = await v2(srv.base, 'PUT', '/api/v2/settings', discovery.token, { closeAction });
      assert.equal(rejected.status, 400, JSON.stringify(closeAction));
      assert.equal(rejected.body.code, 'E_BAD_REQUEST');
    }
    const afterReject = await v2(srv.base, 'GET', '/api/v2/settings', discovery.token);
    assert.equal(afterReject.body.closeAction, 'ask');
    assert.equal(afterReject.body.compaction.triggerPercent, 61);

    const extra = await v2(srv.base, 'PUT', '/api/v2/settings', discovery.token, {
      closeAction: 'quit',
      theme: 'white',
    });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.code, 'E_BAD_REQUEST');
    const afterExtra = await v2(srv.base, 'GET', '/api/v2/settings', discovery.token);
    assert.equal(afterExtra.body.closeAction, 'ask');

    const both = await v2(srv.base, 'PUT', '/api/v2/settings', discovery.token, {
      closeAction: 'tray',
      compaction: { triggerPercent: 75 },
    });
    assert.equal(both.status, 200, both.text);
    assert.deepEqual(both.body, { compaction: { triggerPercent: 75 }, closeAction: 'tray' });
    const onlyPercent = await v2(srv.base, 'PUT', '/api/v2/settings', discovery.token, {
      compaction: { triggerPercent: 61 },
    });
    assert.equal(onlyPercent.status, 200, onlyPercent.text);
    assert.deepEqual(onlyPercent.body, { compaction: { triggerPercent: 61 }, closeAction: 'tray' });

    const legacyClose = await request(srv.base, 'GET', '/api/settings', undefined, TOKEN);
    assert.equal(legacyClose.status, 200);
    assert.equal(legacyClose.body.closeAction, 'tray');
    const legacyPutClose = await request(srv.base, 'PUT', '/api/settings', { closeAction: 'quit' }, TOKEN);
    assert.equal(legacyPutClose.status, 200, JSON.stringify(legacyPutClose.body));
    assert.equal(legacyPutClose.body.closeAction, 'quit');
    assert.equal(legacyPutClose.body.compaction.triggerPercent, 61);
    const legacyBadClose = await request(srv.base, 'PUT', '/api/settings', { closeAction: 'minimize' }, TOKEN);
    assert.equal(legacyBadClose.status, 400);
    const stillQuit = await v2(srv.base, 'GET', '/api/v2/settings', discovery.token);
    assert.equal(stillQuit.body.closeAction, 'quit');
    assert.equal(stillQuit.body.compaction.triggerPercent, 61);

    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'compact' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'compact',
    }, TOKEN);
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    const snapshot = await v2(srv.base, 'GET', `/api/v2/conversations/${conv.body.id}`, discovery.token);
    assert.equal(snapshot.status, 200, snapshot.text);
    assert.equal(snapshot.body.conversation.run.compaction.state, 'idle');
    assert.equal(validateResponse(
      `/api/v2/conversations/${conv.body.id}`,
      'GET',
      200,
      snapshot.body,
    ).ok, true, JSON.stringify(validateResponse(
      `/api/v2/conversations/${conv.body.id}`,
      'GET',
      200,
      snapshot.body,
    ).errors));

    const badInstructions = await v2(
      srv.base,
      'POST',
      `/api/v2/conversations/${conv.body.id}/compact`,
      discovery.token,
      { instructions: 1 },
    );
    assert.equal(badInstructions.status, 400);

    const first = await v2(
      srv.base,
      'POST',
      `/api/v2/conversations/${conv.body.id}/compact`,
      discovery.token,
      {},
    );
    assert.equal(first.status, 202, first.text);
    assert.equal(typeof first.body.taskId, 'string');
    assert.equal(validateResponse(
      `/api/v2/conversations/${conv.body.id}/compact`,
      'POST',
      202,
      first.body,
    ).ok, true);
    const second = await v2(
      srv.base,
      'POST',
      `/api/v2/conversations/${conv.body.id}/compact`,
      discovery.token,
      { instructions: 'keep names' },
    );
    assert.equal(second.status, 202, second.text);
    assert.notEqual(second.body.taskId, '');
    const missing = await v2(srv.base, 'POST', '/api/v2/conversations/missing/compact', discovery.token, {});
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'E_NOT_FOUND');
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});

test('a compaction kernel event republishes conversation compaction state', async () => {
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  const listeners = new Set();
  const data = {
    presented: {
      id: 'c1',
      workspaceId: 'w1',
      title: 't',
      updatedAt: 1,
      status: 'idle',
      messages: [],
      live: null,
    },
    subagents: [],
    modelTarget: null,
    window: 128000,
  };
  const topic = attachConversationTopic(hub, {
    loadConversation: async () => data,
    subscribe: (_cid, fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    coalesceMs: 15,
    log() {},
  });
  const frames = [];
  try {
    const session = hub.connect({
      topics: ['conversation:c1'],
      lang: 'zh',
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    const snap = frames.find((frame) => frame.event === 'snapshot');
    const snapConv = snap.data.entities.find((item) => item.entity === 'conversation');
    assert.equal(snapConv.value.run.compaction.state, 'idle');

    data.presented = {
      ...data.presented,
      live: { compactions: [{ trigger: 'manual', blocking: false }] },
    };
    for (const fn of listeners) fn({ event: 'compaction', data: {} });
    await sleep(80);
    const running = [...frames].reverse().find((frame) => (
      frame.event === 'upsert'
      && frame.data.entity === 'conversation'
      && frame.data.value?.run?.compaction?.state === 'running'
    ));
    assert.ok(running, JSON.stringify(frames.map((frame) => frame.event)));
    assert.equal(running.data.value.run.compaction.trigger, 'manual');

    data.presented = {
      ...data.presented,
      live: {
        compactionFailure: { trigger: 'overflow', error: 'Summarization failed: sk-supersecretvalue' },
      },
    };
    for (const fn of listeners) fn({ event: 'compaction', data: {} });
    await sleep(80);
    const failed = [...frames].reverse().find((frame) => (
      frame.event === 'upsert'
      && frame.data.entity === 'conversation'
      && frame.data.value?.run?.compaction?.state === 'failed'
    ));
    assert.ok(failed);
    assert.equal(failed.data.value.run.compaction.trigger, 'overflow');
    assert.equal(
      failed.data.value.run.compaction.error,
      '压缩失败：Summarization failed: sk-***',
    );
    session.close();
  } finally {
    topic.dispose();
    hub.dispose();
  }
});

test('projectViewUpdate emits compaction when pi.live changes or a summary entry appears', () => {
  const projector = createViewProjector();
  const ctx = createMapContext();
  const user = { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'hi' }] };
  const opened = projectViewUpdate(projector, { entries: [user], docs: {} }, ctx);
  assert.deepEqual(opened.events, []);
  const started = projectViewUpdate(projector, {
    entries: [user],
    docs: { 'pi.live': { compactions: [{ taskId: 4, trigger: 'threshold', blocking: false, attempt: 1 }] } },
  }, ctx);
  assert.equal(started.events.some((ev) => ev.event === 'compaction'), true);
  const summary = { id: 9, kind: 'pi.compaction' };
  const placed = projectViewUpdate(projector, {
    entries: [summary, user],
    docs: { 'pi.live': {} },
  }, ctx);
  assert.equal(placed.events.filter((ev) => ev.event === 'compaction').length >= 1, true);
});
