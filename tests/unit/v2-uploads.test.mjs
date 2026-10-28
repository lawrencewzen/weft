import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { matchContractPath, validateResponse } from '../../src/v2/validate.ts';
import { sanitizeUploadName, UPLOAD_MAX_BYTES } from '../../src/v2/views/uploads.ts';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-uploads-token';

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

function assertChecked(requestPath, method, status, body) {
  const checked = validateResponse(requestPath, method, status, body);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
}

async function openWorkspace(base, name = 'v2-up') {
  const ws = await request(base, 'POST', '/api/workspaces', { name }, TOKEN);
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  return ws.body;
}

async function openConversation(base, title = 'up') {
  const ws = await openWorkspace(base);
  const conv = await request(base, 'POST', `/api/workspaces/${ws.id}/conversations`, { title }, TOKEN);
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return { ws, conv: conv.body };
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

test('sanitizeUploadName replaces Windows-forbidden chars and prefixes reserved device names', () => {
  assert.equal(sanitizeUploadName('a:b.txt'), 'a_b.txt');
  assert.equal(sanitizeUploadName('what?.md'), 'what_.md');
  assert.equal(sanitizeUploadName('CON'), '_CON');
  assert.equal(sanitizeUploadName('nul.txt'), '_nul.txt');
  assert.equal(sanitizeUploadName('Com1.log'), '_Com1.log');
  assert.equal(sanitizeUploadName('说明文档.txt'), '说明文档.txt');
});

test('contract path templates cover upload and paste routes', () => {
  assert.equal(
    matchContractPath('/api/v2/workspaces/ws-1/uploads'),
    '/api/v2/workspaces/{id}/uploads',
  );
  assert.equal(
    matchContractPath('/api/v2/conversations/abc/messages/u1/pastes/0'),
    '/api/v2/conversations/{id}/messages/{messageId}/pastes/{index}',
  );
});

test('POST /uploads writes the file, sanitizes the name, and gitignore only once', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ack' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const ws = await openWorkspace(srv.base, 'upload-ok');
    const uploaded = await postV2(srv.base, `/api/v2/workspaces/${ws.id}/uploads`, discovery.token, {
      name: '../../weird/notes.txt',
      data: Buffer.from('hello-upload').toString('base64'),
    });
    assert.equal(uploaded.status, 201, uploaded.text);
    assertChecked(`/api/v2/workspaces/${ws.id}/uploads`, 'POST', 201, uploaded.body);
    assert.equal(uploaded.body.name, 'notes.txt');
    assert.equal(uploaded.body.bytes, 12);
    assert.equal(uploaded.body.mediaType, 'text/plain');
    assert.match(uploaded.body.path, /^\.weft\/uploads\/\d{8}-\d{6}-[0-9a-f]{6}\/notes\.txt$/);
    assert.equal(uploaded.body.path.includes('\\'), false);

    const abs = path.join(ws.path, ...uploaded.body.path.split('/'));
    assert.equal(await readFile(abs, 'utf8'), 'hello-upload');
    const gitignore = path.join(ws.path, '.weft', '.gitignore');
    assert.equal(await readFile(gitignore, 'utf8'), '*\n');

    await writeFile(gitignore, '# custom\n');
    const second = await postV2(srv.base, `/api/v2/workspaces/${ws.id}/uploads`, discovery.token, {
      name: 'other.txt',
      data: Buffer.from('x').toString('base64'),
    });
    assert.equal(second.status, 201, second.text);
    assert.equal(await readFile(gitignore, 'utf8'), '# custom\n');

    const emptyName = await postV2(srv.base, `/api/v2/workspaces/${ws.id}/uploads`, discovery.token, {
      name: '',
      data: Buffer.from('z').toString('base64'),
    });
    assert.equal(emptyName.status, 201, emptyName.text);
    assert.equal(emptyName.body.name, 'file');
    assert.match(emptyName.body.path, /\/file$/);
  } finally {
    await stopServer(srv);
  }
});

