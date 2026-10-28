import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { matchContractPath, validateResponse } from '../../src/v2/validate.ts';
import { MANUAL_CONTINUE_TEXT } from '../../src/v2/views/continuation.ts';
import { outputLineCount } from '../../src/v2/views/tools.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-conv-cmd-token';
const LONG_READ = path.join(ROOT, 'tests/fixtures/v2-long-read.json');

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

async function postV2(base, apiPath, token, body = {}) {
  const res = await fetch(base + apiPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? v2Headers(token) : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

async function openConversation(base, title = 'cmd') {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'v2-cmd' }, TOKEN);
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title }, TOKEN);
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return { ws: ws.body, conv: conv.body };
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

async function waitForFile(file, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await readFile(file, 'utf8');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  throw new Error(`file not ready: ${file}`);
}

function userTexts(body) {
  return (body?.items || []).filter((item) => item.kind === 'user').map((item) => item.text);
}

function assertChecked(requestPath, method, status, body) {
  const checked = validateResponse(requestPath, method, status, body);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
}

test('contract path templates cover the four command routes', () => {
  assert.equal(
    matchContractPath('/api/v2/conversations/abc-123/messages'),
    '/api/v2/conversations/{id}/messages',
  );
  assert.equal(
    matchContractPath('/api/v2/conversations/abc-123/stop'),
    '/api/v2/conversations/{id}/stop',
  );
  assert.equal(
    matchContractPath('/api/v2/conversations/abc-123/continue'),
    '/api/v2/conversations/{id}/continue',
  );
  assert.equal(
    matchContractPath('/api/v2/conversations/abc-123/tools/t1/output'),
    '/api/v2/conversations/{id}/tools/{toolId}/output',
  );
  assert.equal(
    matchContractPath('/api/v2/conversations/abc-123/messages/u1/images/0'),
    '/api/v2/conversations/{id}/messages/{messageId}/images/{index}',
  );
});

test('POST /messages 202 then snapshot has the user item and a reply', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ack-cmd' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base);
    const sent = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: '  hello-cmd  ',
    });
    assert.equal(sent.status, 202, sent.text);
    assertChecked(`/api/v2/conversations/${conv.id}/messages`, 'POST', 202, sent.body);
    assert.equal(typeof sent.body.runId, 'string');
    assert.ok(sent.body.runId);
    assert.equal(sent.headers.get('weft-protocol'), PROTOCOL_VERSION);

    const snap = await waitV2(srv.base, conv.id, discovery.token, (body) => (
      body?.conversation?.run?.status === 'idle'
      && userTexts(body).includes('hello-cmd')
      && (body.items || []).some((item) => item.kind === 'assistant' && item.text === 'ack-cmd')
    ));
    assertChecked(`/api/v2/conversations/${conv.id}`, 'GET', 200, snap.body);
    assert.deepEqual(userTexts(snap.body), ['hello-cmd']);
  } finally {
    await stopServer(srv);
  }
});

test('the same requestId posted twice returns the same runId and one user item', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'once' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base, 'idem');
    const requestId = randomUUID();
    const first = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'only-once',
      requestId,
    });
    assert.equal(first.status, 202, first.text);
    const second = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'only-once',
      requestId,
    });
    assert.equal(second.status, 202, second.text);
    assert.equal(second.body.runId, first.body.runId);

    const snap = await waitV2(srv.base, conv.id, discovery.token, (body) => (
      body?.conversation?.run?.status === 'idle'
      && userTexts(body).includes('only-once')
    ));
    assert.deepEqual(userTexts(snap.body), ['only-once']);
  } finally {
    await stopServer(srv);
  }
});

