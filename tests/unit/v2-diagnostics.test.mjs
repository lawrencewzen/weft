import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import unzipper from 'unzipper';
import { validateResponse } from '../../src/v2/validate.ts';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore } from '../../src/core/provider-stores.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const TOKEN = 'v2-diag-token';
const KEY = 'sk-diagfake-9999999999';
const BEARER = 'diagBearerValue0123456789';
const PW = 'userinfoPassw0rd';
const REPORT = '/api/v2/diagnostics/report';

async function post(base, token, body) {
  const res = await fetch(base + REPORT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
}

async function unzip(buffer) {
  const dir = await unzipper.Open.buffer(buffer);
  const out = {};
  for (const f of dir.files) out[f.path] = (await f.buffer()).toString('utf8');
  return out;
}

test('POST /api/v2/diagnostics/report: auth, selections, secrets, conversation, 404', { timeout: 90_000 }, async () => {
  const dataDir = await makeTempDir('weft-v2-diag-');
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({ turns: [{ when: 'TOKEN-HELLO', text: '你好 HELLO-SEEN' }] }));
  const store = createSqliteStore(dataDir);
  await store.replaceSettings({
    version: 3,
    language: 'zh',
    providers: [
      { id: 'deepseek', kind: 'builtin', enabled: ['deepseek-flash'], overrides: {} },
      {
        id: 'custom-1234abcd',
        kind: 'custom',
        name: '内网网关',
        api: 'openai-completions',
        baseUrl: `https://admin:${PW}@gw.example.com/v1`,
        apiKey: KEY,
        enabled: ['m1'],
        overrides: {},
      },
    ],
    defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
  });
  await createCredentialStore(store).modify('deepseek', async () => ({ type: 'api_key', key: KEY }));
  store.close();
  await mkdir(path.join(dataDir, 'logs'), { recursive: true });
  await writeFile(path.join(dataDir, 'logs', 'service-stdio.log'), `old stdio Authorization: Bearer ${BEARER} ${KEY}\n`);

  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script },
  });
  try {
    const token = (await readDiscovery(dataDir)).token;

    const anon = await post(srv.base, null, { description: '', includeLogs: false, includeDoctor: false });
    assert.equal(anon.status, 401);

    const bad = await post(srv.base, token, { description: 1, includeLogs: true, includeDoctor: true });
    assert.equal(bad.status, 400);

    const missing = await post(srv.base, token, {
      description: '', includeLogs: false, includeDoctor: false, conversationId: 'does-not-exist',
    });
    assert.equal(missing.status, 404);
    assert.equal(validateResponse(REPORT, 'POST', 404, JSON.parse(missing.buffer.toString())).ok, true);

    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'diag' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: '诊断对话' }, TOKEN);
    assert.equal(conv.status, 201);
    const cid = conv.body.id;
    const sent = await fetch(`${srv.base}/api/v2/conversations/${cid}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: `请回答 TOKEN-HELLO 并且 password=${PW}` }),
    });
    assert.equal(sent.status, 202);
    for (let i = 0; i < 200; i += 1) {
      const snap = await fetch(`${srv.base}/api/v2/conversations/${cid}`, { headers: { authorization: `Bearer ${token}` } });
      const text = await snap.text();
      if (text.includes('HELLO-SEEN') && JSON.parse(text).conversation?.run?.status === 'idle') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const full = await post(srv.base, token, {
      description: `启动失败 api_key=${KEY}`, includeLogs: true, includeDoctor: true, conversationId: cid,
    });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'application/zip');
    assert.match(full.headers.get('content-disposition'), /^attachment; filename="weft-report-\d{8}-\d{6}\.zip"$/);
    const files = await unzip(full.buffer);
    assert.deepEqual(Object.keys(files).sort(), [
      'doctor.txt', `conversation-${cid}.json`, 'logs/service-stdio.log', 'logs/service.log', 'report.txt', 'settings.json', 'system.txt',
    ].sort());
    assert.match(files['report.txt'], /启动失败/);
    assert.match(files['system.txt'], /Weft version: /);
    assert.match(files['system.txt'], new RegExp(`Data directory: ${dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const settings = JSON.parse(files['settings.json']);
    assert.equal(settings.providers.find((p) => p.id === 'custom-1234abcd').baseUrl, 'https://gw.example.com/v1');
    assert.match(files['logs/service.log'], /WEFT_START/);
    assert.match(files[`conversation-${cid}.json`], /HELLO-SEEN/);
    for (const [name, text] of Object.entries(files)) {
      for (const secret of [KEY, BEARER, PW]) assert.ok(!text.includes(secret), `${name} leaked a secret`);
    }

    const bare = await post(srv.base, token, { description: 'x', includeLogs: false, includeDoctor: false });
    assert.equal(bare.status, 200);
    assert.deepEqual(Object.keys(await unzip(bare.buffer)).sort(), ['report.txt', 'settings.json', 'system.txt']);

    assert.match(srv.logs(), /\[WEFT_REPORT\] logs=true doctor=true conversation=true bytes=\d+/);
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});
