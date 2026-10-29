import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import { createCredentialStore } from '../../src/core/provider-stores.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { ROOT } from './_root.mjs';
import { withHarnessLock } from './_harness-lock.mjs';
import { startFakeModel } from './kernel-models-fake.mjs';
import { readDiscovery, request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-thinking-token';
const KEY = 'sk-thinking-kernel-secret-4444';
const HOOK = pathToFileURL(path.join(ROOT, 'tests/unit/kernel-models-fake.mjs')).href;

async function seedDeepseek(dataDir) {
  const store = createSqliteStore(dataDir);
  await store.replaceSettings({
    version: 3,
    providers: [{
      id: 'deepseek',
      kind: 'builtin',
      enabled: ['deepseek-flash', 'deepseek-v4-pro'],
      overrides: {},
    }],
    defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
  });
  const credentials = createCredentialStore(store);
  await credentials.modify('deepseek', async () => ({ type: 'api_key', key: KEY }));
  store.close();
}

async function waitTurn(base, cid, pred, attempts = 80) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await serverRequest(base, 'GET', `/api/conversations/${cid}`, undefined, TOKEN);
    last = got.body;
    if (pred(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

function assistantTexts(body) {
  return (body?.messages || []).filter((message) => message.role === 'assistant').map((message) => message.text);
}

function childHarnessId(agent) {
  const id = String(agent?.id || '');
  const marker = ':sub:';
  const at = id.lastIndexOf(marker);
  return at >= 0 ? Number(id.slice(at + marker.length)) : NaN;
}

test('configure stores the effective thinkingLevel on the harness agent', { timeout: 40_000 }, async () => {
  await withHarnessLock(async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-kthink-cfg-'));
    const store = createSqliteStore(dataDir);
    await store.replaceSettings({
      version: 3,
      providers: [{
        id: 'deepseek',
        kind: 'builtin',
        enabled: ['deepseek-flash'],
        overrides: {},
      }],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
    });
    const credentials = createCredentialStore(store);
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: KEY }));
    const kernel = await openConversationKernel({
      dataDir,
      store,
      credentials,
      getSettings: () => store.getSettings(),
      env: { ...process.env, WEFT_LLM: '', LLM_API: '', WEFT_FAUX_SCRIPT: '' },
    });
    try {
      const ws = await store.createWorkspace({ name: 'think', path: dataDir, source: 'local', rootPath: dataDir });
      const conv = await kernel.createConversation({
        workspaceId: ws.id,
        workspacePath: ws.path,
        title: 'think',
      });
      const handle = await kernel.harness.conversation(conv.harnessId, kernel.context);
      const before = await handle.agent(kernel.context);
      assert.equal(before.thinkingLevel, 'high');

      const patched = await kernel.patchConversation(conv.id, { thinkingLevel: 'high' });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      const after = await handle.agent(kernel.context);
      assert.equal(after.thinkingLevel, 'high');

      const medium = await kernel.patchConversation(conv.id, { thinkingLevel: 'medium' });
      assert.equal(medium.status, 200, JSON.stringify(medium.body));
      const clamped = await handle.agent(kernel.context);
      assert.equal(clamped.thinkingLevel, 'high');
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

test('DeepSeek request body: off is thinking disabled, high enables thinking', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-kthink-body-'));
  await seedDeepseek(dataDir);
  const fake = await startFakeModel({ mode: 'openai', text: 'from-flash' });
  let srv = null;
  try {
    srv = await startServer({
      dataDir,
      token: TOKEN,
      nodeArgs: ['--import', HOOK],
      env: { WEFT_FAKE_DEEPSEEK_ORIGIN: fake.baseUrl },
    });
    const { base } = srv;
    const ws = await serverRequest(base, 'POST', '/api/workspaces', { name: 'think-body' }, TOKEN);
    assert.equal(ws.status, 201, ws.text);
    const conv = await serverRequest(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'off',
    }, TOKEN);
    assert.equal(conv.status, 201, conv.text);

    const discoveryOff = await readDiscovery(dataDir);
    const setOff = await fetch(`${base}/api/v2/conversations/${conv.body.id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${discoveryOff.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ thinkingLevel: 'off' }),
    });
    assert.equal(setOff.status, 200, await setOff.text());

    const sentOff = await serverRequest(base, 'POST', `/api/conversations/${conv.body.id}/messages`, {
      text: 'ping-off',
    }, TOKEN);
    assert.equal(sentOff.status, 202, sentOff.text);
    const doneOff = await waitTurn(base, conv.body.id, (body) => assistantTexts(body).includes('from-flash'));
    assert.equal(doneOff.status, 'done', JSON.stringify(doneOff?.llmError || doneOff));
    const offHit = fake.seen.filter((item) => item.path.endsWith('/chat/completions'))[0];
    assert.ok(offHit, JSON.stringify(fake.seen));
    assert.deepEqual(offHit.body.thinking, { type: 'disabled' });
    assert.equal(Object.prototype.hasOwnProperty.call(offHit.body, 'reasoning_effort'), false);

    const discovery = await readDiscovery(dataDir);
    const patched = await fetch(`${base}/api/v2/conversations/${conv.body.id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${discovery.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ thinkingLevel: 'high' }),
    });
    const patchedBody = await patched.json();
    assert.equal(patched.status, 200, JSON.stringify(patchedBody));
    assert.equal(patchedBody.thinkingLevel, 'high');

    const sentHigh = await serverRequest(base, 'POST', `/api/conversations/${conv.body.id}/messages`, {
      text: 'ping-high',
    }, TOKEN);
    assert.equal(sentHigh.status, 202, sentHigh.text);
    const beforeHigh = fake.seen.filter((item) => item.path.endsWith('/chat/completions')).length;
    const doneHigh = await waitTurn(base, conv.body.id, (body) => (
      assistantTexts(body).filter((text) => text === 'from-flash').length >= 2
    ));
    assert.equal(doneHigh.status, 'done', JSON.stringify(doneHigh?.llmError || doneHigh));
    const hits = fake.seen.filter((item) => item.path.endsWith('/chat/completions'));
    assert.equal(hits.length > beforeHigh, true, JSON.stringify(hits.map((hit) => hit.body)));
    const highHit = hits[hits.length - 1];
    assert.deepEqual(highHit.body.thinking, { type: 'enabled' });
    assert.equal(highHit.body.reasoning_effort, 'high');
  } finally {
    await stopServer(srv);
    await fake.close();
  }
});

test('subagent inherits the parent conversation thinkingLevel', { timeout: 60_000 }, async () => {
  await withHarnessLock(async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-kthink-sub-'));
    const task = '请确认前台子代理已经收到了思考档位并马上开始执行';
    const script = path.join(dataDir, 'sub.json');
    await writeFile(script, JSON.stringify({
      turns: [
        { tool: 'delegate', args: { task } },
        { text: 'parent-done' },
        { when: '请确认前台子代理', text: 'CHILD_OK' },
      ],
    }));
    const store = createSqliteStore(dataDir);
    let kernel = null;
    try {
      const wsPath = path.join(dataDir, 'ws');
      await mkdir(wsPath, { recursive: true });
      const ws = await store.createWorkspace({ name: 'think-sub', path: wsPath });
      kernel = await openConversationKernel({
        dataDir,
        store,
        demo: true,
        extensions: createExtensionHost({ getSettings: () => store.getSettings() }),
        getSettings: () => store.getSettings(),
        env: {
          WEFT_LLM: 'faux',
          WEFT_FAUX_SCRIPT: script,
          WEFT_RETRY_MAX: '2',
          WEFT_RETRY_BASE_MS: '20',
        },
      });
      const conv = await kernel.createConversation({
        workspaceId: ws.id,
        workspacePath: wsPath,
        title: 'think-sub',
      });
      const parentHandle = await kernel.harness.conversation(conv.harnessId, kernel.context);
      await parentHandle.configure({ thinkingLevel: 'high' }, kernel.context);
      const posted = await kernel.postMessage(conv, 'dispatch');
      assert.equal(posted.status, 202);
      let done = null;
      let child = null;
      for (let i = 0; i < 120; i += 1) {
        const live = await store.getConversation(conv.id);
        done = await kernel.present(live, { includeMessages: true });
        child = (await kernel.listSubagents(live)).find((agent) => agent.mode === 'foreground');
        if (done.status === 'done' && child) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(done.status, 'done', JSON.stringify(done));
      assert.ok(child, 'foreground child never appeared');
      const childHandle = await kernel.harness.conversation(childHarnessId(child), kernel.context);
      const parentAgent = await parentHandle.agent(kernel.context);
      const childAgent = await childHandle.agent(kernel.context);
      assert.equal(parentAgent.thinkingLevel, 'high');
      assert.equal(childAgent.thinkingLevel, 'high');
    } finally {
      await kernel?.close();
      store.close();
    }
  });
});
