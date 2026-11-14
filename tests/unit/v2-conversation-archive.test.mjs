import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseSSE } from '../../src/core/sse.mjs';
import { validateResponse } from '../../src/v2/validate.ts';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-archive-token';

async function v2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
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
  assert.equal(checked.ok, true, `${method} ${apiPath} ${status}: ${JSON.stringify(checked.errors)}`);
}

async function open(base, name = 'arch') {
  const ws = await request(base, 'POST', '/api/workspaces', { name }, TOKEN);
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: name }, TOKEN);
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return { ws: ws.body, conv: conv.body };
}

async function summary(base, token, cid) {
  const side = await v2(base, 'GET', '/api/v2/workspaces', token);
  assert.equal(side.status, 200, side.text);
  return (side.body.conversations || []).find((row) => row.id === cid) || null;
}

async function waitV2(base, id, token, ready, timeoutMs = 35000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await v2(base, 'GET', `/api/v2/conversations/${id}`, token);
    if (last.status === 200 && ready(last.body)) return last;
    await sleep(60);
  }
  throw new Error(`snapshot timeout: ${JSON.stringify(last?.body)?.slice(0, 800)}`);
}

async function waitForFile(file, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { await readFile(file, 'utf8'); return; } catch { await sleep(30); }
  }
  throw new Error(`file not ready: ${file}`);
}

async function waitUntil(fn, timeoutMs = 20000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(40);
  }
  throw new Error('condition not met in time');
}

function openEvents({ port, token, topics }) {
  const query = new URLSearchParams({ topics });
  return new Promise((resolve, reject) => {
    let buf = '';
    const events = [];
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: `/api/v2/events?${query.toString()}`,
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    }, (res) => {
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          if (!part.trim() || part.trim() === ':') continue;
          events.push(...parseSSE(`${part}\n\n`));
        }
      });
      resolve({ events, close: () => req.destroy() });
    });
    req.on('error', (err) => {
      if (err?.code === 'ECONNRESET') return;
      reject(err);
    });
    req.end();
  });
}

function eventsOf(session, kind, entity, id) {
  return session.events.filter((ev) => ev.event === kind && ev.data?.entity === entity && ev.data?.id === id);
}

function userMessage(base, cid, token, text, mode) {
  return v2(base, 'POST', `/api/v2/conversations/${cid}/messages`, token, mode ? { text, mode } : { text });
}

test('archive and unarchive update the sidebar and the conversation topic; send unarchives', { timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-archive-'));
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({ turns: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] }));
  const srv = await startServer({ token: TOKEN, dataDir, env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script } });
  let events = null;
  try {
    const { token } = await readDiscovery(dataDir);
    const { conv } = await open(srv.base);
    const cid = conv.id;
    events = await openEvents({ port: srv.port, token, topics: `workspaces,conversation:${cid}` });
    await waitUntil(() => events.events.some((ev) => ev.event === 'snapshot'));

    assert.equal((await summary(srv.base, token, cid)).archived, false);
    const before = (await summary(srv.base, token, cid)).updatedAt;

    for (const bad of [{ archived: 'yes' }, { archived: null }, {}]) {
      const rejected = await v2(srv.base, 'PATCH', `/api/v2/conversations/${cid}`, token, bad);
      assert.equal(rejected.status, 400, JSON.stringify(bad));
      assertChecked(`/api/v2/conversations/${cid}`, 'PATCH', 400, rejected.body);
    }
    const missing = await v2(srv.base, 'PATCH', '/api/v2/conversations/nope', token, { archived: true });
    assert.equal(missing.status, 404);

    const archived = await v2(srv.base, 'PATCH', `/api/v2/conversations/${cid}`, token, { archived: true });
    assert.equal(archived.status, 200, archived.text);
    assertChecked(`/api/v2/conversations/${cid}`, 'PATCH', 200, archived.body);
    const row = await summary(srv.base, token, cid);
    assert.equal(row.archived, true);
    assert.equal(row.updatedAt, before, 'archiving keeps the sidebar order');
    await waitUntil(() => eventsOf(events, 'upsert', 'conversation_summary', cid)
      .some((ev) => ev.data.value?.archived === true));

    // Repeating the same value is fine.
    const again = await v2(srv.base, 'PATCH', `/api/v2/conversations/${cid}`, token, { archived: true });
    assert.equal(again.status, 200);

    const restored = await v2(srv.base, 'PATCH', `/api/v2/conversations/${cid}`, token, { archived: false });
    assert.equal(restored.status, 200, restored.text);
    assert.equal((await summary(srv.base, token, cid)).archived, false);
    await waitUntil(() => eventsOf(events, 'upsert', 'conversation_summary', cid)
      .some((ev) => ev.data.value?.archived === false));

    // A send unarchives and tells the sidebar.
    await v2(srv.base, 'PATCH', `/api/v2/conversations/${cid}`, token, { archived: true });
    assert.equal((await summary(srv.base, token, cid)).archived, true);
    const mark = events.events.length;
    const sent = await userMessage(srv.base, cid, token, 'hello');
    assert.equal(sent.status, 202, sent.text);
    assert.equal((await summary(srv.base, token, cid)).archived, false);
    await waitUntil(() => events.events.slice(mark).some((ev) => (
      ev.event === 'upsert' && ev.data?.entity === 'conversation_summary' && ev.data.id === cid && ev.data.value?.archived === false
    )));
    await waitV2(srv.base, cid, token, (body) => body.conversation.run.status === 'idle'
      && (body.items || []).some((item) => item.kind === 'assistant' && item.text === 'one'));

    // Same for a queued send.
    await v2(srv.base, 'PATCH', `/api/v2/conversations/${cid}`, token, { archived: true });
    const queued = await userMessage(srv.base, cid, token, 'later', 'queue');
    assert.equal(queued.status, 202, queued.text);
    assert.equal((await summary(srv.base, token, cid)).archived, false);
  } finally {
    events?.close();
    await stopServer(srv);
  }
});

