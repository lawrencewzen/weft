// Re-forking a fork must keep ask_user_question (and its group mates) in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore } from '../../src/core/provider-stores.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const TOKEN = 'v2-fork-ask-token';
const ASK = {
  question: '用哪种包管理器？',
  header: '包管理器',
  multiSelect: false,
  options: [
    { label: 'npm', description: 'Node 自带' },
    { label: 'pnpm', description: '节省磁盘' },
  ],
};

async function v2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

async function waitFor(base, id, token, ready) {
  let last;
  for (let i = 0; i < 600; i += 1) {
    last = await v2(base, 'GET', `/api/v2/conversations/${id}`, token);
    if (last.status === 200 && ready(last.body)) return last.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout: ${JSON.stringify(last?.body)?.slice(0, 1500)}`);
}

const idle = (body) => body?.conversation?.run?.status === 'idle';
const shape = (body) => body.items.map((item) => `${item.kind}:${item.text || ''}`);

test('forking at an assistant message keeps its tool calls with their results', { timeout: 120_000 }, async () => {
  const dataDir = await makeTempDir('weft-v2-fork-ask-');
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({
    turns: [
      {
        text: '先问一下。',
        tools: [
          { tool: 'task', id: 'sp-1', args: { description: 'a', prompt: 'CHILD-A', run_in_background: true } },
          { tool: 'task', id: 'sp-2', args: { description: 'b', prompt: 'CHILD-B', run_in_background: true } },
          { tool: 'ask_user_question', id: 'ask-1', args: { questions: [ASK] } },
        ],
      },
      { when: 'CHILD-A', delayMs: 1500, text: 'child-a-done' },
      { when: 'CHILD-B', delayMs: 800, text: 'child-b-done' },
      { text: 'CONTINUE-OK' },
      { text: 'HELLO-BACK' },
    ],
  }));
  const store = createSqliteStore(dataDir);
  await store.replaceSettings({
    version: 3,
    language: 'zh',
    providers: [{ id: 'deepseek', kind: 'builtin', enabled: ['deepseek-flash'], overrides: {} }],
    defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
  });
  await createCredentialStore(store).modify('deepseek', async () => ({ type: 'api_key', key: 'sk-x-1234' }));
  store.close();
  const srv = await startServer({ token: TOKEN, dataDir, env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script } });
  try {
    const token = (await readDiscovery(dataDir)).token;
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'fa' }, TOKEN);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'A' }, TOKEN);
    const a = conv.body.id;
    const post = (id, body) => v2(srv.base, 'POST', `/api/v2/conversations/${id}/messages`, token, body);

    assert.equal((await post(a, { text: '请提问' })).status, 202);
    await waitFor(srv.base, a, token, (b) => idle(b) && b.tools.some((t) => t.id === 'ask-1'));
    assert.equal((await post(a, {
      answer: { toolCallId: 'ask-1', answers: [{ questionIndex: 0, selected: ['pnpm'] }] },
    })).status, 202);
    await waitFor(srv.base, a, token, (b) => idle(b) && JSON.stringify(b.items).includes('CONTINUE-OK'));
    assert.equal((await post(a, { text: '你好' })).status, 202);
    const snapA = await waitFor(srv.base, a, token, (b) => idle(b) && JSON.stringify(b.items).includes('HELLO-BACK'));

    const lastAssistant = (snap) => [...snap.items].reverse().find((item) => item.kind === 'assistant');
    const forkOf = async (id, snap) => {
      const res = await v2(srv.base, 'POST', `/api/v2/conversations/${id}/fork`, token, { entryId: lastAssistant(snap).entryId });
      assert.equal(res.status, 201, res.text);
      return res.body.conversationId;
    };
    // B forks A late; C forks B at the first assistant message, the one that made the calls.
    const early = snapA.items.find((x) => x.kind === 'assistant');
    const b = await forkOf(a, snapA);
    const snapB = await waitFor(srv.base, b, token, idle);
    assert.equal(snapB.items.find((x) => x.entryId === early.entryId)?.kind, 'assistant');
    const rc = await v2(srv.base, 'POST', `/api/v2/conversations/${b}/fork`, token, { entryId: early.entryId });
    assert.equal(rc.status, 201, rc.text);
    const c = rc.body.conversationId;
    const sc0 = await waitFor(srv.base, c, token, idle);
    assert.equal(sc0.tools.some((t) => t.status === 'running'), false, JSON.stringify(sc0.tools.map((t) => [t.id, t.status])));
    assert.equal((await post(c, { text: '你好' })).status, 202);
    const snapC = await waitFor(srv.base, c, token, (x) => idle(x) && JSON.stringify(x.items).includes('你好') && x.items.at(-1).kind === 'assistant');

    for (const snap of [snapB, snapC]) {
      const groups = snap.items.filter((x) => x.kind === 'tool_group');
      assert.equal(groups.length, 1, JSON.stringify(shape(snap)));
      assert.equal(snap.items.indexOf(groups[0]), 2, JSON.stringify(shape(snap)));
      // Results are placed as they finish, so the order inside a group is not the call order.
      assert.deepEqual([...groups[0].toolIds].sort(), ['ask-1', 'sp-1', 'sp-2']);
      assert.deepEqual(
        snap.tools.map((t) => [t.id, t.status]).sort(),
        [['ask-1', 'done'], ['sp-1', 'done'], ['sp-2', 'done']],
      );
      assert.deepEqual(snap.tools.map((t) => t.id), groups[0].toolIds);
      assert.equal(snap.items.at(-1).kind, 'assistant');
    }
    assert.equal(snapC.tools.find((t) => t.id === 'ask-1').kind, 'ask');
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});
