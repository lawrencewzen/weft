import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseSSE } from '../../src/core/sse.mjs';
import { unifiedDiff } from '../../src/core/diff.mjs';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { compileSchema, validateResponse } from '../../src/v2/validate.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import { attachConversationTopic } from '../../src/v2/stream/conversation-topic.ts';
import { changeView, posixPath } from '../../src/v2/views/changes.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-changes-token';
const TOOL_EDIT = path.join(ROOT, 'tests/fixtures/tool-edit.json');
const spec = JSON.parse(await readFile(path.join(ROOT, 'contract/openapi.json'), 'utf8'));

function rewriteRefs(node) {
  if (Array.isArray(node)) {
    for (const item of node) rewriteRefs(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/schemas/')) {
    node.$ref = `#/$defs/${node.$ref.slice('#/components/schemas/'.length)}`;
  }
  for (const value of Object.values(node)) rewriteRefs(value);
}

function compileNamed(name) {
  const schemas = structuredClone(spec.components.schemas);
  const schema = schemas[name];
  assert.ok(schema, `missing schema ${name}`);
  rewriteRefs(schema);
  rewriteRefs(schemas);
  return compileSchema({ ...schema, $defs: schemas });
}

function assertSchema(name, data) {
  const validate = compileNamed(name);
  assert.equal(validate(data), true, `${name}: ${JSON.stringify(validate.errors)}`);
}

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function getV2(base, apiPath, token) {
  const res = await fetch(base + apiPath, { headers: token ? v2Headers(token) : {} });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text, headers: res.headers };
}

async function sendV2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? v2Headers(token) : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

function unifiedFromStructured(filePath, structured) {
  const parts = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const hunk of structured.hunks || []) {
    parts.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.op === 'ctx') parts.push(` ${line.text}`);
      else if (line.op === 'del') parts.push(`-${line.text}`);
      else parts.push(`+${line.text}`);
    }
  }
  return `${parts.join('\n')}\n`;
}

function parseCompleteSse(buf) {
  const parts = String(buf).split('\n\n');
  const rest = parts.pop() || '';
  const events = [];
  for (const part of parts) {
    if (!part.trim() || part.trim() === ':') continue;
    events.push(...parseSSE(`${part}\n\n`));
  }
  return { events, rest };
}

