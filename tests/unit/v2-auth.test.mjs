import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { compileSchema, validateResponse } from '../../src/v2/validate.ts';
import {
  discoveryPath,
  removeDiscoverySync,
  writeDiscoverySync,
} from '../../src/v2/daemon/discovery.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, startServer, stopServer } from './_server.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));

function discoveryValidator() {
  return compileSchema(structuredClone(spec.components.schemas.ServiceDiscovery));
}

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

function parseSetCookie(header) {
  const parts = String(header || '').split(';').map((s) => s.trim()).filter(Boolean);
  const nv = parts[0] || '';
  const eq = nv.indexOf('=');
  const name = eq === -1 ? nv : nv.slice(0, eq);
  const value = eq === -1 ? '' : nv.slice(eq + 1);
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* keep */ }
  return {
    name,
    value: decoded,
    attrs: parts.slice(1).map((a) => a.toLowerCase()),
  };
}

async function getService(port, headers = {}) {
  return raw({ port, path: '/api/v2/service', headers });
}

test('written service.json matches ServiceDiscovery and is removed on SIGTERM', async () => {
  const srv = await startServer();
  try {
    const file = discoveryPath(srv.dataDir);
    assert.equal(existsSync(file), true);
    const discovery = await readDiscovery(srv.dataDir);
    const validate = discoveryValidator();
    assert.equal(validate(discovery), true, JSON.stringify(validate.errors));
    assert.equal(discovery.port, srv.port);
    assert.equal(discovery.pid, srv.proc.pid);
    assert.equal(discovery.protocolVersion, PROTOCOL_VERSION);
    assert.equal(typeof discovery.token, 'string');
    assert.ok(discovery.token.length > 0);
    if (process.platform !== 'win32') {
      const st = await stat(file);
      assert.equal(st.mode & 0o777, 0o600);
    }
    assert.equal(srv.logs().includes(discovery.token), false);
  } finally {
    await stopServer(srv);
  }
  // child_process.kill('SIGTERM') is TerminateProcess on Windows, so the
  // SIGTERM/exit handlers never run. Deletion is still covered in-process
  // by removeDiscoverySync below, and by SIGTERM on Unix CI.
  if (process.platform === 'win32') return;
  assert.equal(existsSync(discoveryPath(srv.dataDir)), false);
});

test('each server start issues a different local token', async () => {
  const first = await startServer();
  let tokenA;
  try {
    tokenA = (await readDiscovery(first.dataDir)).token;
  } finally {
    await stopServer(first);
  }
  const second = await startServer();
  try {
    const tokenB = (await readDiscovery(second.dataDir)).token;
    assert.notEqual(tokenA, tokenB);
    assert.ok(tokenA && tokenB);
  } finally {
    await stopServer(second);
  }
});

test('removeDiscoverySync only deletes the file for its own pid', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-disc-'));
  const info = {
    protocolVersion: PROTOCOL_VERSION,
    serviceVersion: '0.1.0',
    pid: 4242,
    port: 3000,
    startedAt: 1,
    token: 'not-a-real-token',
  };
  writeDiscoverySync(dir, info);
  assert.equal(existsSync(discoveryPath(dir)), true);
  const validate = discoveryValidator();
  assert.equal(validate(JSON.parse(readFileSync(discoveryPath(dir), 'utf8'))), true);
  removeDiscoverySync(dir, 9999);
  assert.equal(existsSync(discoveryPath(dir)), true);
  removeDiscoverySync(dir, 4242);
  assert.equal(existsSync(discoveryPath(dir)), false);
});

