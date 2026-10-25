import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveDoc } from '@earendil-works/pi-durable';
import { createSubagentHost, Subagents } from '../../src/kernel/subagents.mjs';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-subagent-digest-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

function toolResult(toolName, details) {
  return {
    kind: 'pi.tool-result',
    model: [{ toolName, details }],
  };
}

function mockHost({
  parentId = 10,
  parentIds,
  children = [],
  parentEntries,
  lives = new Map(),
  rosters = new Map(),
  graphTasks = {},
  allowChildTranscripts = false,
} = {}) {
  const transcriptReads = [];
  const commitCalls = [];
  let taskGraphCalls = 0;
  let disposeCalls = 0;
  const parents = new Set((parentIds || [parentId]).map(Number));
  const entries = parentEntries ?? children.map((child) => toolResult(
    child.mode === 'background' ? 'subagent' : 'delegate',
    { conversationId: child.id, name: child.name, title: child.title },
  ));
  const harness = {
    async snapshot(doc, id) {
      const key = Number(id);
      if (doc === LiveDoc) {
        if (lives.has(key)) return lives.get(key);
        return parents.has(key) ? { tools: [] } : null;
      }
      if (doc === Subagents) return rosters.get(key) ?? { agents: {}, reporters: {} };
      return null;
    },
    async taskGraph() {
      taskGraphCalls += 1;
      return {
        value: { tasks: graphTasks },
        dispose() { disposeCalls += 1; },
      };
    },
    async commit(fn) {
      commitCalls.push(fn);
      const tx = {
        async scanTasks() { return { items: [] }; },
      };
      return fn(tx);
    },
  };
  async function readTranscript(id) {
    const key = Number(id);
    transcriptReads.push(key);
    if (parents.has(key)) {
      return { messages: [], entries: key === Number(parentId) ? entries : [] };
    }
    if (!allowChildTranscripts) {
      throw new Error(`digest must not read child transcript ${id}`);
    }
    return { messages: [{ role: 'assistant', text: `child-${key}` }], entries: [] };
  }
  const host = createSubagentHost({
    store: { getConversation: async () => null },
    harness,
    context: {},
    readTranscript,
  });
  return {
    host,
    transcriptReads,
    commitCalls,
    taskGraphCalls: () => taskGraphCalls,
    disposeCalls: () => disposeCalls,
  };
}

