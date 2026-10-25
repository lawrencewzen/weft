import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { toolGroupSummaryView } from '../../src/v2/views/tools.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-conv-http-token';
const BASIC = path.join(ROOT, 'tests/fixtures/basic.json');
const PATH_REFS = path.join(ROOT, 'tests/fixtures/v2-path-refs.json');
const SUBAGENT_REPORT = path.join(ROOT, 'tests/fixtures/v2-subagent-report.json');
const APP_JS = ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n');

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

async function openConversation(base) {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'v2-snap' }, TOKEN);
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'snap' }, TOKEN);
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return { ws: ws.body, conv: conv.body };
}

async function waitFinished(base, id, timeoutMs = 20000) {
  const started = Date.now();
  let body;
  while (Date.now() - started < timeoutMs) {
    const got = await request(base, 'GET', `/api/conversations/${id}`, undefined, TOKEN);
    body = got.body;
    if (body?.status === 'done' || body?.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`conversation ${id} did not finish: ${JSON.stringify(body)}`);
}

async function waitV2(base, id, token, ready, timeoutMs = 35000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await getV2(base, `/api/v2/conversations/${id}`, token);
    if (last.status === 200 && ready(last.body)) return last;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`v2 snapshot did not match: ${JSON.stringify(last?.body)}`);
}

function assertNoAbsWorkspace(text, workspacePath, label) {
  const raw = String(text ?? '');
  const abs = String(workspacePath || '').replaceAll('\\', '/');
  assert.equal(raw.includes(workspacePath), false, `${label} contains workspacePath: ${raw}`);
  if (abs && abs !== workspacePath) {
    assert.equal(raw.includes(abs), false, `${label} contains slash workspacePath: ${raw}`);
  }
}

test('GET /api/v2/conversations/{id} returns a contract snapshot with user, assistant, tool_group', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: BASIC },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base);
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done));

    const zh = await getV2(srv.base, `/api/v2/conversations/${conv.id}`, discovery.token);
    assert.equal(zh.status, 200, zh.text);
    assert.equal(zh.headers.get('weft-protocol'), PROTOCOL_VERSION);
    const checked = validateResponse(`/api/v2/conversations/${conv.id}`, 'GET', 200, zh.body);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));

    const kinds = zh.body.items.map((item) => item.kind);
    assert.equal(kinds.includes('user'), true, JSON.stringify(kinds));
    assert.equal(kinds.includes('assistant'), true, JSON.stringify(kinds));
    assert.equal(kinds.includes('tool_group'), true, JSON.stringify(kinds));
    assert.deepEqual(zh.body.conversation.itemIds, zh.body.items.map((item) => item.id));
    assert.equal(zh.body.conversation.id, conv.id);
    assert.equal(zh.body.conversation.run.status, 'idle');
    assert.equal(zh.body.conversation.status, 'idle');
    assert.equal(zh.body.tools.length > 0, true);
    const group = zh.body.items.find((item) => item.kind === 'tool_group');
    assert.equal(group.live, false);
    assert.equal(typeof group.summary.text, 'string');
    assert.ok(group.summary.text);

    const en = await getV2(srv.base, `/api/v2/conversations/${conv.id}?lang=en`, discovery.token);
    assert.equal(en.status, 200, en.text);
    const enChecked = validateResponse(`/api/v2/conversations/${conv.id}`, 'GET', 200, en.body);
    assert.equal(enChecked.ok, true, JSON.stringify(enChecked.errors));
    const enGroup = en.body.items.find((item) => item.kind === 'tool_group');
    assert.notEqual(enGroup.summary.text, group.summary.text);
    const rawTools = (done.messages || []).filter((m) => m.role === 'tool').map((m) => m.tool);
    assert.equal(group.summary.text, toolGroupSummaryView(rawTools, 'zh').text);
    assert.equal(enGroup.summary.text, toolGroupSummaryView(rawTools, 'en').text);

    const missing = await getV2(srv.base, '/api/v2/conversations/does-not-exist', discovery.token);
    assert.equal(missing.status, 404);
    const missingChecked = validateResponse('/api/v2/conversations/does-not-exist', 'GET', 404, missing.body);
    assert.equal(missingChecked.ok, true, JSON.stringify(missingChecked.errors));
    assert.equal(typeof missing.body.error, 'string');

    const unauth = await getV2(srv.base, `/api/v2/conversations/${conv.id}`);
    assert.equal(unauth.status, 401);
    const unauthChecked = validateResponse(`/api/v2/conversations/${conv.id}`, 'GET', 401, unauth.body);
    assert.equal(unauthChecked.ok, true, JSON.stringify(unauthChecked.errors));
  } finally {
    await stopServer(srv);
  }
});