test('empty text is 400, missing conversation 404, no credentials 401', { timeout: 30_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'x' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base, 'errors');

    const blank = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, { text: '   ' });
    assert.equal(blank.status, 400, blank.text);
    assertChecked(`/api/v2/conversations/${conv.id}/messages`, 'POST', 400, blank.body);
    assert.equal(blank.body.code, 'E_BAD_REQUEST');

    const missingText = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {});
    assert.equal(missingText.status, 400, missingText.text);

    const missing = await postV2(srv.base, '/api/v2/conversations/does-not-exist/messages', discovery.token, {
      text: 'nope',
    });
    assert.equal(missing.status, 404, missing.text);
    assertChecked('/api/v2/conversations/does-not-exist/messages', 'POST', 404, missing.body);

    const unauth = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, undefined, { text: 'hi' });
    assert.equal(unauth.status, 401, unauth.text);
    assertChecked(`/api/v2/conversations/${conv.id}/messages`, 'POST', 401, unauth.body);

    const stopMissing = await postV2(srv.base, '/api/v2/conversations/does-not-exist/stop', discovery.token, {});
    assert.equal(stopMissing.status, 404, stopMissing.text);
    assertChecked('/api/v2/conversations/does-not-exist/stop', 'POST', 404, stopMissing.body);

    const continueMissing = await postV2(srv.base, '/api/v2/conversations/does-not-exist/continue', discovery.token, {});
    assert.equal(continueMissing.status, 404, continueMissing.text);

    const toolMissingConv = await getV2(srv.base, '/api/v2/conversations/does-not-exist/tools/t1/output', discovery.token);
    assert.equal(toolMissingConv.status, 404, toolMissingConv.text);
    const toolMissing = await getV2(srv.base, `/api/v2/conversations/${conv.id}/tools/no-such-tool/output`, discovery.token);
    assert.equal(toolMissing.status, 404, toolMissing.text);
    assertChecked(`/api/v2/conversations/${conv.id}/tools/no-such-tool/output`, 'GET', 404, toolMissing.body);
  } finally {
    await stopServer(srv);
  }
});

test('a message sent while running is steered; snapshot keeps both user items', { timeout: 45_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-v2-steer-'));
  const script = path.join(dataDir, 'steer.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { text: 'working', delayMs: 800, tool: 'write', args: { path: 'note.txt', content: 'n\n' } },
      { text: 'saw-steer' },
    ],
  }));
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: script,
    },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base, 'steer');
    const first = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'first-user',
    });
    assert.equal(first.status, 202, first.text);
    await waitV2(srv.base, conv.id, discovery.token, (body) => body?.conversation?.run?.status === 'running');

    const steered = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'second-user',
    });
    assert.equal(steered.status, 202, steered.text);

    const snap = await waitV2(srv.base, conv.id, discovery.token, (body) => {
      const users = userTexts(body);
      return body?.conversation?.run?.status === 'idle'
        && users.includes('first-user')
        && users.includes('second-user');
    });
    assert.deepEqual(userTexts(snap.body), ['first-user', 'second-user']);
    assert.equal(
      (snap.body.items || []).some((item) => item.kind === 'assistant' && item.text === 'saw-steer'),
      true,
    );
  } finally {
    await stopServer(srv);
  }
});

test('POST /stop ends a running conversation; idle stop is 202', { timeout: 45_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-v2-stop-'));
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
    const { conv } = await openConversation(srv.base, 'stop');
    const idleStop = await postV2(srv.base, `/api/v2/conversations/${conv.id}/stop`, discovery.token, {});
    assert.equal(idleStop.status, 202, idleStop.text);
    assertChecked(`/api/v2/conversations/${conv.id}/stop`, 'POST', 202, idleStop.body);
    assert.equal(idleStop.body.stopping, true);

    const sent = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'hold-stop',
    });
    assert.equal(sent.status, 202, sent.text);
    await waitForFile(ready);
    await waitV2(srv.base, conv.id, discovery.token, (body) => body?.conversation?.run?.status === 'running');

    const steered = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'while-held',
    });
    assert.equal(steered.status, 202, steered.text);

    const stopped = await postV2(srv.base, `/api/v2/conversations/${conv.id}/stop`, discovery.token, {});
    assert.equal(stopped.status, 202, stopped.text);
    assert.equal(stopped.body.stopping, true);

    const snap = await waitV2(srv.base, conv.id, discovery.token, (body) => {
      const status = body?.conversation?.run?.status;
      return status === 'stopped' || status === 'idle';
    });
    assert.ok(['stopped', 'idle'].includes(snap.body.conversation.run.status), JSON.stringify(snap.body.conversation.run));
  } finally {
    await stopServer(srv);
  }
});