test('a running conversation cannot be archived or deleted (409)', { timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-archive-run-'));
  const ready = path.join(dataDir, 'hold-ready');
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_HOLD: '1', WEFT_FAUX_HOLD_READY: ready },
  });
  try {
    const { token } = await readDiscovery(dataDir);
    const { conv } = await open(srv.base, 'run');
    const cid = conv.id;
    const sent = await userMessage(srv.base, cid, token, 'hold-me');
    assert.equal(sent.status, 202, sent.text);
    await waitForFile(ready);
    await waitV2(srv.base, cid, token, (body) => body.conversation.run.status === 'running');

    const archive = await v2(srv.base, 'PATCH', `/api/v2/conversations/${cid}`, token, { archived: true });
    assert.equal(archive.status, 409, archive.text);
    assert.equal(archive.body.code, 'E_CONVERSATION_RUNNING');
    assertChecked(`/api/v2/conversations/${cid}`, 'PATCH', 409, archive.body);
    assert.equal((await summary(srv.base, token, cid)).archived, false);

    const del = await v2(srv.base, 'DELETE', `/api/v2/conversations/${cid}`, token);
    assert.equal(del.status, 409, del.text);
    assert.equal(del.body.code, 'E_CONVERSATION_RUNNING');
    assertChecked(`/api/v2/conversations/${cid}`, 'DELETE', 409, del.body);
    assert.equal((await v2(srv.base, 'GET', `/api/v2/conversations/${cid}`, token)).status, 200);
    assert.ok(await summary(srv.base, token, cid));

    const stopped = await v2(srv.base, 'POST', `/api/v2/conversations/${cid}/stop`, token, {});
    assert.equal(stopped.status, 202);
    await waitV2(srv.base, cid, token, (body) => ['idle', 'stopped'].includes(body.conversation.run.status));
  } finally {
    await stopServer(srv);
  }
});

