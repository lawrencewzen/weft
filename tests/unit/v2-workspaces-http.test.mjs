import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const TOKEN = 'v2-ws-http-token';
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

test('GET /api/v2/workspaces returns a contract snapshot; create then list; remove idle 200', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: BASIC },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const empty = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
    assert.equal(empty.status, 200, empty.text);
    assert.equal(empty.headers.get('weft-protocol'), PROTOCOL_VERSION);
    assertChecked('/api/v2/workspaces', 'GET', 200, empty.body);
    assert.deepEqual(empty.body, { workspaces: [], conversations: [] });

    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'side' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const created = await sendV2(
      srv.base,
      'POST',
      `/api/v2/workspaces/${ws.body.id}/conversations`,
      discovery.token,
      { title: 'first' },
    );
    assert.equal(created.status, 201, created.text);
    assertChecked(`/api/v2/workspaces/${ws.body.id}/conversations`, 'POST', 201, created.body);
    assert.equal(created.body.title, 'first');
    assert.equal(created.body.workspaceId, ws.body.id);
    assert.equal(created.body.status, 'idle');
    assert.equal(created.body.runningAgents, 0);
    assert.equal(created.body.subagents, null);
    assert.equal(created.body.archived, false);

    const listed = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
    assert.equal(listed.status, 200, listed.text);
    assertChecked('/api/v2/workspaces', 'GET', 200, listed.body);
    assert.equal(listed.body.workspaces.length, 1);
    assert.equal(listed.body.workspaces[0].id, ws.body.id);
    assert.equal(listed.body.workspaces[0].conversationCount, 1);
    assert.equal(listed.body.workspaces[0].runningCount, 0);
    assert.equal(listed.body.conversations.length, 1);
    assert.equal(listed.body.conversations[0].id, created.body.id);

    const missingWs = await sendV2(srv.base, 'POST', '/api/v2/workspaces/nope/conversations', discovery.token, {});
    assert.equal(missingWs.status, 404);
    assertChecked('/api/v2/workspaces/nope/conversations', 'POST', 404, missingWs.body);

    const removed = await sendV2(srv.base, 'DELETE', `/api/v2/workspaces/${ws.body.id}`, discovery.token);
    assert.equal(removed.status, 200, removed.text);
    assertChecked(`/api/v2/workspaces/${ws.body.id}`, 'DELETE', 200, removed.body);
    assert.deepEqual(removed.body, { removed: true });

    const after = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
    assert.equal(after.status, 200);
    assert.equal(after.body.workspaces.length, 0);
    assert.equal(after.body.conversations.length, 0);

    const gone = await sendV2(srv.base, 'DELETE', `/api/v2/workspaces/${ws.body.id}`, discovery.token);
    assert.equal(gone.status, 404);
    assertChecked(`/api/v2/workspaces/${ws.body.id}`, 'DELETE', 404, gone.body);

    const unauth = await getV2(srv.base, '/api/v2/workspaces');
    assert.equal(unauth.status, 401);
    assertChecked('/api/v2/workspaces', 'GET', 401, unauth.body);

    const gitMissing = await sendV2(srv.base, 'POST', '/api/v2/workspaces/nope/git/refresh', discovery.token, {});
    assert.equal(gitMissing.status, 404);
    assertChecked('/api/v2/workspaces/nope/git/refresh', 'POST', 404, gitMissing.body);
  } finally {
    await stopServer(srv);
  }
});