test('POST /continue sends MANUAL_CONTINUE_TEXT', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'continued' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base, 'cont');
    const first = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'start',
    });
    assert.equal(first.status, 202, first.text);
    await waitV2(srv.base, conv.id, discovery.token, (body) => (
      body?.conversation?.run?.status === 'idle' && userTexts(body).includes('start')
    ));

    const cont = await postV2(srv.base, `/api/v2/conversations/${conv.id}/continue`, discovery.token, {});
    assert.equal(cont.status, 202, cont.text);
    assertChecked(`/api/v2/conversations/${conv.id}/continue`, 'POST', 202, cont.body);
    assert.equal(typeof cont.body.runId, 'string');

    const snap = await waitV2(srv.base, conv.id, discovery.token, (body) => (
      body?.conversation?.run?.status === 'idle'
      && userTexts(body).includes(MANUAL_CONTINUE_TEXT)
    ));
    assert.deepEqual(userTexts(snap.body), ['start', MANUAL_CONTINUE_TEXT]);
    assert.equal(MANUAL_CONTINUE_TEXT, '继续');
  } finally {
    await stopServer(srv);
  }
});

test('GET tool output returns the full text when the snapshot preview is truncated', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: LONG_READ },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { ws, conv } = await openConversation(srv.base, 'tool-out');
    const lines = Array.from({ length: 25 }, (_, i) => (
      i === 0 ? `${ws.path}/src/a.js` : `line-${String(i + 1).padStart(2, '0')}`
    ));
    await writeFile(path.join(ws.path, 'long.txt'), `${lines.join('\n')}\n`);

    const sent = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'read it',
    });
    assert.equal(sent.status, 202, sent.text);
    const snap = await waitV2(srv.base, conv.id, discovery.token, (body) => (
      body?.conversation?.run?.status === 'idle'
      && (body.tools || []).some((tool) => tool.kind === 'read' && tool.output?.truncated)
    ));
    const tool = snap.body.tools.find((item) => item.kind === 'read' && item.output?.truncated);
    assert.ok(tool, JSON.stringify(snap.body.tools));
    assert.equal(tool.output.truncated, true);
    assert.equal(tool.output.preview.split('\n').length, 20);
    assert.ok(tool.output.totalLines > 20);

    const full = await getV2(srv.base, `/api/v2/conversations/${conv.id}/tools/${tool.id}/output`, discovery.token);
    assert.equal(full.status, 200, full.text);
    assertChecked(`/api/v2/conversations/${conv.id}/tools/${tool.id}/output`, 'GET', 200, full.body);
    assert.equal(full.body.id, tool.id);
    assert.equal(full.body.totalLines, outputLineCount(full.body.text));
    assert.equal(full.body.totalLines, tool.output.totalLines);
    assert.ok(full.body.totalLines > 20);
    assert.equal(full.body.text.split('\n').slice(0, 20).join('\n'), tool.output.preview);
    assert.equal(full.body.text.includes(ws.path), false, full.body.text);
    assert.match(full.body.text, /^src\/a\.js/m);
  } finally {
    await stopServer(srv);
  }
});