test('archived state survives a restart; delete removes the conversation, keeps workspace files, and survives a restart', { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-archive-del-'));
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({ turns: [{ text: 'first-reply' }, { text: 'second-reply' }] }));
  const env = { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script };
  let srv = await startServer({ token: TOKEN, dataDir, env });
  let keepId = '';
  let goneId = '';
  let wsPath = '';
  let events = null;
  try {
    let { token } = await readDiscovery(dataDir);
    const kept = await open(srv.base, 'keep');
    keepId = kept.conv.id;
    const gone = await open(srv.base, 'gone');
    goneId = gone.conv.id;
    wsPath = gone.ws.path;
    await writeFile(path.join(wsPath, 'precious.txt'), 'do not touch');

    const sent = await userMessage(srv.base, goneId, token, 'say hi');
    assert.equal(sent.status, 202, sent.text);
    await waitV2(srv.base, goneId, token, (body) => body.conversation.run.status === 'idle'
      && (body.items || []).some((item) => item.kind === 'assistant'));
    assert.equal((await v2(srv.base, 'PATCH', `/api/v2/conversations/${keepId}`, token, { archived: true })).status, 200);

    // Not found.
    const none = await v2(srv.base, 'DELETE', '/api/v2/conversations/does-not-exist', token);
    assert.equal(none.status, 404, none.text);
    assertChecked('/api/v2/conversations/does-not-exist', 'DELETE', 404, none.body);

    events = await openEvents({ port: srv.port, token, topics: `workspaces,conversation:${goneId}` });
    await waitUntil(() => events.events.some((ev) => ev.event === 'snapshot'));

    const del = await v2(srv.base, 'DELETE', `/api/v2/conversations/${goneId}`, token);
    assert.equal(del.status, 204, del.text);
    assert.equal(del.text, '');
    assertChecked(`/api/v2/conversations/${goneId}`, 'DELETE', 204, null);
    assert.equal((await v2(srv.base, 'GET', `/api/v2/conversations/${goneId}`, token)).status, 404);
    assert.equal((await v2(srv.base, 'DELETE', `/api/v2/conversations/${goneId}`, token)).status, 404);
    assert.equal(await summary(srv.base, token, goneId), null);
    assert.equal(await readFile(path.join(wsPath, 'precious.txt'), 'utf8'), 'do not touch');

    await waitUntil(() => eventsOf(events, 'remove', 'conversation_summary', goneId).length > 0);
    await waitUntil(() => eventsOf(events, 'remove', 'conversation', goneId).length > 0);
    // The workspace itself is still listed, and the other conversation is untouched.
    const side = await v2(srv.base, 'GET', '/api/v2/workspaces', token);
    assert.ok(side.body.workspaces.some((row) => row.id === gone.ws.id));
    assert.equal((await summary(srv.base, token, keepId)).archived, true);
    events.close();
    events = null;

    await stopServer(srv);
    srv = await startServer({ token: TOKEN, dataDir, env });
    token = (await readDiscovery(dataDir)).token;
    assert.equal((await summary(srv.base, token, keepId)).archived, true, 'archived survives a restart');
    assert.equal((await v2(srv.base, 'GET', `/api/v2/conversations/${goneId}`, token)).status, 404);
    assert.equal(await summary(srv.base, token, goneId), null);
    assert.equal(await readFile(path.join(wsPath, 'precious.txt'), 'utf8'), 'do not touch');
    // The restarted service still works.
    const again = await userMessage(srv.base, keepId, token, 'still here');
    assert.equal(again.status, 202, again.text);
    assert.equal((await summary(srv.base, token, keepId)).archived, false);
    await waitV2(srv.base, keepId, token, (body) => body.conversation.run.status === 'idle'
      && (body.items || []).some((item) => item.kind === 'assistant'));
  } finally {
    events?.close();
    await stopServer(srv);
  }
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(goneId).n, 0);
  } finally {
    db.close();
  }
});

test('an old database without the archived column migrates with archived = false', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-archive-mig-'));
  let srv = await startServer({ token: TOKEN, dataDir, env: { WEFT_LLM: 'faux' } });
  let cid = '';
  try {
    const { conv } = await open(srv.base, 'mig');
    cid = conv.id;
  } finally {
    await stopServer(srv);
  }
  const dbFile = path.join(dataDir, 'weft.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('ALTER TABLE conversations DROP COLUMN archived');
  db.close();
  srv = await startServer({ token: TOKEN, dataDir, env: { WEFT_LLM: 'faux' } });
  try {
    const { token } = await readDiscovery(dataDir);
    assert.equal((await summary(srv.base, token, cid)).archived, false);
    assert.equal((await v2(srv.base, 'PATCH', `/api/v2/conversations/${cid}`, token, { archived: true })).status, 200);
    assert.equal((await summary(srv.base, token, cid)).archived, true);
  } finally {
    await stopServer(srv);
  }
});