test('GET /api/v2/conversations/{id} uses the workspace path for read tools and inline pathRefs', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: PATH_REFS },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { ws, conv } = await openConversation(srv.base);
    await mkdir(path.join(ws.path, 'src'), { recursive: true });
    await writeFile(path.join(ws.path, 'src/app.js'), APP_JS);

    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done));

    const snap = await getV2(srv.base, `/api/v2/conversations/${conv.id}`, discovery.token);
    assert.equal(snap.status, 200, snap.text);
    const checked = validateResponse(`/api/v2/conversations/${conv.id}`, 'GET', 200, snap.body);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));

    const assistant = snap.body.items.find((item) => item.kind === 'assistant');
    assert.ok(assistant, JSON.stringify(snap.body.items.map((item) => item.kind)));
    assert.match(assistant.text, /src\/app\.js:3/);
    assert.match(assistant.text, /nope\/missing\.ts/);
    assert.deepEqual(assistant.pathRefs, [{ text: 'src/app.js:3', path: 'src/app.js', line: 3 }]);
    assert.equal(assistant.pathRefs.some((ref) => ref.path === 'nope/missing.ts' || ref.text.includes('nope/missing.ts')), false);

    const read = snap.body.tools.find((tool) => tool.kind === 'read');
    assert.ok(read, JSON.stringify(snap.body.tools));
    assert.equal(read.path, 'src/app.js');
    assert.equal(path.isAbsolute(read.path), false);
    assertNoAbsWorkspace(read.path, ws.path, 'tool.path');
    assertNoAbsWorkspace(read.heading?.title, ws.path, 'heading.title');
    assertNoAbsWorkspace(read.heading?.detail, ws.path, 'heading.detail');
    assertNoAbsWorkspace(read.output?.preview, ws.path, 'output.preview');
  } finally {
    await stopServer(srv);
  }
});

test('GET /api/v2/conversations/{id} fills subagentId on a spawned subagent report', { timeout: 60_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: SUBAGENT_REPORT },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base);
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: '请派子代理' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));

    const snap = await waitV2(srv.base, conv.id, discovery.token, (body) => (
      (body?.items || []).some((item) => item.kind === 'subagent_report')
    ));
    const checked = validateResponse(`/api/v2/conversations/${conv.id}`, 'GET', 200, snap.body);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));

    const report = snap.body.items.find((item) => item.kind === 'subagent_report');
    assert.ok(report, JSON.stringify(snap.body.items.map((item) => item.kind)));
    assert.equal(report.name, '巡查');
    assert.equal(report.reportKind, 'answered');
    assert.match(String(report.subagentId || ''), /:sub:/);

    const live = await request(srv.base, 'GET', `/api/conversations/${conv.id}`, undefined, TOKEN);
    assert.equal(live.status, 200, JSON.stringify(live.body));
    const child = (live.body.agents || []).find((agent) => String(agent.id || '').includes(':sub:') && agent.name === '巡查');
    assert.ok(child, JSON.stringify(live.body.agents));
    assert.equal(report.subagentId, child.id);
  } finally {
    await stopServer(srv);
  }
});