function openEvents({ port, token, topics, lang }) {
  const query = new URLSearchParams({ topics });
  if (lang) query.set('lang', lang);
  return new Promise((resolve, reject) => {
    let buf = '';
    const events = [];
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: `/api/v2/events?${query.toString()}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
      },
    }, (res) => {
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const parsed = parseCompleteSse(buf);
        buf = parsed.rest;
        events.push(...parsed.events);
      });
      resolve({
        req,
        res,
        events,
        close() { req.destroy(); },
      });
    });
    req.on('error', (err) => {
      const code = err && typeof err === 'object' ? err.code : '';
      if (code === 'ECONNRESET' || code === 'ABORT_ERR') return;
      reject(err);
    });
    req.end();
  });
}

async function waitEvents(session, ready, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (session.res.statusCode && session.res.statusCode !== 200) {
      throw new Error(`events status ${session.res.statusCode}`);
    }
    if (ready(session.events)) return session.events;
    await sleep(30);
  }
  throw new Error(`events did not match: ${JSON.stringify(session.events.map((ev) => ({ event: ev.event, entity: ev.data?.entity, id: ev.data?.id })))}`);
}

function changeFromEvents(events, filePath) {
  let current = null;
  for (const ev of events) {
    if (ev.event === 'snapshot') {
      const hit = (ev.data?.entities || []).find((item) => item.entity === 'change' && item.id === filePath);
      current = hit ? hit.value : null;
    } else if (ev.event === 'upsert' && ev.data?.entity === 'change' && ev.data.id === filePath) {
      current = ev.data.value;
    } else if (ev.event === 'remove' && ev.data?.entity === 'change' && ev.data.id === filePath) {
      current = null;
    }
  }
  return current;
}

async function openConversation(base) {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'v2-chg' }, TOKEN);
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'chg' }, TOKEN);
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return { ws: ws.body, conv: conv.body };
}

async function waitFinished(base, id, timeoutMs = 25000) {
  const started = Date.now();
  let body;
  while (Date.now() - started < timeoutMs) {
    const got = await request(base, 'GET', `/api/conversations/${id}`, undefined, TOKEN);
    body = got.body;
    if (body?.status === 'done' || body?.status === 'failed') return body;
    await sleep(50);
  }
  throw new Error(`conversation ${id} did not finish: ${JSON.stringify(body)}`);
}

test('changeView normalizes win32 separators and maps error', () => {
  const win = path.win32.join('src', 'deep', 'file.ts');
  const view = changeView({ path: win, added: 2, removed: 1 });
  assert.equal(view.path, 'src/deep/file.ts');
  assert.equal(posixPath(win), 'src/deep/file.ts');
  assert.equal(view.added, 2);
  assert.equal(view.removed, 1);
  assert.equal(view.error, null);
  assert.equal(view.by, null);
  assert.equal(changeView({ path: 'a.txt', error: '文件过大' }).error, '文件过大');
});

test('changeView maps main and sub-agent by', () => {
  assert.deepEqual(changeView({ path: 'a.txt', added: 1, by: { kind: 'main' } }).by, { kind: 'main' });
  assert.deepEqual(
    changeView({
      path: 'b.txt',
      added: 1,
      by: { kind: 'subagent', agentId: 'c1:sub:9', name: 'scout' },
    }).by,
    { kind: 'subagent', agentId: 'c1:sub:9', name: 'scout' },
  );
  assert.equal(changeView({ path: 'c.txt', by: { kind: 'subagent', name: 'x' } }).by, null);
});

test('in-process: change entities upsert and remove with notify', async () => {
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  let rows = [{ path: path.win32.join('notes', 'a.txt'), added: 2, removed: 0 }];
  const topic = attachConversationTopic(hub, {
    loadConversation: async (id) => (id === 'c1' ? {
      presented: {
        id: 'c1',
        workspaceId: 'w1',
        workspacePath: '',
        title: 't',
        updatedAt: 1,
        status: 'idle',
        messages: [],
        usage: null,
      },
      subagents: [],
      modelTarget: null,
      window: 128000,
    } : null),
    loadChanges: async () => rows,
    subscribe: () => () => {},
    coalesceMs: 10,
    log() {},
  });
  try {
    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      send: (frame) => frames.push(frame),
    });
    await session.ready;
    const snap = frames.find((frame) => frame.event === 'snapshot');
    const changeEnt = snap.data.entities.find((item) => item.entity === 'change');
    assert.ok(changeEnt, JSON.stringify(snap.data.entities.map((item) => item.entity)));
    assert.equal(changeEnt.id, 'notes/a.txt');
    assertSchema('Change', changeEnt.value);
    assert.equal(changeEnt.value.path, 'notes/a.txt');
    assert.equal(changeEnt.value.added, 2);
    assert.equal(changeEnt.value.error, null);

    rows = [{ path: 'notes/a.txt', added: 0, removed: 0 }];
    topic.notify('c1');
    const upsertAt = Date.now();
    let upsert;
    while (Date.now() - upsertAt < 2000) {
      upsert = [...frames].reverse().find((frame) => (
        frame.event === 'upsert' && frame.data.entity === 'change' && frame.data.value?.added === 0
      ));
      if (upsert) break;
      await sleep(20);
    }
    assert.ok(upsert);
    assert.equal(upsert.data.value.added, 0);

    rows = [];
    topic.notify('c1');
    const removeAt = Date.now();
    let removed;
    while (Date.now() - removeAt < 2000) {
      removed = [...frames].reverse().find((frame) => frame.event === 'remove' && frame.data.entity === 'change');
      if (removed) break;
      await sleep(20);
    }
    assert.equal(removed?.data.id, 'notes/a.txt');
  } finally {
    topic.dispose();
    hub.dispose();
  }
});

test('in-process: write/edit does not push a stale +0 change before disk catches up', async () => {
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  const listeners = new Set();
  let rows = [];
  const presented = {
    id: 'c1',
    workspaceId: 'w1',
    workspacePath: '',
    title: 't',
    updatedAt: 1,
    status: 'idle',
    messages: [],
    usage: null,
  };
  const topic = attachConversationTopic(hub, {
    loadConversation: async (id) => (id === 'c1' ? {
      presented,
      subagents: [],
      modelTarget: null,
      window: 128000,
    } : null),
    loadChanges: async () => rows,
    subscribe: (_cid, fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    coalesceMs: 10,
    log() {},
  });
  const emit = (ev) => {
    for (const fn of listeners) fn(ev);
  };
  const changeUpserts = (frames) => frames.filter((frame) => (
    frame.event === 'upsert' && frame.data.entity === 'change' && frame.data.id === 'note.txt'
  ));
  async function waitFor(frames, ready, timeoutMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (ready(frames)) return;
      await sleep(15);
    }
    throw new Error(`did not match: ${JSON.stringify(frames.filter((frame) => frame.data?.entity === 'change' || frame.event === 'snapshot'))}`);
  }
  try {
    const frames = [];
    const session = hub.connect({
      topics: ['conversation:c1'],
      send: (frame) => frames.push(frame),
    });
    await session.ready;

    rows = [{ path: 'note.txt', added: 0, removed: 0 }];
    emit({
      event: 'tool.start',
      data: { tool: { id: 'w1', name: 'write', status: 'running', input: { path: 'note.txt' }, path: 'note.txt' } },
    });
    await sleep(50);
    assert.equal(changeUpserts(frames).length, 0, 'write start must not publish +0');

    emit({
      event: 'tool.end',
      data: { tool: { id: 'w1', name: 'write', status: 'completed', input: { path: 'note.txt' }, path: 'note.txt', added: 1, removed: 0 } },
    });
    await sleep(40);
    assert.equal(
      changeUpserts(frames).some((frame) => frame.data.value?.added === 0),
      false,
      'stale empty disk after write must not be the first change',
    );

    rows = [{ path: 'note.txt', added: 1, removed: 0 }];
    await waitFor(frames, (list) => changeUpserts(list).some((frame) => frame.data.value?.added === 1));
    assert.equal(changeUpserts(frames)[0].data.value.added, 1);

    rows = [{ path: 'note.txt', added: 0, removed: 0 }];
    emit({
      event: 'tool.start',
      data: { tool: { id: 'e1', name: 'edit', status: 'running', input: { path: 'note.txt' }, path: 'note.txt' } },
    });
    await sleep(50);
    const afterEditStart = [...changeUpserts(frames)].pop();
    assert.equal(afterEditStart.data.value.added, 1, 'in-flight edit must keep the last real change');

    emit({
      event: 'tool.end',
      data: { tool: { id: 'e1', name: 'edit', status: 'completed', input: { path: 'note.txt' }, path: 'note.txt', added: 1, removed: 0 } },
    });
    rows = [{ path: 'note.txt', added: 2, removed: 0 }];
    await waitFor(frames, (list) => changeUpserts(list).some((frame) => frame.data.value?.added === 2));
    assert.equal(
      changeUpserts(frames).some((frame) => frame.data.value?.added === 0),
      false,
    );
  } finally {
    topic.dispose();
    hub.dispose();
  }
});

test('tool-edit snapshot has relative change; save back matches old changes', { timeout: 60_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: TOOL_EDIT },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { ws, conv } = await openConversation(srv.base);
    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
    });
    await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done));

    await waitEvents(session, (list) => changeFromEvents(list, 'note.txt') != null);
    const live = changeFromEvents(session.events, 'note.txt');
    assertSchema('Change', live);
    assert.equal(live.path, 'note.txt');
    assert.equal(live.path.includes('\\'), false);
    assert.equal(live.error, null);
    assert.equal(live.added > 0, true);
    assert.deepEqual(live.by, { kind: 'main' });

    const oldChanges = await request(srv.base, 'GET', `/api/conversations/${conv.id}/changes`, undefined, TOKEN);
    assert.equal(oldChanges.status, 200, JSON.stringify(oldChanges.body));
    const oldNote = oldChanges.body.find((row) => posixPath(row.path) === 'note.txt');
    assert.ok(oldNote, JSON.stringify(oldChanges.body));
    assert.equal(live.added, oldNote.added);
    assert.equal(live.removed, oldNote.removed);

    const oldDiff = await request(srv.base, 'GET', `/api/conversations/${conv.id}/diff?path=${encodeURIComponent('note.txt')}`, undefined, TOKEN);
    assert.equal(oldDiff.status, 200, JSON.stringify(oldDiff.body));
    const v2Diff = await getV2(srv.base, `/api/v2/conversations/${conv.id}/diff?path=${encodeURIComponent('note.txt')}`, discovery.token);
    assert.equal(v2Diff.status, 200, v2Diff.text);
    const diffChecked = validateResponse(`/api/v2/conversations/${conv.id}/diff`, 'GET', 200, v2Diff.body);
    assert.equal(diffChecked.ok, true, JSON.stringify(diffChecked.errors));
    assert.equal(v2Diff.body.tooLarge, false);
    assert.equal(v2Diff.body.path, 'note.txt');
    assert.equal(unifiedFromStructured(v2Diff.body.path, v2Diff.body), oldDiff.body.unified);
    assert.equal(v2Diff.body.hunks.some((hunk) => hunk.lines.some((line) => line.op === 'add')), true);

    const missing = await getV2(srv.base, `/api/v2/conversations/${conv.id}/diff?path=${encodeURIComponent('nope.txt')}`, discovery.token);
    assert.equal(missing.status, 404);
    const missingChecked = validateResponse(`/api/v2/conversations/${conv.id}/diff`, 'GET', 404, missing.body);
    assert.equal(missingChecked.ok, true, JSON.stringify(missingChecked.errors));

    const disk = await readFile(path.join(ws.path, 'note.txt'), 'utf8');
    const gotFile = await getV2(srv.base, `/api/v2/workspaces/${ws.id}/files?path=${encodeURIComponent('note.txt')}`, discovery.token);
    assert.equal(gotFile.status, 200, gotFile.text);
    assert.equal(gotFile.body.text, disk);
    const saved = await sendV2(srv.base, 'PUT', `/api/v2/workspaces/${ws.id}/files`, discovery.token, {
      path: 'note.txt',
      text: oldDiff.body.before ?? '',
      baseVersion: gotFile.body.version,
    });
    assert.equal(saved.status, 200, saved.text);

    await waitEvents(session, (list) => {
      const ch = changeFromEvents(list, 'note.txt');
      if (!ch) return true;
      return ch.added === 0 && ch.removed === 0;
    });
    session.close();

    const afterOld = await request(srv.base, 'GET', `/api/conversations/${conv.id}/changes`, undefined, TOKEN);
    assert.equal(afterOld.status, 200, JSON.stringify(afterOld.body));
    const afterNote = afterOld.body.find((row) => posixPath(row.path) === 'note.txt');
    const afterLive = changeFromEvents(session.events, 'note.txt');
    if (afterNote) {
      assert.equal(afterNote.added, 0);
      assert.equal(afterNote.removed, 0);
      assert.ok(afterLive);
      assert.equal(afterLive.added, 0);
      assert.equal(afterLive.removed, 0);
    } else {
      assert.equal(afterLive, null);
    }
  } finally {
    await stopServer(srv);
  }
});

test('structured diff covers new file, deleted content, and too-large', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-v2-diff-'));
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { tool: 'write', args: { path: 'kept.txt', content: 'a\n' }, id: 'w1' },
      { tool: 'write', args: { path: 'new.txt', content: 'hello\nworld\n' }, id: 'w2' },
      { text: 'done' },
    ],
  }));
  const srv = await startServer({
    dataDir,
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { ws, conv } = await openConversation(srv.base);
    await writeFile(path.join(ws.path, 'kept.txt'), 'a\nb\nc\n');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done));

    for (const filePath of ['new.txt', 'kept.txt']) {
      const oldDiff = await request(srv.base, 'GET', `/api/conversations/${conv.id}/diff?path=${encodeURIComponent(filePath)}`, undefined, TOKEN);
      assert.equal(oldDiff.status, 200, JSON.stringify(oldDiff.body));
      const v2Diff = await getV2(srv.base, `/api/v2/conversations/${conv.id}/diff?path=${encodeURIComponent(filePath)}`, discovery.token);
      assert.equal(v2Diff.status, 200, v2Diff.text);
      const checked = validateResponse(`/api/v2/conversations/${conv.id}/diff`, 'GET', 200, v2Diff.body);
      assert.equal(checked.ok, true, JSON.stringify(checked.errors));
      assert.equal(unifiedFromStructured(v2Diff.body.path, v2Diff.body), oldDiff.body.unified);
      assert.equal(unifiedFromStructured(v2Diff.body.path, v2Diff.body), unifiedDiff(filePath, oldDiff.body.before, oldDiff.body.after));
    }

    const newDiff = await getV2(srv.base, `/api/v2/conversations/${conv.id}/diff?path=${encodeURIComponent('new.txt')}`, discovery.token);
    assert.equal(newDiff.body.hunks.some((hunk) => hunk.lines.some((line) => line.op === 'add')), true);
    const delDiff = await getV2(srv.base, `/api/v2/conversations/${conv.id}/diff?path=${encodeURIComponent('kept.txt')}`, discovery.token);
    assert.equal(delDiff.body.hunks.some((hunk) => hunk.lines.some((line) => line.op === 'del')), true);

    const big = `${'x'.repeat(1024 * 1024 + 8)}\n`;
    await writeFile(path.join(ws.path, 'new.txt'), big);
    const large = await getV2(srv.base, `/api/v2/conversations/${conv.id}/diff?path=${encodeURIComponent('new.txt')}`, discovery.token);
    assert.equal(large.status, 200, large.text);
    const largeChecked = validateResponse(`/api/v2/conversations/${conv.id}/diff`, 'GET', 200, large.body);
    assert.equal(largeChecked.ok, true, JSON.stringify(largeChecked.errors));
    assert.equal(large.body.tooLarge, true);
    assert.deepEqual(large.body.hunks, []);
  } finally {
    await stopServer(srv);
  }
});

function subagentsOf(body) {
  return (body?.agents || []).filter((agent) => String(agent.id || '').includes(':sub:'));
}

test('only a sub-agent write appears on the main conversation change list', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-v2-chg-sub-'));
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { tool: 'delegate', args: { task: 'Write child.txt with CHILD_FILE' } },
      { text: 'parent-done' },
      { when: 'Write child.txt', tool: 'write', args: { path: 'child.txt', content: 'CHILD_FILE\n' }, id: 'cw' },
      { when: 'Write child.txt', text: 'wrote child' },
    ],
  }));
  const srv = await startServer({
    dataDir,
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script, WEFT_RETRY_MAX: '2' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { ws, conv } = await openConversation(srv.base);
    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
    });
    await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done));

    await waitEvents(session, (list) => changeFromEvents(list, 'child.txt') != null);
    const live = changeFromEvents(session.events, 'child.txt');
    assertSchema('Change', live);
    assert.equal(live.path, 'child.txt');
    assert.equal(live.by?.kind, 'subagent');
    assert.match(String(live.by?.agentId || ''), /:sub:/);
    assert.equal(typeof live.by?.name, 'string');
    assert.equal(live.by.name.length > 0, true);

    const oldChanges = await request(srv.base, 'GET', `/api/conversations/${conv.id}/changes`, undefined, TOKEN);
    assert.equal(oldChanges.status, 200, JSON.stringify(oldChanges.body));
    assert.equal(oldChanges.body.length, 1, JSON.stringify(oldChanges.body));
    const row = oldChanges.body.find((item) => posixPath(item.path) === 'child.txt');
    assert.ok(row, JSON.stringify(oldChanges.body));
    assert.equal(row.by?.kind, 'subagent');
    assert.equal(row.by.agentId, live.by.agentId);
    assert.equal(row.by.name, live.by.name);
    const child = subagentsOf(done).find((agent) => agent.id === row.by.agentId);
    assert.ok(child, JSON.stringify(done.agents));
    assert.equal(await readFile(path.join(ws.path, 'child.txt'), 'utf8'), 'CHILD_FILE\n');
    session.close();
  } finally {
    await stopServer(srv);
  }
});

test('main then sub-agent on the same file: earliest baseline, last writer; revert restores it', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-v2-chg-both-'));
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { tool: 'write', args: { path: 'shared.txt', content: 'from-main\n' }, id: 'mw' },
      { tool: 'delegate', args: { task: 'Edit shared.txt to add from-child' } },
      { text: 'parent-done' },
      {
        when: 'Edit shared.txt',
        tool: 'edit',
        args: { path: 'shared.txt', edits: [{ oldText: 'from-main', newText: 'from-main\nfrom-child' }] },
        id: 'ce',
      },
      { when: 'Edit shared.txt', text: 'edited' },
    ],
  }));
  const srv = await startServer({
    dataDir,
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script, WEFT_RETRY_MAX: '2' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { ws, conv } = await openConversation(srv.base);
    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: `conversation:${conv.id}`,
    });
    await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal(await readFile(path.join(ws.path, 'shared.txt'), 'utf8'), 'from-main\nfrom-child\n');

    await waitEvents(session, (list) => {
      const ch = changeFromEvents(list, 'shared.txt');
      return ch != null && ch.by?.kind === 'subagent';
    });
    const live = changeFromEvents(session.events, 'shared.txt');
    assertSchema('Change', live);
    assert.equal(live.by?.kind, 'subagent');

    const oldChanges = await request(srv.base, 'GET', `/api/conversations/${conv.id}/changes`, undefined, TOKEN);
    assert.equal(oldChanges.status, 200, JSON.stringify(oldChanges.body));
    assert.equal(oldChanges.body.length, 1, JSON.stringify(oldChanges.body));
    const row = oldChanges.body[0];
    assert.equal(posixPath(row.path), 'shared.txt');
    assert.equal(row.by?.kind, 'subagent');
    assert.equal(row.by.agentId, live.by.agentId);

    const oldDiff = await request(srv.base, 'GET', `/api/conversations/${conv.id}/diff?path=${encodeURIComponent('shared.txt')}`, undefined, TOKEN);
    assert.equal(oldDiff.status, 200, JSON.stringify(oldDiff.body));
    assert.equal(oldDiff.body.before, '');
    assert.equal(oldDiff.body.after, 'from-main\nfrom-child\n');

    const gotFile = await getV2(srv.base, `/api/v2/workspaces/${ws.id}/files?path=${encodeURIComponent('shared.txt')}`, discovery.token);
    assert.equal(gotFile.status, 200, gotFile.text);
    const saved = await sendV2(srv.base, 'PUT', `/api/v2/workspaces/${ws.id}/files`, discovery.token, {
      path: 'shared.txt',
      text: oldDiff.body.before ?? '',
      baseVersion: gotFile.body.version,
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(await readFile(path.join(ws.path, 'shared.txt'), 'utf8'), '');

    await waitEvents(session, (list) => {
      const ch = changeFromEvents(list, 'shared.txt');
      if (!ch) return true;
      return ch.added === 0 && ch.removed === 0;
    });
    session.close();

    const afterOld = await request(srv.base, 'GET', `/api/conversations/${conv.id}/changes`, undefined, TOKEN);
    assert.equal(afterOld.status, 200, JSON.stringify(afterOld.body));
    const afterNote = afterOld.body.find((item) => posixPath(item.path) === 'shared.txt');
    if (afterNote) {
      assert.equal(afterNote.added, 0);
      assert.equal(afterNote.removed, 0);
    }
  } finally {
    await stopServer(srv);
  }
});