test('POST /messages on a conversation without a workspace is 409 E_NO_WORKSPACE', { timeout: 30_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'x' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base, 'no-ws');
    const db = new DatabaseSync(path.join(srv.dataDir, 'weft.sqlite'));
    db.prepare('UPDATE conversations SET workspace_id = NULL WHERE id = ?').run(conv.id);
    db.close();

    const sent = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'blocked',
    });
    assert.equal(sent.status, 409, sent.text);
    assertChecked(`/api/v2/conversations/${conv.id}/messages`, 'POST', 409, sent.body);
    assert.equal(sent.body.code, 'E_NO_WORKSPACE');
  } finally {
    await stopServer(srv);
  }
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('POST /messages accepts images, image-only, and rejects over-limit payloads', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'saw-image' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { conv } = await openConversation(srv.base, 'img');
    const sent = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: '看图',
      images: [{ mediaType: 'image/png', data: PNG, name: 'shot.png' }],
    });
    assert.equal(sent.status, 202, sent.text);
    assertChecked(`/api/v2/conversations/${conv.id}/messages`, 'POST', 202, sent.body);
    assert.equal(srv.logs().includes(PNG), false, 'server logs must not print image bytes');

    const snap = await waitV2(srv.base, conv.id, discovery.token, (body) => (
      (body.items || []).some((item) => item.kind === 'user' && item.images?.length)
    ));
    const user = snap.body.items.find((item) => item.kind === 'user' && item.images?.length);
    assert.equal(user.text, '看图');
    assert.equal(user.images[0].name, 'shot.png');
    assert.equal(user.images[0].index, 0);
    assert.equal(user.images[0].mediaType, 'image/png');
    assert.equal(Object.hasOwn(user.images[0], 'data'), false);
    assert.equal(JSON.stringify(snap.body).includes(PNG), false);
    assert.match(user.images[0].url, new RegExp(`/api/v2/conversations/${conv.id}/messages/${user.id}/images/0$`));

    const imageGet = await fetch(srv.base + user.images[0].url, {
      headers: { authorization: `Bearer ${discovery.token}` },
    });
    assert.equal(imageGet.status, 200, await imageGet.text());
    assert.equal(imageGet.headers.get('content-type'), 'image/png');
    assert.equal(imageGet.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.ok(imageGet.headers.get('etag'));
    assert.equal(Buffer.from(await imageGet.arrayBuffer()).toString('base64'), PNG);

    const missing = await getV2(srv.base, `/api/v2/conversations/${conv.id}/messages/${user.id}/images/9`, discovery.token);
    assert.equal(missing.status, 404, missing.text);
    assertChecked(`/api/v2/conversations/${conv.id}/messages/${user.id}/images/9`, 'GET', 404, missing.body);

    const noAuth = await fetch(srv.base + user.images[0].url);
    assert.equal(noAuth.status, 401);
    const noAuthBody = await noAuth.json();
    assertChecked(user.images[0].url, 'GET', 401, noAuthBody);

    const oldGet = await request(srv.base, 'GET', `/api/conversations/${conv.id}`, null, TOKEN);
    assert.equal(oldGet.status, 200, JSON.stringify(oldGet.body));
    assert.equal(JSON.stringify(oldGet.body).includes(PNG), false);
    const oldUser = (oldGet.body.messages || []).find((row) => row.role === 'user' && row.images?.length);
    assert.ok(oldUser);
    assert.equal(Object.hasOwn(oldUser.images[0], 'data'), false);
    assert.equal(oldUser.images[0].mediaType, 'image/png');

    const { conv: only } = await openConversation(srv.base, 'img-only');
    const imageOnly = await postV2(srv.base, `/api/v2/conversations/${only.id}/messages`, discovery.token, {
      images: [{ mediaType: 'image/png', data: PNG }],
    });
    assert.equal(imageOnly.status, 202, imageOnly.text);

    const tooMany = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      text: 'x',
      images: Array.from({ length: 7 }, () => ({ mediaType: 'image/png', data: PNG })),
    });
    assert.equal(tooMany.status, 400, tooMany.text);
    assert.equal(tooMany.body.code, 'E_BAD_REQUEST');

    const oversize = 'A'.repeat(Math.ceil((5 * 1024 * 1024 + 1) / 3) * 4);
    const large = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      images: [{ mediaType: 'image/png', data: oversize }],
    });
    assert.equal(large.status, 400, large.text);
    assert.equal(large.body.code, 'E_TOO_LARGE');
    assert.equal(srv.logs().includes(oversize), false);
  } finally {
    await stopServer(srv);
  }
});