test('POST /uploads is 413 over the 20MB cap and 404 when the workspace is missing', { timeout: 60_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ack' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const ws = await openWorkspace(srv.base, 'upload-err');
    const oversize = 'A'.repeat(Math.ceil((UPLOAD_MAX_BYTES + 1) / 3) * 4);
    const large = await postV2(srv.base, `/api/v2/workspaces/${ws.id}/uploads`, discovery.token, {
      name: 'big.bin',
      data: oversize,
    });
    assert.equal(large.status, 413, large.text.slice(0, 200));
    assertChecked(`/api/v2/workspaces/${ws.id}/uploads`, 'POST', 413, large.body);
    assert.equal(large.body.code, 'E_TOO_LARGE');

    const missing = await postV2(srv.base, '/api/v2/workspaces/does-not-exist/uploads', discovery.token, {
      name: 'a.txt',
      data: Buffer.from('x').toString('base64'),
    });
    assert.equal(missing.status, 404, missing.text);
    assertChecked('/api/v2/workspaces/does-not-exist/uploads', 'POST', 404, missing.body);

    const removedRes = await fetch(srv.base + `/api/v2/workspaces/${ws.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...v2Headers(discovery.token) },
    });
    assert.equal(removedRes.status, 200, await removedRes.text());
    const afterRemove = await postV2(srv.base, `/api/v2/workspaces/${ws.id}/uploads`, discovery.token, {
      name: 'a.txt',
      data: Buffer.from('x').toString('base64'),
    });
    assert.equal(afterRemove.status, 404, afterRemove.text);

    const unauth = await postV2(srv.base, `/api/v2/workspaces/${ws.id}/uploads`, undefined, {
      name: 'a.txt',
      data: Buffer.from('x').toString('base64'),
    });
    assert.equal(unauth.status, 401, unauth.text);
  } finally {
    await stopServer(srv);
  }
});

test('POST /messages accepts files-only and pastes-only; snapshot strips paste bodies', { timeout: 50_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'saw-attach' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { ws, conv } = await openConversation(srv.base, 'attach');
    const uploaded = await postV2(srv.base, `/api/v2/workspaces/${ws.id}/uploads`, discovery.token, {
      name: 'brief.md',
      data: Buffer.from('# brief\n').toString('base64'),
    });
    assert.equal(uploaded.status, 201, uploaded.text);

    const filesOnly = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      files: [{ path: uploaded.body.path }],
    });
    assert.equal(filesOnly.status, 202, filesOnly.text);
    assertChecked(`/api/v2/conversations/${conv.id}/messages`, 'POST', 202, filesOnly.body);

    const fileSnap = await waitV2(srv.base, conv.id, discovery.token, (body) => (
      body?.conversation?.run?.status === 'idle'
      && (body.items || []).some((item) => item.kind === 'user' && item.files?.length)
    ));
    const fileUser = fileSnap.body.items.find((item) => item.kind === 'user' && item.files?.length);
    assert.equal(fileUser.text, '');
    assert.equal(fileUser.files[0].path, uploaded.body.path);
    assert.equal(fileUser.files[0].name, 'brief.md');
    assert.equal(fileUser.files[0].bytes, 8);
    assert.equal(JSON.stringify(fileUser).includes('<attached_files>'), false);

    const pasteOpened = await request(srv.base, 'POST', `/api/workspaces/${ws.id}/conversations`, { title: 'paste' }, TOKEN);
    assert.equal(pasteOpened.status, 201, JSON.stringify(pasteOpened.body));
    const pasteConv = pasteOpened.body;
    const pasteBody = Array.from({ length: 20 }, (_, i) => `paste-line-${i + 1}`).join('\n');
    const pastesOnly = await postV2(srv.base, `/api/v2/conversations/${pasteConv.id}/messages`, discovery.token, {
      pastes: [pasteBody],
    });
    assert.equal(pastesOnly.status, 202, pastesOnly.text);

    const pasteSnap = await waitV2(srv.base, pasteConv.id, discovery.token, (body) => (
      body?.conversation?.run?.status === 'idle'
      && (body.items || []).some((item) => item.kind === 'user' && item.pastes?.length)
    ));
    const pasteUser = pasteSnap.body.items.find((item) => item.kind === 'user' && item.pastes?.length);
    assert.equal(pasteUser.text, '');
    assert.equal(pasteUser.pastes[0].lines, 20);
    assert.equal(pasteUser.pastes[0].chars, pasteBody.length);
    assert.equal(pasteUser.pastes[0].preview, pasteBody.split('\n').slice(0, 8).join('\n'));
    assert.equal(JSON.stringify(pasteSnap.body).includes('paste-line-12'), false);
    assert.equal(JSON.stringify(pasteSnap.body).includes('<pasted_text'), false);

    const pasteGet = await fetch(
      `${srv.base}/api/v2/conversations/${pasteConv.id}/messages/${pasteUser.id}/pastes/0`,
      { headers: v2Headers(discovery.token) },
    );
    const pasteText = await pasteGet.text();
    assert.equal(pasteGet.status, 200, pasteText.slice(0, 200));
    assert.equal(pasteGet.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(pasteGet.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.ok(pasteGet.headers.get('etag'));
    assert.equal(pasteGet.headers.get('weft-protocol'), PROTOCOL_VERSION);
    assert.equal(pasteText, pasteBody);
    assert.equal(pasteText.startsWith('paste-line-1\n'), true);

    const missingPaste = await getV2(
      srv.base,
      `/api/v2/conversations/${pasteConv.id}/messages/${pasteUser.id}/pastes/9`,
      discovery.token,
    );
    assert.equal(missingPaste.status, 404, missingPaste.text);
    assertChecked(
      `/api/v2/conversations/${pasteConv.id}/messages/${pasteUser.id}/pastes/9`,
      'GET',
      404,
      missingPaste.body,
    );

    const noAuth = await fetch(
      `${srv.base}/api/v2/conversations/${pasteConv.id}/messages/${pasteUser.id}/pastes/0`,
    );
    assert.equal(noAuth.status, 401);
    const noAuthBody = await noAuth.json();
    assertChecked(
      `/api/v2/conversations/${pasteConv.id}/messages/${pasteUser.id}/pastes/0`,
      'GET',
      401,
      noAuthBody,
    );

    const both = await postV2(srv.base, `/api/v2/conversations/${pasteConv.id}/messages`, discovery.token, {
      text: '看附件',
      files: [{ path: uploaded.body.path, name: 'brief.md' }],
      pastes: [pasteBody],
    });
    assert.equal(both.status, 202, both.text);
    const bothSnap = await waitV2(srv.base, pasteConv.id, discovery.token, (body) => (
      (body.items || []).some((item) => item.kind === 'user' && item.text === '看附件' && item.files?.length && item.pastes?.length)
    ));
    const bothUser = bothSnap.body.items.find((item) => item.text === '看附件');
    assert.equal(bothUser.files[0].path, uploaded.body.path);
    assert.equal(bothUser.pastes[0].lines, 20);
  } finally {
    await stopServer(srv);
  }
});

test('POST /messages rejects files outside uploads and over-limit pastes/files', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'x' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const { ws, conv } = await openConversation(srv.base, 'bad-files');
    await writeFile(path.join(ws.path, 'outside.txt'), 'nope');

    const outside = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      files: [{ path: 'outside.txt' }],
    });
    assert.equal(outside.status, 400, outside.text);
    assert.equal(outside.body.code, 'E_BAD_REQUEST');
    assertChecked(`/api/v2/conversations/${conv.id}/messages`, 'POST', 400, outside.body);

    const missing = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      files: [{ path: '.weft/uploads/no-such/file.txt' }],
    });
    assert.equal(missing.status, 400, missing.text);
    assert.equal(missing.body.code, 'E_BAD_REQUEST');

    const tooManyFiles = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      files: Array.from({ length: 21 }, (_, i) => ({ path: `.weft/uploads/s/f${i}.txt` })),
    });
    assert.equal(tooManyFiles.status, 400, tooManyFiles.text);

    const tooManyPastes = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      pastes: Array.from({ length: 11 }, () => 'x'),
    });
    assert.equal(tooManyPastes.status, 400, tooManyPastes.text);

    const hugePaste = await postV2(srv.base, `/api/v2/conversations/${conv.id}/messages`, discovery.token, {
      pastes: ['x'.repeat(1024 * 1024 + 1)],
    });
    assert.equal(hugePaste.status, 400, hugePaste.text);
  } finally {
    await stopServer(srv);
  }
});
