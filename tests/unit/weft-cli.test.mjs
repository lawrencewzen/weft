import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { discoveryPath, writeDiscoverySync } from '../../src/v2/daemon/discovery.ts';
import { ROOT } from './_root.mjs';

const WEFT_BIN = path.join(ROOT, 'bin/weft.mjs');

function weftEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.WEFT_STDIN_EXIT;
  if (!Object.prototype.hasOwnProperty.call(extra, 'WEFT_EXPECT_PROTOCOL')) {
    delete env.WEFT_EXPECT_PROTOCOL;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, 'WEFT_LAUNCHED_BY')) {
    delete env.WEFT_LAUNCHED_BY;
  }
  return {
    ...env,
    WEFT_IDLE_EXIT_MINUTES: extra.WEFT_IDLE_EXIT_MINUTES ?? '0',
  };
}

function runWeft(args, { env = {}, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [WEFT_BIN, ...args], {
      cwd: ROOT,
      env: weftEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`weft timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function pidIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (existsSync(path.join('/proc', String(pid)))) return true;
  } catch { /* no /proc */ }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  return Promise.resolve();
}

async function readDiscoveryFile(dataDir) {
  return JSON.parse(await readFile(path.join(dataDir, 'service.json'), 'utf8'));
}

async function forceStop(dataDir) {
  try {
    await runWeft(['stop', '--data-dir', dataDir], { timeoutMs: 20000 });
  } catch { /* ignore */ }
  let pid;
  try {
    pid = JSON.parse(readFileSync(path.join(dataDir, 'service.json'), 'utf8')).pid;
  } catch {
    pid = null;
  }
  if (pid && pid !== process.pid) {
    await killPid(pid);
    const started = Date.now();
    while (Date.now() - started < 5000 && pidIsLive(pid)) {
      await sleep(50);
    }
  }
}

function listenHangServer() {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('hang server has no port'));
        return;
      }
      resolve({
        server,
        port: addr.port,
        close() {
          for (const socket of sockets) {
            try { socket.destroy(); } catch { /* ignore */ }
          }
          sockets.clear();
          return new Promise((done) => {
            server.close(() => done());
          });
        },
      });
    });
  });
}

async function unusedPort() {
  const hung = await listenHangServer();
  const { port } = hung;
  await hung.close();
  return port;
}

function assertNoSecrets(output, secrets) {
  for (const secret of secrets) {
    if (!secret) continue;
    assert.equal(output.includes(secret), false, 'output leaked a secret');
  }
}

function parseLoginUrl(stdout) {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean)[0] || '';
  const url = new URL(line);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/next/login');
  const code = url.searchParams.get('code');
  assert.ok(code && code.length > 8);
  return { url: line, port: Number(url.port), code };
}

function raw({ port, method = 'GET', path: reqPath = '/', headers = {}, body, redirect = true }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers,
    }, (res) => {
      if (redirect && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, `http://127.0.0.1:${port}`);
        resolve(raw({
          port: next.port ? Number(next.port) : port,
          path: `${next.pathname}${next.search}`,
          headers,
        }));
        return;
      }
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

async function openConversation(port, title = 'cli') {
  const ws = await raw({
    port,
    method: 'POST',
    path: '/api/workspaces',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cli-ws' }),
  });
  assert.equal(ws.status, 201, ws.text);
  const conv = await raw({
    port,
    method: 'POST',
    path: `/api/workspaces/${ws.json.id}/conversations`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  assert.equal(conv.status, 201, conv.text);
  return conv.json;
}

test('open --print starts a service, login URL works, and a second open reuses the pid', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-cli-open-'));
  try {
    const first = await runWeft(['open', '--print', '--data-dir', dataDir]);
    assert.equal(first.code, 0, first.stderr);
    const printed = parseLoginUrl(first.stdout);
    assert.equal(first.stdout.trim().split(/\r?\n/).length, 1);
    const discovery = await readDiscoveryFile(dataDir);
    assert.ok(pidIsLive(discovery.pid));
    assert.notEqual(discovery.pid, process.pid);
    assert.equal(discovery.port, printed.port);
    assertNoSecrets(`${first.stdout}\n${first.stderr}`, [discovery.token]);
    assert.equal(first.stdout.includes(discovery.token), false);

    const login = await raw({
      port: printed.port,
      path: `/next/login?code=${encodeURIComponent(printed.code)}`,
      redirect: false,
    });
    assert.equal(login.status, 302, login.text);
    assert.equal(login.headers.location, '/next/');
    const setCookie = login.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.match(String(cookieHeader), /weft_session=/);

    const second = await runWeft(['open', '--print', '--data-dir', dataDir]);
    assert.equal(second.code, 0, second.stderr);
    const again = parseLoginUrl(second.stdout);
    const after = await readDiscoveryFile(dataDir);
    assert.equal(after.pid, discovery.pid);
    assert.equal(after.startedAt, discovery.startedAt);
    assert.equal(again.port, discovery.port);
    assert.notEqual(again.code, printed.code);
    assertNoSecrets(`${second.stdout}\n${second.stderr}`, [discovery.token, after.token]);
  } finally {
    await forceStop(dataDir);
  }
});

test('open --print deletes a stale discovery file and launches a new service', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-cli-stale-'));
  try {
    writeDiscoverySync(dataDir, {
      protocolVersion: PROTOCOL_VERSION,
      serviceVersion: '0.1.0',
      pid: 999999999,
      port: 1,
      startedAt: 1,
      token: 'stale-token-not-real-aaaaaaaaaaaa',
    });
    assert.equal(existsSync(discoveryPath(dataDir)), true);
    const opened = await runWeft(['open', '--print', '--data-dir', dataDir]);
    assert.equal(opened.code, 0, opened.stderr);
    const printed = parseLoginUrl(opened.stdout);
    const discovery = await readDiscoveryFile(dataDir);
    assert.notEqual(discovery.pid, 999999999);
    assert.ok(pidIsLive(discovery.pid));
    assert.equal(discovery.port, printed.port);
    assert.notEqual(discovery.token, 'stale-token-not-real-aaaaaaaaaaaa');
    assertNoSecrets(`${opened.stdout}\n${opened.stderr}`, [discovery.token, 'stale-token-not-real-aaaaaaaaaaaa']);
  } finally {
    await forceStop(dataDir);
  }
});

test('live pid with an unresponsive port keeps service.json and does not launch', { timeout: 20000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-cli-hang-'));
  const hung = await listenHangServer();
  try {
    writeDiscoverySync(dataDir, {
      protocolVersion: PROTOCOL_VERSION,
      serviceVersion: '0.1.0',
      pid: process.pid,
      port: hung.port,
      startedAt: 1,
      token: 'hang-token-not-real-bbbbbbbbbbbb',
    });
    const probeEnv = { WEFT_PROBE_TIMEOUT_MS: '200' };
    const opened = await runWeft(['open', '--print', '--data-dir', dataDir], {
      env: probeEnv,
      timeoutMs: 10000,
    });
    assert.equal(opened.code, 1, `${opened.stdout}\n${opened.stderr}`);
    assert.match(opened.stderr, /没有响应/);
    assert.match(opened.stderr, new RegExp(`pid ${process.pid}`));
    assert.equal(existsSync(discoveryPath(dataDir)), true);
    const afterOpen = await readDiscoveryFile(dataDir);
    assert.equal(afterOpen.pid, process.pid);
    assert.equal(afterOpen.port, hung.port);
    assert.equal(existsSync(path.join(dataDir, 'logs', 'service.log')), false);

    const status = await runWeft(['status', '--data-dir', dataDir], {
      env: probeEnv,
      timeoutMs: 10000,
    });
    assert.equal(status.code, 1, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stderr, /没有响应/);
    assert.equal(existsSync(discoveryPath(dataDir)), true);
    assert.equal((await readDiscoveryFile(dataDir)).pid, process.pid);
    assert.equal(existsSync(path.join(dataDir, 'logs', 'service.log')), false);
  } finally {
    await hung.close();
    await forceStop(dataDir);
  }
});

test('open --print treats ECONNREFUSED with a live pid as stale and launches', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-cli-refused-'));
  try {
    const port = await unusedPort();
    writeDiscoverySync(dataDir, {
      protocolVersion: PROTOCOL_VERSION,
      serviceVersion: '0.1.0',
      pid: process.pid,
      port,
      startedAt: 1,
      token: 'refused-token-not-real-cccccccccccc',
    });
    const opened = await runWeft(['open', '--print', '--data-dir', dataDir]);
    assert.equal(opened.code, 0, opened.stderr);
    const printed = parseLoginUrl(opened.stdout);
    const discovery = await readDiscoveryFile(dataDir);
    assert.notEqual(discovery.pid, process.pid);
    assert.ok(pidIsLive(discovery.pid));
    assert.equal(discovery.port, printed.port);
    assert.notEqual(discovery.port, port);
    assertNoSecrets(`${opened.stdout}\n${opened.stderr}`, [discovery.token, 'refused-token-not-real-cccccccccccc']);
  } finally {
    await forceStop(dataDir);
  }
});

test('open restarts once when protocol is incompatible then exits 3', { timeout: 90000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-cli-proto-'));
  try {
    const started = await runWeft(['open', '--print', '--data-dir', dataDir]);
    assert.equal(started.code, 0, started.stderr);
    const old = await readDiscoveryFile(dataDir);
    assert.ok(pidIsLive(old.pid));

    const bumped = await runWeft(['open', '--print', '--data-dir', dataDir], {
      env: { WEFT_EXPECT_PROTOCOL: '3.0.0' },
    });
    assert.equal(bumped.code, 3, `${bumped.stdout}\n${bumped.stderr}`);
    assert.match(bumped.stderr, /3\.0\.0/);
    assert.match(bumped.stderr, /2\.0\.0|大版本/);
    assert.equal(bumped.stdout.includes('/next/login'), false);
    assertNoSecrets(`${bumped.stdout}\n${bumped.stderr}`, [old.token]);

    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000 && pidIsLive(old.pid)) {
      await sleep(50);
    }
    assert.equal(pidIsLive(old.pid), false, 'old process should have exited');

    const next = await readDiscoveryFile(dataDir);
    assert.notEqual(next.pid, old.pid);
    assert.ok(pidIsLive(next.pid));
    assert.equal(next.protocolVersion, PROTOCOL_VERSION);
    assertNoSecrets(`${bumped.stdout}\n${bumped.stderr}`, [next.token]);
  } finally {
    await forceStop(dataDir);
  }
});