test('deleting a conversation with subagents removes it; deleting a forked parent leaves the fork usable', { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-archive-sub-'));
  const task = 'Say CHILD_OK';
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { tool: 'task', args: { description: 'Child check', prompt: task } },
      { text: 'parent-done' },
      { when: task, text: 'CHILD_OK' },
      { text: 'fork-follow-up' },
    ],
  }));
  const env = { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script, WEFT_RETRY_MAX: '2' };
  let srv = await startServer({ token: TOKEN, dataDir, env });
  try {
    let { token } = await readDiscovery(dataDir);
    const { ws, conv } = await open(srv.base, 'sub');
    const cid = conv.id;
    await request(srv.base, 'PATCH', `/api/conversations/${cid}`, { title: 'Parent plan' }, TOKEN);
    const sent = await userMessage(srv.base, cid, token, 'dispatch child');
    assert.equal(sent.status, 202, sent.text);
    const done = await waitV2(srv.base, cid, token, (body) => body.conversation.run.status === 'idle'
      && (body.items || []).some((item) => item.kind === 'assistant' && item.text === 'parent-done'), 60000);
    const legacy = await request(srv.base, 'GET', `/api/conversations/${cid}`, undefined, TOKEN);
    const agentIds = (legacy.body.agents || []).map((agent) => agent.id).filter((id) => String(id).includes(':sub:'));
    assert.ok(agentIds.length >= 1, 'the conversation has a subagent');
    const assistant = done.body.items.find((item) => item.kind === 'assistant' && item.text === 'parent-done');

    const fork = await v2(srv.base, 'POST', `/api/v2/conversations/${cid}/fork`, token, { entryId: assistant.entryId });
    assert.equal(fork.status, 201, fork.text);
    const forkId = fork.body.conversationId;
    const forkBefore = await waitV2(srv.base, forkId, token, (body) => body.conversation.forkedFrom);
    assert.equal(forkBefore.body.conversation.forkedFrom.conversationId, cid);

    const del = await v2(srv.base, 'DELETE', `/api/v2/conversations/${cid}`, token);
    assert.equal(del.status, 204, del.text);
    assert.equal((await v2(srv.base, 'GET', `/api/v2/conversations/${cid}`, token)).status, 404);
    for (const agentId of agentIds) {
      const child = await v2(srv.base, 'GET', `/api/v2/conversations/${cid}/subagents/${encodeURIComponent(agentId)}`, token);
      assert.equal(child.status, 404, 'subagents go with their parent');
    }
    assert.equal(await summary(srv.base, token, cid), null);

    // The fork keeps its parent's title and works without its parent.
    const forkRow = await summary(srv.base, token, forkId);
    assert.equal(forkRow.forkedFrom.conversationId, cid);
    assert.equal(forkRow.forkedFrom.title, 'Parent plan');
    const forkAfter = await v2(srv.base, 'GET', `/api/v2/conversations/${forkId}`, token);
    assert.equal(forkAfter.status, 200);
    assertChecked(`/api/v2/conversations/${forkId}`, 'GET', 200, forkAfter.body);
    assert.equal(forkAfter.body.conversation.forkedFrom.title, 'Parent plan');
    const next = await userMessage(srv.base, forkId, token, 'carry on');
    assert.equal(next.status, 202, next.text);
    await waitV2(srv.base, forkId, token, (body) => body.conversation.run.status === 'idle'
      && (body.items || []).some((item) => item.kind === 'assistant' && item.text === 'fork-follow-up'), 60000);

    await stopServer(srv);
    srv = await startServer({ token: TOKEN, dataDir, env });
    token = (await readDiscovery(dataDir)).token;
    assert.equal((await v2(srv.base, 'GET', `/api/v2/conversations/${cid}`, token)).status, 404);
    const forkRestart = await v2(srv.base, 'GET', `/api/v2/conversations/${forkId}`, token);
    assert.equal(forkRestart.status, 200);
    assert.equal(forkRestart.body.conversation.forkedFrom.conversationId, cid);
    const side = await v2(srv.base, 'GET', '/api/v2/workspaces', token);
    assert.ok(side.body.workspaces.some((row) => row.id === ws.id));
  } finally {
    await stopServer(srv);
  }
});
