// T111-2: a model stream that goes quiet after the response started is cut off and goes
// through Pi Durable's own retry. Small idle windows keep the test fast.
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createCredentialStore } from '../../src/core/provider-stores.mjs';
import { streamIdleMs, withIdleTimeout, DEFAULT_STREAM_IDLE_MS } from '../../src/kernel/stream-idle.mjs';
import { runErrorMessage } from '../../src/v2/phrases/run-error.ts';
import { makeTempDir, removeTempDir } from './_tmp.mjs';
import { request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-stream-idle-token';
const PROVIDER = 'custom-1d1e1d1e';
const IDLE_MS = 400;
const TITLE_MARKER = 'Write a short conversation title.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chunk = (delta, finish = null) => `data: ${JSON.stringify({
  id: 'chatcmpl-idle',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
})}\n\n`;

/** Fake SSE endpoint. `plan(n, res, req)` drives the n-th chat completion (title calls excluded). */
async function startFakeSse(plan) {
  const state = { hits: 0, closed: [] };
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(parts).toString('utf8');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (raw.includes(TITLE_MARKER)) {
        res.end(`${chunk({ role: 'assistant', content: 'title' })}${chunk({}, 'stop')}data: [DONE]\n\n`);
        return;
      }
      const n = ++state.hits;
      res.on('close', () => state.closed.push(n));
      await plan(n, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

async function withServer(fake, env, fn) {
  const dataDir = await makeTempDir('weft-idle-');
  const seed = createSqliteStore(dataDir);
  await seed.replaceSettings({
    version: 3,
    providers: [{
      id: PROVIDER, kind: 'custom', name: 'Idle', baseUrl: fake.baseUrl, api: 'openai-completions',
      enabled: ['idle-model'], overrides: {},
    }],
    defaultModel: { providerId: PROVIDER, modelId: 'idle-model' },
  });
  await createCredentialStore(seed).modify(PROVIDER, async () => ({ type: 'api_key', key: 'sk-idle-1234' }));
  seed.close();
  const srv = await startServer({
    dataDir,
    token: TOKEN,
    env: { WEFT_RETRY_BASE_MS: '20', WEFT_RETRY_MAX: '3', WEFT_STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS), ...env },
  });
  try {
    const call = (method, path, body) => request(srv.base, method, path, body, TOKEN);
    const ws = await call('POST', '/api/workspaces', { name: 'idle-ws' });
    const conv = await call('POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'idle' });
    assert.equal(conv.status, 201);
    return await fn({ call, cid: conv.body.id, srv });
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
}

async function waitFor(call, cid, accept, timeoutMs = 15_000) {
  const started = Date.now();
  let body = null;
  while (Date.now() - started < timeoutMs) {
    body = (await call('GET', `/api/conversations/${cid}`)).body;
    if (accept(body)) return body;
    await sleep(40);
  }
  return body;
}

const texts = (body) => (body?.messages || []).filter((m) => m.role === 'assistant').map((m) => m.text);
const finished = (b) => ['done', 'failed', 'stopped'].includes(b?.status);

test('env parsing and phrase mapping', () => {
  assert.equal(streamIdleMs({}), DEFAULT_STREAM_IDLE_MS);
  assert.equal(DEFAULT_STREAM_IDLE_MS, 120_000);
  assert.equal(streamIdleMs({ WEFT_STREAM_IDLE_TIMEOUT_MS: '250' }), 250);
  assert.equal(streamIdleMs({ WEFT_STREAM_IDLE_TIMEOUT_MS: '0' }), 120_000);
  assert.equal(streamIdleMs({ WEFT_STREAM_IDLE_TIMEOUT_MS: 'x' }), 120_000);
  assert.match(runErrorMessage('zh', 'model_error', 'Model stream idle timeout: no data for 120000ms'), /长时间没有返回数据/);
  assert.match(runErrorMessage('en', 'model_error', 'Model stream idle timeout: no data for 120000ms'), /stopped sending data/);
  assert.equal(runErrorMessage('zh', 'model_error', '503 x'), '模型请求失败：503 x');
});

test('idle fetch: wait before the response is not counted; a quiet body fails', async () => {
  const slowHeaders = async () => {
    await sleep(150);
    return new Response(new ReadableStream({
      async start(c) { c.enqueue(new Uint8Array([1])); await sleep(30); c.close(); },
    }));
  };
  const res = await withIdleTimeout(slowHeaders, 80)('http://x');
  assert.equal((await res.arrayBuffer()).byteLength, 1);

  const stalls = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } }));
  const quiet = await withIdleTimeout(stalls, 80)('http://x');
  await assert.rejects(quiet.arrayBuffer(), /Model stream idle timeout/);
});

test('stalled stream is cut off after reasoning; official retry succeeds', { timeout: 30_000 }, async () => {
  const fake = await startFakeSse(async (n, res) => {
    if (n === 1) { res.write(chunk({ role: 'assistant', reasoning_content: 'The' })); return; }
    res.write(chunk({ role: 'assistant', content: 'second-try' }));
    res.end(`${chunk({}, 'stop')}data: [DONE]\n\n`);
  });
  try {
    await withServer(fake, {}, async ({ call, cid }) => {
      const started = Date.now();
      assert.equal((await call('POST', `/api/conversations/${cid}/messages`, { text: 'go' })).status, 202);
      const body = await waitFor(call, cid, finished);
      assert.equal(body.status, 'done', JSON.stringify(body));
      assert.deepEqual(texts(body), ['second-try']);
      assert.equal(fake.state.hits, 2);
      assert.ok(fake.state.closed.includes(1), 'first attempt connection was closed');
      assert.ok(Date.now() - started >= IDLE_MS);
    });
  } finally { await fake.close(); }
});

test('slow but steady stream is not cut off', { timeout: 30_000 }, async () => {
  const fake = await startFakeSse(async (n, res) => {
    for (let i = 0; i < 8; i += 1) {
      res.write(chunk(i === 0 ? { role: 'assistant', reasoning_content: 'think' } : { content: `w${i} ` }));
      await sleep(150);
    }
    res.end(`${chunk({}, 'stop')}data: [DONE]\n\n`);
  });
  try {
    await withServer(fake, {}, async ({ call, cid }) => {
      const started = Date.now();
      await call('POST', `/api/conversations/${cid}/messages`, { text: 'go' });
      const body = await waitFor(call, cid, finished);
      assert.equal(body.status, 'done', JSON.stringify(body));
      assert.equal(fake.state.hits, 1);
      assert.ok(Date.now() - started > IDLE_MS, 'total time exceeds the idle window');
    });
  } finally { await fake.close(); }
});

test('user stop stays stopped and is not retried as an idle stall', { timeout: 30_000 }, async () => {
  const fake = await startFakeSse(async (n, res) => {
    res.write(chunk({ role: 'assistant', reasoning_content: 'The' }));
  });
  try {
    await withServer(fake, { WEFT_STREAM_IDLE_TIMEOUT_MS: '3000' }, async ({ call, cid }) => {
      await call('POST', `/api/conversations/${cid}/messages`, { text: 'go' });
      for (let i = 0; i < 100 && fake.state.hits < 1; i += 1) await sleep(30);
      await sleep(100);
      assert.equal((await call('POST', `/api/conversations/${cid}/stop`)).status < 300, true);
      const body = await waitFor(call, cid, finished);
      assert.equal(body.status, 'stopped', JSON.stringify(body));
      await sleep(600);
      assert.equal(fake.state.hits, 1);
      assert.equal((await call('GET', `/api/conversations/${cid}`)).body.status, 'stopped');
    });
  } finally { await fake.close(); }
});