test('stop returns 2 when busy and 0 when idle; open busy-incompatible returns 2', { timeout: 90000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-cli-busy-'));
  const ready = path.join(dataDir, 'hold-ready');
  try {
    const opened = await runWeft(['open', '--print', '--data-dir', dataDir], {
      env: {
        WEFT_LLM: 'faux',
        WEFT_FAUX_HOLD: '1',
        WEFT_FAUX_HOLD_READY: ready,
        WEFT_FAUX_TEXT: 'cli-hold',
      },
    });
    assert.equal(opened.code, 0, opened.stderr);
    const discovery = await readDiscoveryFile(dataDir);
    const conv = await openConversation(discovery.port, 'busy');
    const sent = await raw({
      port: discovery.port,
      method: 'POST',
      path: `/api/conversations/${conv.id}/messages`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hold' }),
    });
    assert.equal(sent.status, 202, sent.text);
    await waitForFile(ready);

    const busyOpen = await runWeft(['open', '--print', '--data-dir', dataDir], {
      env: {
        WEFT_LLM: 'faux',
        WEFT_FAUX_HOLD: '1',
        WEFT_FAUX_HOLD_READY: ready,
        WEFT_EXPECT_PROTOCOL: '3.0.0',
      },
    });
    assert.equal(busyOpen.code, 2, `${busyOpen.stdout}\n${busyOpen.stderr}`);
    assert.match(`${busyOpen.stdout}\n${busyOpen.stderr}`, /服务正在运行任务，等任务结束后再试/);
    assert.equal(pidIsLive(discovery.pid), true);
    assert.equal((await readDiscoveryFile(dataDir)).pid, discovery.pid);

    const busyStop = await runWeft(['stop', '--data-dir', dataDir], {
      env: { WEFT_LLM: 'faux', WEFT_FAUX_HOLD: '1' },
    });
    assert.equal(busyStop.code, 2, `${busyStop.stdout}\n${busyStop.stderr}`);
    assert.match(busyStop.stdout, /服务正在运行任务，没有停止/);
    assert.equal(pidIsLive(discovery.pid), true);
    assertNoSecrets(
      `${opened.stdout}\n${opened.stderr}\n${busyOpen.stdout}\n${busyOpen.stderr}\n${busyStop.stdout}\n${busyStop.stderr}`,
      [discovery.token],
    );

    const stopped = await raw({
      port: discovery.port,
      method: 'POST',
      path: `/api/conversations/${conv.id}/stop`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(stopped.status, 200, stopped.text);
    await waitForStatus(discovery.port, conv.id, (row) => row.status === 'stopped' || row.status === 'done');

    const idleStop = await runWeft(['stop', '--data-dir', dataDir]);
    assert.equal(idleStop.code, 0, idleStop.stderr);
    assert.match(idleStop.stdout, /已停止/);
    const endedAt = Date.now();
    while (Date.now() - endedAt < 8000 && pidIsLive(discovery.pid)) {
      await sleep(50);
    }
    assert.equal(pidIsLive(discovery.pid), false);
    assert.equal(existsSync(discoveryPath(dataDir)), false);
    assertNoSecrets(`${idleStop.stdout}\n${idleStop.stderr}`, [discovery.token]);
  } finally {
    await forceStop(dataDir);
  }
});

test('status reports running and stopped without leaking the token', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-cli-status-'));
  try {
    const missing = await runWeft(['status', '--data-dir', dataDir]);
    assert.equal(missing.code, 1, missing.stderr);
    assert.match(missing.stdout, /服务没有运行/);

    const opened = await runWeft(['open', '--print', '--data-dir', dataDir]);
    assert.equal(opened.code, 0, opened.stderr);
    const discovery = await readDiscoveryFile(dataDir);

    const running = await runWeft(['status', '--data-dir', dataDir]);
    assert.equal(running.code, 0, running.stderr);
    assert.match(running.stdout, new RegExp(`端口: ${discovery.port}`));
    assert.match(running.stdout, new RegExp(`pid: ${discovery.pid}`));
    assert.match(running.stdout, new RegExp(`协议版本: ${PROTOCOL_VERSION}`));
    assert.match(running.stdout, new RegExp(`服务版本: ${discovery.serviceVersion}`));
    assert.match(running.stdout, /启动时间:/);
    assert.equal(running.stdout.includes(discovery.token), false);
    assert.equal(running.stderr.includes(discovery.token), false);
    assertNoSecrets(`${missing.stdout}\n${running.stdout}\n${running.stderr}\n${opened.stdout}`, [discovery.token]);

    const stopped = await runWeft(['stop', '--data-dir', dataDir]);
    assert.equal(stopped.code, 0, stopped.stderr);
    const after = await runWeft(['status', '--data-dir', dataDir]);
    assert.equal(after.code, 1, after.stderr);
    assert.match(after.stdout, /服务没有运行/);
    assertNoSecrets(`${stopped.stdout}\n${after.stdout}\n${after.stderr}`, [discovery.token]);
  } finally {
    await forceStop(dataDir);
  }
});
