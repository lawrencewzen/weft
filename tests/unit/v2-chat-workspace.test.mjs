import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-chat-ws-token';
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
  return { status: res.status, body: parsed, text, headers: res.headers };
}

function assertChecked(apiPath, method, status, body) {
  const checked = validateResponse(apiPath, method, status, body);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
}

test('POST /api/v2/conversations creates a chat workspace and directory', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: BASIC },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const created = await sendV2(srv.base, 'POST', '/api/v2/conversations', discovery.token, {});
    assert.equal(created.status, 201, created.text);
    assert.equal(created.headers.get('weft-protocol'), PROTOCOL_VERSION);
    assertChecked('/api/v2/conversations', 'POST', 201, created.body);
    assert.ok(created.body.id);
    assert.ok(created.body.workspaceId);
    assert.equal(created.body.status, 'idle');

    const chatDir = path.join(srv.dataDir, 'chats', created.body.id);
    assert.equal(existsSync(chatDir), true);

    const listed = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
    assert.equal(listed.status, 200, listed.text);
    assertChecked('/api/v2/workspaces', 'GET', 200, listed.body);
    const ws = listed.body.workspaces.find((row) => row.id === created.body.workspaceId);
    assert.ok(ws, 'chat workspace is in the list');
    assert.equal(ws.kind, 'chat');
    assert.equal(ws.name, '对话');
    assert.equal(ws.path, chatDir);
    assert.equal(ws.git, null);
    assert.equal(listed.body.conversations.some((row) => row.id === created.body.id), true);
    assert.equal(created.body.workspaceId, ws.id);

    const project = await request(srv.base, 'POST', '/api/workspaces', { name: 'side' }, TOKEN);
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const afterProject = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
    const projectView = afterProject.body.workspaces.find((row) => row.id === project.body.id);
    assert.equal(projectView.kind, 'project');

    const en = await sendV2(srv.base, 'POST', '/api/v2/conversations?lang=en', discovery.token, {});
    assert.equal(en.status, 201, en.text);
    assertChecked('/api/v2/conversations', 'POST', 201, en.body);
    const enList = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
    const enWs = enList.body.workspaces.find((row) => row.id === en.body.workspaceId);
    assert.equal(enWs.kind, 'chat');
    assert.equal(enWs.name, 'Chat');

    const titled = await sendV2(srv.base, 'POST', '/api/v2/conversations', discovery.token, { title: '正则' });
    assert.equal(titled.status, 201, titled.text);
    const titledList = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
    const titledWs = titledList.body.workspaces.find((row) => row.id === titled.body.workspaceId);
    assert.equal(titledWs.name, '正则');

    const removed = await sendV2(srv.base, 'DELETE', `/api/v2/workspaces/${ws.id}`, discovery.token);
    assert.equal(removed.status, 400, removed.text);
    assert.equal(removed.body.code, 'E_BAD_REQUEST');
    assertChecked(`/api/v2/workspaces/${ws.id}`, 'DELETE', 400, removed.body);
    const stillThere = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
    assert.equal(stillThere.body.workspaces.some((row) => row.id === ws.id), true);

    const git = await sendV2(srv.base, 'POST', `/api/v2/workspaces/${ws.id}/git/refresh`, discovery.token, {});
    assert.equal(git.status, 200, git.text);
    assertChecked(`/api/v2/workspaces/${ws.id}/git/refresh`, 'POST', 200, git.body);
    assert.equal(git.body.git, null);
    assert.equal(git.body.kind, 'chat');
  } finally {
    await stopServer(srv);
  }
});
