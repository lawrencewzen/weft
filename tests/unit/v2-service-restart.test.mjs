import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { discoveryPath } from '../../src/v2/daemon/discovery.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { readDiscovery, startServer, stopServer } from './_server.mjs';

function raw({ port, method = 'GET', path: reqPath = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body != null) req.end(body);
    else req.end();
  });
}

function jsonHeaders(extra = {}) {
  return { 'content-type': 'application/json', ...extra };
}

async function waitExit(proc, timeoutMs, logs = () => '') {
  if (proc.exitCode != null || proc.signalCode != null) {
    return { code: proc.exitCode, signal: proc.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.off('exit', onExit);
      reject(new Error(`process still running after ${timeoutMs}ms:\n${logs()}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    proc.once('exit', onExit);
  });
}

async function waitForFile(file, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await readFile(file, 'utf8');
      return;
    } catch {
      await sleep(30);
    }
  }
  throw new Error(`missing ${file}`);
}

async function waitForStatus(port, cid, pred, timeoutMs = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const got = await raw({ port, path: `/api/conversations/${cid}` });
    last = got.json;
    if (last && pred(last)) return last;
    await sleep(40);
  }
  throw new Error(`status wait failed: ${JSON.stringify(last)}`);
}

async function openConversation(port, title = 'restart') {
  const ws = await raw({
    port,
    method: 'POST',
    path: '/api/workspaces',
    headers: jsonHeaders(),
    body: JSON.stringify({ name: 'restart-ws' }),
  });
  assert.equal(ws.status, 201, ws.text);
  const conv = await raw({
    port,
    method: 'POST',
    path: `/api/workspaces/${ws.json.id}/conversations`,
    headers: jsonHeaders(),
    body: JSON.stringify({ title }),
  });
  assert.equal(conv.status, 201, conv.text);
  return conv.json;
}

async function postRestart(port, headers, body = '{}') {
  return raw({
    port,
    method: 'POST',
    path: '/api/v2/service/restart',
    headers: jsonHeaders(headers),
    body,
  });
}

async function bearerFor(srv) {
  const discovery = await readDiscovery(srv.dataDir);
  return { authorization: `Bearer ${discovery.token}` };
}

test('restart when idle returns 202 and exits', { timeout: 30000 }, async () => {
  const srv = await startServer({ env: { WEFT_LLM: 'faux' } });
  try {
    const headers = await bearerFor(srv);
    const res = await postRestart(srv.port, headers);
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json?.exiting, true);
    const checked = validateResponse('/api/v2/service/restart', 'POST', 202, res.json);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    const ended = await waitExit(srv.proc, 8000, srv.logs);
    assert.equal(ended.code, 0, srv.logs());
  } finally {
    await stopServer(srv);
  }
  assert.equal(existsSync(discoveryPath(srv.dataDir)), false);
});

test('restart while busy returns 409', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-restart-busy-'));
  const ready = path.join(dataDir, 'hold-ready');
  const srv = await startServer({
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_HOLD: '1',
      WEFT_FAUX_HOLD_READY: ready,
    },
  });
  try {
    const conv = await openConversation(srv.port, 'busy');
    const sent = await raw({
      port: srv.port,
      method: 'POST',
      path: `/api/conversations/${conv.id}/messages`,
      headers: jsonHeaders(),
      body: JSON.stringify({ text: 'hold' }),
    });
    assert.equal(sent.status, 202, sent.text);
    await waitForFile(ready);
    const headers = await bearerFor(srv);
    const res = await postRestart(srv.port, headers);
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json?.error, 'busy');
    assert.equal(res.json?.code, 'E_BUSY');
    const checked = validateResponse('/api/v2/service/restart', 'POST', 409, res.json);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    assert.equal(srv.proc.exitCode, null, srv.logs());
  } finally {
    await stopServer(srv);
  }
});

test('restart without credentials returns 401', { timeout: 20000 }, async () => {
  const srv = await startServer({ env: { WEFT_LLM: 'faux' } });
  try {
    const res = await postRestart(srv.port, {});
    assert.equal(res.status, 401, res.text);
    assert.equal(res.json?.code, 'E_UNAUTHORIZED');
    const checked = validateResponse('/api/v2/service/restart', 'POST', 401, res.json);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    assert.equal(srv.proc.exitCode, null);
  } finally {
    await stopServer(srv);
  }
});

test('hasActiveWork is true while held and false after the turn ends', { timeout: 45000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-active-work-'));
  const ready = path.join(dataDir, 'hold-ready');
  const srv = await startServer({
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_HOLD: '1',
      WEFT_FAUX_HOLD_READY: ready,
    },
  });
  try {
    const conv = await openConversation(srv.port, 'active');
    const sent = await raw({
      port: srv.port,
      method: 'POST',
      path: `/api/conversations/${conv.id}/messages`,
      headers: jsonHeaders(),
      body: JSON.stringify({ text: 'hold-then-stop' }),
    });
    assert.equal(sent.status, 202, sent.text);
    await waitForFile(ready);
    const headers = await bearerFor(srv);
    const busy = await postRestart(srv.port, headers);
    assert.equal(busy.status, 409, busy.text);
    assert.equal(busy.json?.code, 'E_BUSY');

    const stopped = await raw({
      port: srv.port,
      method: 'POST',
      path: `/api/conversations/${conv.id}/stop`,
      headers: jsonHeaders(),
      body: '{}',
    });
    assert.equal(stopped.status, 200, stopped.text);
    await waitForStatus(srv.port, conv.id, (row) => row.status === 'stopped' || row.status === 'done');

    const idle = await postRestart(srv.port, headers);
    assert.equal(idle.status, 202, idle.text);
    assert.equal(idle.json?.exiting, true);
    const ended = await waitExit(srv.proc, 8000, srv.logs);
    assert.equal(ended.code, 0, srv.logs());
  } finally {
    await stopServer(srv);
  }
});