async function writeScript(dataDir, name, turns) {
  const file = path.join(dataDir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

async function waitForFile(file, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitFor(base, cid, ready, attempts = 80) {
  let body = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    body = got.body;
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return body;
}

async function waitForList(base, wid, ready, attempts = 80) {
  let got = null;
  for (let i = 0; i < attempts; i += 1) {
    got = await request(base, 'GET', `/api/workspaces/${wid}/conversations`);
    if (ready(got.body)) return got;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return got;
}

function subagentsOf(body) {
  return (body?.agents || []).filter((agent) => String(agent.id || '').includes(':sub:'));
}

test('subagentDigest counts LiveDoc.run without reading child transcripts', async () => {
  const parentId = 10;
  const liveChild = 101;
  const doneChild = 102;
  const { host, transcriptReads, commitCalls, taskGraphCalls, disposeCalls } = mockHost({
    parentId,
    children: [
      { id: liveChild, name: 'runner', mode: 'foreground', title: '跑测试' },
      { id: doneChild, name: 'finisher', mode: 'background', title: '已完成' },
    ],
    lives: new Map([
      [liveChild, { run: { id: 1 } }],
      [doneChild, {}],
    ]),
  });
  const conv = { id: 'c1', harnessId: parentId };
  const digest = await host.subagentDigest(conv);
  assert.deepEqual(digest, { total: 2, live: 1 });
  assert.deepEqual(transcriptReads, [parentId]);
  assert.equal(commitCalls.length, 0);
  assert.equal(taskGraphCalls(), 1);
  assert.equal(disposeCalls(), 1);

  const empty = await host.subagentDigest({ id: 'c0' });
  assert.deepEqual(empty, { total: 0, live: 0 });
  assert.deepEqual(transcriptReads, [parentId]);
});

test('subagentDigests shares one taskGraph across conversations', async () => {
  const parentId = 10;
  const otherId = 20;
  const liveChild = 101;
  const doneChild = 102;
  const { host, transcriptReads, commitCalls, taskGraphCalls, disposeCalls } = mockHost({
    parentId,
    parentIds: [parentId, otherId],
    children: [
      { id: liveChild, name: 'runner', mode: 'foreground' },
      { id: doneChild, name: 'finisher', mode: 'background' },
    ],
    lives: new Map([
      [liveChild, { run: { id: 1 } }],
      [doneChild, {}],
    ]),
    graphTasks: {
      a: { conversationId: parentId, conversations: [liveChild, doneChild] },
      b: { conversationId: otherId, conversations: [] },
    },
  });
  const convs = [
    { id: 'with-subs', harnessId: parentId },
    { id: 'plain', harnessId: otherId },
    { id: 'no-harness' },
  ];
  const readsBefore = transcriptReads.length;
  const digests = await host.subagentDigests(convs);
  assert.equal(taskGraphCalls(), 1);
  assert.equal(disposeCalls(), 1);
  assert.equal(commitCalls.length, 0);
  assert.deepEqual(digests.get('with-subs'), { total: 2, live: 1 });
  assert.deepEqual(digests.get('plain'), { total: 0, live: 0 });
  assert.deepEqual(digests.get('no-harness'), { total: 0, live: 0 });
  assert.deepEqual(transcriptReads.slice(readsBefore), [parentId, otherId]);
  assert.equal(transcriptReads.includes(liveChild), false);
  assert.equal(transcriptReads.includes(doneChild), false);
});

test('listSubagents still returns the same child fields after roster extract', async () => {
  const parentId = 10;
  const childId = 101;
  const { host, transcriptReads } = mockHost({
    parentId,
    allowChildTranscripts: true,
    children: [{ id: childId, name: 'coder', mode: 'foreground', title: '改登录' }],
    lives: new Map([[childId, { run: { id: 9 } }]]),
  });
  const agents = await host.listSubagents({ id: 'c1', harnessId: parentId });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'c1:sub:101');
  assert.equal(agents[0].name, 'coder');
  assert.equal(agents[0].title, '改登录');
  assert.equal(agents[0].status, 'running');
  assert.equal(agents[0].mode, 'foreground');
  assert.equal(agents[0].harnessId, childId);
  assert.equal(agents[0].lastText, 'child-101');
  assert.deepEqual(transcriptReads, [parentId, childId]);
});

test('list API carries subagent counts; GET /agents matches conversation agents without the main chip', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-digest-http-'));
  const ready = path.join(dataDir, 'ready');
  const script = await writeScript(dataDir, 'digest.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'done-one', message: 'finish-now', title: '已完成项' } },
    { tool: 'subagent', args: { action: 'spawn', name: 'live-one', message: 'hold-please', title: '运行中项' } },
    { text: 'spawned' },
    { when: 'finish-now', text: 'DONE_CHILD' },
    { when: 'hold-please', delayMs: 60000, text: 'LIVE_CHILD' },
  ]);
  let proc = null;
  try {
    const srv = await startServer({
      token: TOKEN,
      dataDir,
      env: {
        WEFT_RETRY_MAX: '2',
        WEFT_LLM: 'faux',
        WEFT_FAUX_SCRIPT: script,
        WEFT_FAUX_HOLD_READY: ready,
      },
    });
    proc = srv.proc;
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'digest' });
    assert.equal(ws.status, 201);
    const idle = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'idle' });
    assert.equal(idle.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'mixed' });
    assert.equal(conv.status, 201);
    const cid = conv.body.id;
    const wid = ws.body.id;

    const missing = await request(srv.base, 'GET', '/api/conversations/none/agents');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'conversation not found');

    const emptyAgents = await request(srv.base, 'GET', `/api/conversations/${idle.body.id}/agents`);
    assert.equal(emptyAgents.status, 200);
    assert.deepEqual(emptyAgents.body, { agents: [] });

    assert.equal((await request(srv.base, 'POST', `/api/conversations/${cid}/messages`, { text: 'spawn both' })).status, 202);
    await waitForFile(ready);

    const listedLive = await waitForList(srv.base, wid, (list) => {
      const mixed = (list || []).find((row) => row.id === cid);
      const plain = (list || []).find((row) => row.id === idle.body.id);
      return mixed?.subagents?.total === 2
        && mixed?.subagents?.live === 1
        && plain
        && Object.hasOwn(plain, 'subagents') === false;
    }, 150);
    assert.equal(listedLive.status, 200, srv.logs());
    const mixedRow = listedLive.body.find((row) => row.id === cid);
    const plainRow = listedLive.body.find((row) => row.id === idle.body.id);
    assert.deepEqual(mixedRow.subagents, { total: 2, live: 1 }, JSON.stringify(listedLive.body));
    assert.equal(Object.hasOwn(plainRow, 'subagents'), false, JSON.stringify(plainRow));

    const full = await waitFor(srv.base, cid, (body) => (
      subagentsOf(body).length === 2
      && subagentsOf(body).some((agent) => agent.status === 'running')
      && subagentsOf(body).some((agent) => agent.status === 'done')
    ), 150);
    const onlyAgents = await request(srv.base, 'GET', `/api/conversations/${cid}/agents`);
    assert.equal(onlyAgents.status, 200);
    assert.deepEqual(onlyAgents.body.agents, (full.agents || []).slice(1));
    assert.equal(onlyAgents.body.agents.some((agent) => agent.name === 'Agent'), false);
    const doneChip = onlyAgents.body.agents.find((agent) => agent.name === 'done-one');
    const liveChip = onlyAgents.body.agents.find((agent) => agent.name === 'live-one');
    assert.equal(doneChip?.title, '已完成项');
    assert.equal(liveChip?.title, '运行中项');
    assert.equal(doneChip?.mode, 'background');
    assert.equal(liveChip?.mode, 'background');
    assert.ok(doneChip?.brief);
    assert.ok(liveChip?.startedAt);

    const stopped = await request(
      srv.base,
      'POST',
      `/api/conversations/${cid}/agents/${encodeURIComponent(liveChip.id)}/stop`,
    );
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    const listedDone = await waitForList(srv.base, wid, (list) => {
      const mixed = (list || []).find((row) => row.id === cid);
      return mixed?.subagents?.total === 2 && mixed?.subagents?.live === 0;
    }, 150);
    const finished = listedDone.body.find((row) => row.id === cid);
    assert.deepEqual(finished.subagents, { total: 2, live: 0 }, JSON.stringify(listedDone.body));
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});
