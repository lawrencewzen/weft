import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateResponse } from '../../src/v2/validate.ts';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore } from '../../src/core/provider-stores.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const TOKEN = 'v2-fork-token';
const KEY = 'sk-fork-secret-4444';

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function sendV2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      ...v2Headers(token),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

function assertChecked(apiPath, method, status, body) {
  const checked = validateResponse(apiPath.split('?')[0], method, status, body);
  assert.equal(checked.ok, true, `${method} ${apiPath} ${status}: ${JSON.stringify(checked.errors)}\n${JSON.stringify(body)}`);
}

function signature(body) {
  return (body?.items || []).map((item) => `${item.kind}:${item.id}:${item.text || ''}:${item.entryId ?? ''}`).join('\n');
}

function itemText(body, kind, needle) {
  return (body?.items || []).find((item) => item.kind === kind && String(item.text || '').includes(needle));
}

async function seedDeepseek(dataDir) {
  const store = createSqliteStore(dataDir);
  await store.replaceSettings({
    version: 3,
    language: 'zh',
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

async function waitFor(base, id, token, ready, timeoutMs = 30000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await sendV2(base, 'GET', `/api/v2/conversations/${id}`, token);
    if (last.status === 200 && ready(last.body)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`snapshot timeout: ${JSON.stringify(last?.body)?.slice(0, 1500)}`);
}

async function postMessage(base, id, token, text) {
  const sent = await sendV2(base, 'POST', `/api/v2/conversations/${id}/messages`, token, { text });
  assert.equal(sent.status, 202, sent.text);
  return sent;
}

function summaries(body, workspaceId) {
  return (body?.conversations || []).filter((row) => row.workspaceId === workspaceId);
}

test('POST /fork copies history with Pi Durable, prefill, idempotency, and error codes', { timeout: 120_000 }, async () => {
  const dataDir = await makeTempDir('weft-v2-fork-');
  const script = path.join(dataDir, 'fork-script.json');
  const record = path.join(dataDir, 'fork-record.jsonl');
  await writeFile(script, JSON.stringify({
    turns: [
      { when: 'TOKEN-APPLE', text: 'alpha-reply APPLE-SEEN' },
      { when: 'TOKEN-BANANA', text: 'banana-pad' },
      { when: 'TOKEN-BANANA', text: 'beta-reply BANANA-SEEN' },
      { when: 'TOKEN-RECALL', text: 'recall-pad' },
      { when: 'TOKEN-RECALL', text: 'gamma-reply REMEMBERS' },
    ],
  }));
  await seedDeepseek(dataDir);
  const env = {
    WEFT_LLM: 'faux',
    WEFT_FAUX_SCRIPT: script,
    WEFT_FAUX_RECORD: record,
  };
  let srv = await startServer({ token: TOKEN, dataDir, env });
  let assistantForkId = '';
  let parentId = '';
  try {
    const discovery = await readDiscovery(dataDir);
    const token = discovery.token;
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'fork' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const created = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'Temp' }, TOKEN);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    parentId = created.body.id;
    const named = await request(srv.base, 'PATCH', `/api/conversations/${parentId}`, { title: 'Plan review' }, TOKEN);
    assert.equal(named.status, 200, named.text);

    await postMessage(srv.base, parentId, token, '请看 TOKEN-APPLE');
    await waitFor(srv.base, parentId, token, (body) => (
      body?.conversation?.run?.status === 'idle' && itemText(body, 'assistant', 'APPLE-SEEN')
    ));
    await postMessage(srv.base, parentId, token, '再看 TOKEN-BANANA');
    const parent = await waitFor(srv.base, parentId, token, (body) => (
      body?.conversation?.run?.status === 'idle' && itemText(body, 'assistant', 'BANANA-SEEN')
    ));
    assertChecked(`/api/v2/conversations/${parentId}`, 'GET', 200, parent.body);
    const before = signature(parent.body);
    const appleUser = itemText(parent.body, 'user', 'TOKEN-APPLE');
    const bananaUser = itemText(parent.body, 'user', 'TOKEN-BANANA');
    const alpha = itemText(parent.body, 'assistant', 'APPLE-SEEN');
    const beta = itemText(parent.body, 'assistant', 'BANANA-SEEN');
    assert.ok(appleUser && bananaUser && alpha && beta);
    assert.equal(appleUser.entryId, appleUser.id);
    assert.equal(bananaUser.entryId, bananaUser.id);
    assert.equal(alpha.entryId, alpha.id);
    assert.equal(beta.entryId, beta.id);
    assert.match(alpha.entryId, /^\d+$/);
    assert.equal(parent.body.conversation.forkedFrom, null);
    for (const item of parent.body.items) {
      if (item.kind === 'user' || item.kind === 'assistant') assert.equal(item.entryId, item.id);
      else assert.equal(item.entryId, undefined);
    }

    const patched = await sendV2(srv.base, 'PATCH', `/api/v2/conversations/${parentId}`, token, {
      model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
      thinkingLevel: 'off',
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.body.model.modelId, 'deepseek-v4-pro');
    assert.equal(patched.body.thinkingLevel, 'off');

    const forkPath = `/api/v2/conversations/${parentId}/fork`;
    const assistantFork = await sendV2(srv.base, 'POST', `${forkPath}?lang=zh`, token, {
      entryId: alpha.entryId,
      requestId: 'fork-alpha',
    });
    assert.equal(assistantFork.status, 201, assistantFork.text);
    assertChecked(forkPath, 'POST', 201, assistantFork.body);
    assert.equal(assistantFork.body.prefill, null);
    assistantForkId = assistantFork.body.conversationId;
    assert.notEqual(assistantForkId, parentId);

    const child = await sendV2(srv.base, 'GET', `/api/v2/conversations/${assistantForkId}`, token);
    assert.equal(child.status, 200, child.text);
    assertChecked(`/api/v2/conversations/${assistantForkId}`, 'GET', 200, child.body);
    assert.equal(child.body.conversation.title, 'Plan review（分叉）');
    assert.equal(child.body.conversation.workspaceId, parent.body.conversation.workspaceId);
    assert.deepEqual(child.body.conversation.forkedFrom, {
      conversationId: parentId,
      title: 'Plan review',
    });
    assert.equal(child.body.conversation.model.sourceId, 'deepseek');
    assert.equal(child.body.conversation.model.modelId, 'deepseek-v4-pro');
    assert.equal(child.body.conversation.thinkingLevel, 'off');
    assert.ok(itemText(child.body, 'user', 'TOKEN-APPLE'));
    assert.ok(itemText(child.body, 'assistant', 'APPLE-SEEN'));
    assert.equal(itemText(child.body, 'user', 'TOKEN-BANANA'), undefined);
    assert.equal(itemText(child.body, 'assistant', 'BANANA-SEEN'), undefined);

    const again = await sendV2(srv.base, 'POST', forkPath, token, {
      entryId: alpha.entryId,
      requestId: 'fork-alpha',
    });
    assert.equal(again.status, 201, again.text);
    assert.equal(again.body.conversationId, assistantForkId);
    assert.equal(again.body.prefill, null);
    const side = await sendV2(srv.base, 'GET', '/api/v2/workspaces', token);
    assert.equal(side.status, 200, side.text);
    assertChecked('/api/v2/workspaces', 'GET', 200, side.body);
    const rows = summaries(side.body, parent.body.conversation.workspaceId);
    assert.equal(rows.filter((row) => row.id === assistantForkId).length, 1);
    assert.deepEqual(rows.find((row) => row.id === assistantForkId).forkedFrom, {
      conversationId: parentId,
      title: 'Plan review',
    });

    const english = await sendV2(srv.base, 'POST', `${forkPath}?lang=en`, token, {
      entryId: alpha.entryId,
      requestId: 'fork-alpha-en',
    });
    assert.equal(english.status, 201, english.text);
    assert.equal(english.body.prefill, null);
    const englishView = await sendV2(srv.base, 'GET', `/api/v2/conversations/${english.body.conversationId}`, token);
    assert.equal(englishView.body.conversation.title, 'Plan review (fork)');
    assert.equal(englishView.body.conversation.forkedFrom.title, 'Plan review');

    const userFork = await sendV2(srv.base, 'POST', forkPath, token, {
      entryId: bananaUser.entryId,
      requestId: 'fork-banana',
    });
    assert.equal(userFork.status, 201, userFork.text);
    assertChecked(forkPath, 'POST', 201, userFork.body);
    assert.deepEqual(userFork.body.prefill, { text: bananaUser.text });
    const userChild = await sendV2(srv.base, 'GET', `/api/v2/conversations/${userFork.body.conversationId}`, token);
    assert.equal(userChild.status, 200, userChild.text);
    assert.ok(itemText(userChild.body, 'user', 'TOKEN-APPLE'));
    assert.ok(itemText(userChild.body, 'assistant', 'APPLE-SEEN'));
    assert.equal(itemText(userChild.body, 'user', 'TOKEN-BANANA'), undefined);
    assert.equal(itemText(userChild.body, 'assistant', 'BANANA-SEEN'), undefined);
    assert.equal(userChild.body.conversation.workspaceId, parent.body.conversation.workspaceId);
    assert.equal(userChild.body.conversation.model.modelId, 'deepseek-v4-pro');
    assert.equal(userChild.body.conversation.thinkingLevel, 'off');
    assert.deepEqual(userChild.body.conversation.forkedFrom, {
      conversationId: parentId,
      title: 'Plan review',
    });

    const first = await sendV2(srv.base, 'POST', forkPath, token, {
      entryId: appleUser.entryId,
      requestId: 'fork-first',
    });
    assert.equal(first.status, 201, first.text);
    assert.deepEqual(first.body.prefill, { text: appleUser.text });
    const empty = await sendV2(srv.base, 'GET', `/api/v2/conversations/${first.body.conversationId}`, token);
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.body.items, []);
    assert.deepEqual(empty.body.conversation.itemIds, []);
    assert.equal(empty.body.conversation.workspaceId, parent.body.conversation.workspaceId);
    assert.equal(empty.body.conversation.title, 'Plan review（分叉）');
    assert.deepEqual(empty.body.conversation.forkedFrom, {
      conversationId: parentId,
      title: 'Plan review',
    });

    await postMessage(srv.base, assistantForkId, token, '继续 TOKEN-RECALL');
    const recalled = await waitFor(srv.base, assistantForkId, token, (body) => (
      body?.conversation?.run?.status === 'idle' && itemText(body, 'assistant', 'REMEMBERS')
    ));
    assert.equal(recalled.body.conversation.title, 'Plan review（分叉）');
    assert.ok(itemText(recalled.body, 'user', 'TOKEN-APPLE'));
    assert.ok(itemText(recalled.body, 'assistant', 'APPLE-SEEN'));
    const recorded = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const recallRequest = recorded.find((row) => (row.users || []).some((text) => String(text).includes('TOKEN-RECALL')));
    assert.ok(recallRequest, JSON.stringify(recorded.map((row) => row.users)));
    const joined = JSON.stringify(recallRequest.messages);
    assert.match(joined, /TOKEN-APPLE/);
    assert.match(joined, /APPLE-SEEN/);
    assert.equal((recallRequest.tools || []).includes('fork'), false);

    const parentAfter = await sendV2(srv.base, 'GET', `/api/v2/conversations/${parentId}`, token);
    assert.equal(signature(parentAfter.body), before);
    assert.equal(parentAfter.body.conversation.title, 'Plan review');
    assert.equal(parentAfter.body.conversation.forkedFrom, null);
    assert.equal(itemText(parentAfter.body, 'assistant', 'REMEMBERS'), undefined);

    const missingEntry = await sendV2(srv.base, 'POST', forkPath, token, { entryId: '999999' });
    assert.equal(missingEntry.status, 400, missingEntry.text);
    assertChecked(forkPath, 'POST', 400, missingEntry.body);
    assert.equal(missingEntry.body.code, 'E_ENTRY_NOT_FOUND');
    assert.equal(missingEntry.body.error, '指定的消息不存在');
    const missingEn = await sendV2(srv.base, 'POST', `${forkPath}?lang=en`, token, { entryId: '999999' });
    assert.equal(missingEn.status, 400, missingEn.text);
    assert.equal(missingEn.body.error, 'Entry not found');
    const badType = await sendV2(srv.base, 'POST', forkPath, token, { entryId: 12 });
    assert.equal(badType.status, 400, badType.text);
    assertChecked(forkPath, 'POST', 400, badType.body);
    assert.equal(badType.body.code, 'E_BAD_REQUEST');
    const missingId = await sendV2(srv.base, 'POST', forkPath, token, {});
    assert.equal(missingId.status, 400, missingId.text);
    assert.equal(missingId.body.code, 'E_BAD_REQUEST');
    const blankId = await sendV2(srv.base, 'POST', forkPath, token, { entryId: '  ' });
    assert.equal(blankId.status, 400, blankId.text);
    assert.equal(blankId.body.code, 'E_BAD_REQUEST');
    const missingConv = await sendV2(srv.base, 'POST', '/api/v2/conversations/does-not-exist/fork', token, { entryId: alpha.entryId });
    assert.equal(missingConv.status, 404, missingConv.text);
    assertChecked('/api/v2/conversations/does-not-exist/fork', 'POST', 404, missingConv.body);
    assert.equal(missingConv.body.error, 'not found');
  } finally {
    await stopServer(srv);
  }

  srv = await startServer({ token: TOKEN, dataDir, env });
  try {
    const discovery = await readDiscovery(dataDir);
    const token = discovery.token;
    const snap = await sendV2(srv.base, 'GET', `/api/v2/conversations/${assistantForkId}`, token);
    assert.equal(snap.status, 200, snap.text);
    assert.deepEqual(snap.body.conversation.forkedFrom, {
      conversationId: parentId,
      title: 'Plan review',
    });
    assert.equal(snap.body.conversation.title, 'Plan review（分叉）');
    assert.ok(itemText(snap.body, 'assistant', 'APPLE-SEEN'));
    assert.ok(itemText(snap.body, 'assistant', 'REMEMBERS'));
    const side = await sendV2(srv.base, 'GET', '/api/v2/workspaces', token);
    assert.equal(side.status, 200, side.text);
    const row = (side.body.conversations || []).find((item) => item.id === assistantForkId);
    assert.ok(row, JSON.stringify(side.body.conversations?.map((item) => item.id)));
    assert.deepEqual(row.forkedFrom, {
      conversationId: parentId,
      title: 'Plan review',
    });
    const parent = (side.body.conversations || []).find((item) => item.id === parentId);
    assert.equal(parent.forkedFrom, null);
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});
