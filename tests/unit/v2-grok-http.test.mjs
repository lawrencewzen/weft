import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createGrokAuth,
  GROK_AUTH_SCOPE,
  GROK_CLIENT_ID,
  GROK_DEVICE_CODE_URL,
  GROK_TOKEN_URL,
} from '../../src/core/grok-auth.mjs';
import { createV2Runtime } from '../../src/v2/index.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { discoveryPath } from '../../src/v2/daemon/discovery.ts';

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${body}.signature1`;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

async function send(port, method, apiPath, token, body) {
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

test('Grok device login via v2 writes tokens to auth.json and does not return secrets', async () => {
  process.env.WEFT_V2_VALIDATE = '1';
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-v2-grok-login-'));
  const authFile = path.join(dataDir, 'auth.json');
  const deviceCode = 'device-secret-code';
  let polls = 0;
  const grokAuth = createGrokAuth({
    authFile,
    now: () => Date.parse('2026-06-01T00:00:00.000Z'),
    fetch: async (url) => {
      if (url === GROK_DEVICE_CODE_URL) {
        return jsonResponse(200, {
          device_code: deviceCode,
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/device',
          verification_uri_complete: 'https://auth.x.ai/device?user_code=ABCD-EFGH',
          expires_in: 600,
          interval: 5,
        });
      }
      if (url === GROK_TOKEN_URL) {
        polls += 1;
        if (polls === 1) return jsonResponse(400, { error: 'authorization_pending' });
        return jsonResponse(200, {
          access_token: jwt({ sub: 'user-9', email: 'ada@example.com', exp: 4_000_000_000 }),
          refresh_token: 'refresh-from-device',
          expires_in: 3600,
        });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  let settings = { version: 2, sources: [], models: {} };
  const runtime = createV2Runtime({
    serviceVersion: '0.1.0',
    startedAt: 1,
    dataDir,
    getSettings: async () => settings,
    putSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    grokStatus: () => grokAuth.status(),
    grokStartLogin: () => grokAuth.startLogin(),
    grokPollLogin: (loginId) => grokAuth.pollLogin(loginId),
    grokCancelLogin: (loginId) => grokAuth.cancelLogin(loginId),
    grokLogout: () => grokAuth.logout(),
    async ensureGrokSource() {
      if ((settings.sources || []).some((source) => source.id === 'grok')) return;
      settings = {
        ...settings,
        sources: [...(settings.sources || []), {
          id: 'grok',
          kind: 'grok',
          vendor: 'grok',
          name: 'Grok 订阅',
          baseUrl: '',
          apiKey: '',
          models: ['grok-build'],
        }],
      };
    },
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    runtime.handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  runtime.writeDiscoveryFile(port);
  try {
    const discovery = JSON.parse(await readFile(discoveryPath(dataDir), 'utf8'));
    const started = await send(port, 'POST', '/api/v2/providers/grok/login', discovery.token, {});
    assert.equal(started.status, 200, started.text);
    const startChecked = validateResponse('/api/v2/providers/grok/login', 'POST', 200, started.body);
    assert.equal(startChecked.ok, true, JSON.stringify(startChecked.errors));
    assert.equal(started.body.userCode, 'ABCD-EFGH');
    assert.match(started.body.verificationUri, /^https:\/\/auth\.x\.ai\//);
    assert.equal(JSON.stringify(started.body).includes(deviceCode), false);

    const first = await send(port, 'POST', '/api/v2/providers/grok/login/poll', discovery.token, {
      loginId: started.body.loginId,
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.status, 'pending');
    const pendingChecked = validateResponse('/api/v2/providers/grok/login/poll', 'POST', 200, first.body);
    assert.equal(pendingChecked.ok, true, JSON.stringify(pendingChecked.errors));

    const done = await send(port, 'POST', '/api/v2/providers/grok/login/poll', discovery.token, {
      loginId: started.body.loginId,
    });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.status, 'done');
    assert.equal(done.body.grok.signedIn, true);
    assert.equal(done.body.grok.account, 'ada@example.com');
    const doneChecked = validateResponse('/api/v2/providers/grok/login/poll', 'POST', 200, done.body);
    assert.equal(doneChecked.ok, true, JSON.stringify(doneChecked.errors));
    assert.equal(JSON.stringify(done.body).includes(deviceCode), false);
    assert.equal(JSON.stringify(done.body).includes('refresh-from-device'), false);

    const disk = JSON.parse(await readFile(authFile, 'utf8'));
    assert.equal(disk[GROK_AUTH_SCOPE].auth_mode, 'oidc');
    assert.ok(disk[GROK_AUTH_SCOPE].refresh_token);

    const listed = await send(port, 'GET', '/api/v2/providers', discovery.token);
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.providers.some((item) => item.id === 'grok'), true);

    const missing = await send(port, 'POST', '/api/v2/providers/grok/login/poll', discovery.token, {
      loginId: 'no-such',
    });
    assert.equal(missing.status, 404);
    assert.equal(PROTOCOL_VERSION, discovery.protocolVersion);
  } finally {
    runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Grok login cancel drops the pending device flow', async () => {
  process.env.WEFT_V2_VALIDATE = '1';
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-v2-grok-cancel-'));
  const grokAuth = createGrokAuth({
    authFile: path.join(dataDir, 'auth.json'),
    now: () => Date.parse('2026-06-01T00:00:00.000Z'),
    fetch: async (url) => {
      if (url === GROK_DEVICE_CODE_URL) {
        return jsonResponse(200, {
          device_code: 'device-cancel-secret',
          user_code: 'CANC-EL12',
          verification_uri: 'https://auth.x.ai/device',
          verification_uri_complete: 'https://auth.x.ai/device?user_code=CANC-EL12',
          expires_in: 600,
          interval: 5,
        });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  const runtime = createV2Runtime({
    serviceVersion: '0.1.0',
    startedAt: 1,
    dataDir,
    grokStatus: () => grokAuth.status(),
    grokStartLogin: () => grokAuth.startLogin(),
    grokPollLogin: (loginId) => grokAuth.pollLogin(loginId),
    grokCancelLogin: (loginId) => grokAuth.cancelLogin(loginId),
    grokLogout: () => grokAuth.logout(),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    runtime.handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  runtime.writeDiscoveryFile(port);
  try {
    const discovery = JSON.parse(await readFile(discoveryPath(dataDir), 'utf8'));
    const started = await send(port, 'POST', '/api/v2/providers/grok/login', discovery.token, {});
    assert.equal(started.status, 200, started.text);
    const cancelled = await send(port, 'POST', '/api/v2/providers/grok/login/cancel', discovery.token, {
      loginId: started.body.loginId,
    });
    assert.equal(cancelled.status, 200, cancelled.text);
    const cancelChecked = validateResponse('/api/v2/providers/grok/login/cancel', 'POST', 200, cancelled.body);
    assert.equal(cancelChecked.ok, true, JSON.stringify(cancelChecked.errors));
    assert.equal(cancelled.body.pending, null);
    assert.equal(JSON.stringify(cancelled.body).includes('device-cancel-secret'), false);

    const session = await send(port, 'GET', '/api/v2/providers/grok/session', discovery.token);
    assert.equal(session.body.pending, null);
    const polled = await send(port, 'POST', '/api/v2/providers/grok/login/poll', discovery.token, {
      loginId: started.body.loginId,
    });
    assert.equal(polled.status, 404);
  } finally {
    runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});
