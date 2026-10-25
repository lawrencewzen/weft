import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { toolGroupSummaryView } from '../../src/v2/views/tools.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-conv-http-token';
const BASIC = path.join(ROOT, 'tests/fixtures/basic.json');

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
