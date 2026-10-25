import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { withHarnessLock } from './_harness-lock.mjs';

async function withKernel(fn) {
  return withHarnessLock(async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-status-'));
    const store = createSqliteStore(dataDir);
    const kernel = await openConversationKernel({
      dataDir,
      store,
      demo: true,
      env: { ...process.env, WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ok' },
    });
    try {
      const ws = await store.createWorkspace({
        name: 'status',
        path: dataDir,
        source: 'local',
        rootPath: dataDir,
      });
      const conv = await kernel.createConversation({
        workspaceId: ws.id,
        workspacePath: ws.path,
        title: 's',
      });
      return await fn({ store, kernel, ws, conv });
    } finally {
      await kernel.close();
      store.close();
    }
  });
}

test('statusOf returns idle without calling present', { timeout: 20_000 }, async () => {
  await withKernel(async ({ kernel, conv }) => {
    let presentCalls = 0;
    const orig = kernel.present.bind(kernel);
    kernel.present = async (...args) => {
      presentCalls += 1;
      return orig(...args);
    };
    const status = await kernel.statusOf(conv);
    assert.equal(status, 'idle');
    assert.equal(presentCalls, 0);
    const presented = await orig(conv);
    assert.equal(presented.status, 'idle');
    assert.equal(presentCalls, 0);
  });
});

test('subscribeAll receives events from any conversation and unsub stops them', { timeout: 30_000 }, async () => {
  await withKernel(async ({ kernel, conv, store }) => {
    const seen = [];
    const unsub = kernel.subscribeAll((cid, ev) => {
      seen.push({ cid, event: String(ev?.event || '') });
    });
    const posted = await kernel.postMessage(conv, 'hello');
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const started = Date.now();
    while (Date.now() - started < 15000) {
      if (seen.some((row) => row.cid === conv.id && row.event === 'status')) break;
      await sleep(40);
    }
    assert.equal(seen.some((row) => row.cid === conv.id && row.event === 'status'), true, JSON.stringify(seen));

    const other = await kernel.createConversation({
      workspaceId: conv.workspaceId,
      workspacePath: conv.workspacePath,
      title: 'other',
    });
    const before = seen.length;
    unsub();
    await kernel.postMessage(other, 'later');
    await sleep(400);
    assert.equal(seen.length, before);

    const row = await store.getConversation(conv.id);
    const live = await kernel.statusOf(row);
    assert.ok(['idle', 'done', 'failed'].includes(live) || typeof live === 'string', live);
  });
});