test('GET /api/v2/service requires v2 credentials and ignores WEFT_TOKEN', async () => {
  const legacy = 't36-4-legacy-token';
  const srv = await startServer({ token: legacy });
  try {
    const discovery = await readDiscovery(srv.dataDir);

    const none = await getService(srv.port);
    assert.equal(none.status, 401);
    assert.equal(none.headers['weft-protocol'], PROTOCOL_VERSION);
    assert.equal(none.json?.error, 'unauthorized');
    assert.equal(none.json?.code, 'E_UNAUTHORIZED');
    const noneChecked = validateResponse('/api/v2/service', 'GET', 401, none.json);
    assert.equal(noneChecked.ok, true, JSON.stringify(noneChecked.errors));

    const wrong = await getService(srv.port, { authorization: 'Bearer not-the-token' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json?.code, 'E_UNAUTHORIZED');

    const legacyAuth = await getService(srv.port, { authorization: `Bearer ${legacy}` });
    assert.equal(legacyAuth.status, 401);
    assert.equal(legacyAuth.json?.code, 'E_UNAUTHORIZED');

    const ok = await getService(srv.port, { authorization: `Bearer ${discovery.token}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['weft-protocol'], PROTOCOL_VERSION);
    const okChecked = validateResponse('/api/v2/service', 'GET', 200, ok.json);
    assert.equal(okChecked.ok, true, JSON.stringify(okChecked.errors));
    assert.equal(ok.json.pid, srv.proc.pid);
  } finally {
    await stopServer(srv);
  }
});

test('web-code is bearer-only, one-shot, and exchanges for a session cookie', async () => {
  const srv = await startServer();
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const bearer = { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' };

    const noCred = await raw({
      port: srv.port,
      method: 'POST',
      path: '/api/v2/auth/web-code',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(noCred.status, 401);
    assert.equal(noCred.json?.code, 'E_UNAUTHORIZED');

    const issued = await raw({
      port: srv.port,
      method: 'POST',
      path: '/api/v2/auth/web-code',
      headers: bearer,
      body: '{}',
    });
    assert.equal(issued.status, 200);
    const issuedChecked = validateResponse('/api/v2/auth/web-code', 'POST', 200, issued.json);
    assert.equal(issuedChecked.ok, true, JSON.stringify(issuedChecked.errors));
    assert.equal(typeof issued.json.code, 'string');
    assert.ok(issued.json.code.length >= 32);
    assert.equal(typeof issued.json.expiresAt, 'number');
    assert.ok(issued.json.expiresAt > Date.now());
    assert.ok(issued.json.expiresAt <= Date.now() + 61_000);
    assert.equal(srv.logs().includes(issued.json.code), false);

    const login = await raw({
      port: srv.port,
      path: `/next/login?code=${encodeURIComponent(issued.json.code)}`,
    });
    assert.equal(login.status, 302);
    assert.equal(login.headers.location, '/next/');
    const setCookie = login.headers['set-cookie'];
    const cookie = parseSetCookie(Array.isArray(setCookie) ? setCookie[0] : setCookie);
    assert.equal(cookie.name, 'weft_session');
    assert.ok(cookie.value);
    assert.ok(cookie.attrs.includes('httponly'));
    assert.ok(cookie.attrs.includes('samesite=strict'));
    assert.ok(cookie.attrs.includes('path=/'));
    assert.equal(srv.logs().includes(cookie.value), false);

    const withCookie = await getService(srv.port, { cookie: `weft_session=${cookie.value}` });
    assert.equal(withCookie.status, 200);
    assert.equal(withCookie.json.protocolVersion, PROTOCOL_VERSION);

    const cookieIssue = await raw({
      port: srv.port,
      method: 'POST',
      path: '/api/v2/auth/web-code',
      headers: { 'content-type': 'application/json', cookie: `weft_session=${cookie.value}` },
      body: '{}',
    });
    assert.equal(cookieIssue.status, 401);
    assert.equal(cookieIssue.json?.code, 'E_UNAUTHORIZED');

    const reused = await raw({
      port: srv.port,
      path: `/next/login?code=${encodeURIComponent(issued.json.code)}`,
    });
    assert.equal(reused.status, 401);
    assert.match(reused.headers['content-type'] || '', /text\/plain/);
    assert.equal(reused.text, '登录链接无效或已过期，请重新运行 weft open');
  } finally {
    await stopServer(srv);
  }
});

test('expired web-code cannot be exchanged for a cookie', async () => {
  const srv = await startServer({ env: { WEFT_V2_WEB_CODE_TTL_MS: '20' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const issued = await raw({
      port: srv.port,
      method: 'POST',
      path: '/api/v2/auth/web-code',
      headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(issued.status, 200);
    assert.ok(issued.json.code);
    await sleep(50);
    const login = await raw({
      port: srv.port,
      path: `/next/login?code=${encodeURIComponent(issued.json.code)}`,
    });
    assert.equal(login.status, 401);
    assert.equal(login.text, '登录链接无效或已过期，请重新运行 weft open');
  } finally {
    await stopServer(srv);
  }
});

test('legacy /api/settings is unchanged when WEFT_TOKEN is unset', async () => {
  const srv = await startServer();
  try {
    const res = await raw({ port: srv.port, path: '/api/settings' });
    assert.equal(res.status, 200);
    assert.equal(typeof res.json, 'object');
  } finally {
    await stopServer(srv);
  }
});