test('DELETE /api/v2/workspaces/{id} is 409 E_WS_BUSY while a conversation is running', { timeout: 45_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-v2-ws-busy-'));
  const ready = path.join(dataDir, 'hold-ready');
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_HOLD: '1',
      WEFT_FAUX_HOLD_READY: ready,
    },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'busy' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const conv = await sendV2(
      srv.base,
      'POST',
      `/api/v2/workspaces/${ws.body.id}/conversations`,
      discovery.token,
      { title: 'busy' },
    );
    assert.equal(conv.status, 201, conv.text);
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'go' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));

    const started = Date.now();
    let listed;
    while (Date.now() - started < 20000) {
      listed = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
      if (listed.body?.conversations?.[0]?.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(listed.body.conversations[0].status, 'running', JSON.stringify(listed.body));
    assert.equal(listed.body.workspaces[0].runningCount, 1);

    const busy = await sendV2(srv.base, 'DELETE', `/api/v2/workspaces/${ws.body.id}`, discovery.token);
    assert.equal(busy.status, 409, busy.text);
    assertChecked(`/api/v2/workspaces/${ws.body.id}`, 'DELETE', 409, busy.body);
    assert.equal(busy.body.code, 'E_WS_BUSY');
    assert.deepEqual(busy.body.conversations, [conv.body.id]);

    await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/stop`, {}, TOKEN);
  } finally {
    await stopServer(srv);
  }
});

test('POST /api/v2/workspaces/{id}/git/refresh returns git status or null', { timeout: 40_000 }, async () => {
  const execFileP = promisify(execFile);
  const wsRoot = await makeTempDir('weft-v2-git-wsroot-');
  const repo = path.join(wsRoot, 'repo');
  await writeFile(path.join(wsRoot, '.keep'), '');
  await mkdir(repo, { recursive: true });
  async function initRepo() {
    await writeFile(path.join(repo, 'readme.txt'), 'hello\n');
    await execFileP('git', ['-c', 'user.name=weft', '-c', 'user.email=weft@test', 'add', 'readme.txt'], {
      cwd: repo, windowsHide: true, timeout: 15_000,
    });
    await execFileP('git', ['-c', 'user.name=weft', '-c', 'user.email=weft@test', 'commit', '-m', 'init', '--no-gpg-sign'], {
      cwd: repo, windowsHide: true, timeout: 15_000,
    });
  }
  try {
    await execFileP('git', ['init', '-b', 'main'], { cwd: repo, windowsHide: true, timeout: 15_000 });
    await initRepo();
  } catch {
    try {
      await execFileP('git', ['init'], { cwd: repo, windowsHide: true, timeout: 15_000 });
      await initRepo();
    } catch {
      /* git missing or init failed: collectGitStatus returns null */
    }
  }
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_WORKSPACE_ROOT: wsRoot },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const created = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, {
      name: 'gitws',
      source: 'local',
      path: repo,
    });
    assert.equal(created.status, 201, created.text);
    assertChecked('/api/v2/workspaces', 'POST', 201, created.body);
    assert.ok('git' in created.body);

    const listed = await getV2(srv.base, '/api/v2/workspaces', discovery.token);
    assert.equal(listed.status, 200, listed.text);
    assertChecked('/api/v2/workspaces', 'GET', 200, listed.body);
    const ws = listed.body.workspaces.find((row) => row.id === created.body.id);
    assert.ok(ws);
    assert.ok('git' in ws);
    await writeFile(path.join(repo, 'readme.txt'), 'hello\nworld\n');
    const refreshed = await sendV2(
      srv.base,
      'POST',
      `/api/v2/workspaces/${created.body.id}/git/refresh`,
      discovery.token,
      {},
    );
    assert.equal(refreshed.status, 200, refreshed.text);
    assertChecked(`/api/v2/workspaces/${created.body.id}/git/refresh`, 'POST', 200, refreshed.body);
    if (!refreshed.body.git) {
      assert.equal(refreshed.body.git, null);
      return;
    }
    assert.equal(refreshed.body.git.detached, false);
    assert.ok(refreshed.body.git.branch === 'main' || refreshed.body.git.branch === 'master', refreshed.body.git.branch);
    assert.ok(refreshed.body.git.changedFiles >= 1);
    assert.ok(refreshed.body.git.insertions >= 1);
  } finally {
    await stopServer(srv);
    await removeTempDir(wsRoot);
  }
});
