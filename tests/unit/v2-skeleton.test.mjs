import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { compileSchema, matchContractPath, validateResponse } from '../../src/v2/validate.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, startServer, stopServer } from './_server.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));

async function getJson(base, apiPath, headers = {}) {
  const res = await fetch(base + apiPath, { headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text, headers: res.headers };
}

test('PROTOCOL_VERSION matches contract info.version', () => {
  assert.equal(PROTOCOL_VERSION, spec.info.version);
  assert.equal(PROTOCOL_VERSION, '2.0.0');
});

test('validateResponse rejects a non-conforming service body', () => {
  const result = validateResponse('/api/v2/service', 'GET', 200, {
    protocolVersion: '2.0.0',
    extra: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors?.length);
});

test('validateResponse accepts a conforming service body', () => {
  const result = validateResponse('/api/v2/service', 'GET', 200, {
    protocolVersion: '2.0.0',
    serviceVersion: '0.1.0',
    pid: 1,
    startedAt: 1,
    demo: false,
  });
  assert.equal(result.ok, true);
});

test('ServiceInfo requires demo and accepts true or false', () => {
  const missing = validateResponse('/api/v2/service', 'GET', 200, {
    protocolVersion: '2.0.0',
    serviceVersion: '0.1.0',
    pid: 1,
    startedAt: 1,
  });
  assert.equal(missing.ok, false);
  const asTrue = validateResponse('/api/v2/service', 'GET', 200, {
    protocolVersion: '2.0.0',
    serviceVersion: '0.1.0',
    pid: 1,
    startedAt: 1,
    demo: true,
  });
  assert.equal(asTrue.ok, true);
  const asFalse = validateResponse('/api/v2/service', 'GET', 200, {
    protocolVersion: '2.0.0',
    serviceVersion: '0.1.0',
    pid: 1,
    startedAt: 1,
    demo: false,
  });
  assert.equal(asFalse.ok, true);
});

test('Ajv2020 enforces JSON Schema 2020-12 unevaluatedProperties', () => {
  const validate = compileSchema({
    type: 'object',
    properties: { a: { type: 'number' } },
    required: ['a'],
    unevaluatedProperties: false,
  });
  assert.equal(validate({ a: 1 }), true);
  assert.equal(validate({ a: 1, extra: true }), false);
});

test('GET /api/v2/service returns ServiceInfo with Weft-Protocol', async () => {
  const srv = await startServer();
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const res = await getJson(srv.base, '/api/v2/service', {
      authorization: `Bearer ${discovery.token}`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('weft-protocol'), PROTOCOL_VERSION);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const checked = validateResponse('/api/v2/service', 'GET', 200, res.body);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    assert.equal(res.body.pid, srv.proc.pid);
    assert.equal(res.body.protocolVersion, PROTOCOL_VERSION);
    assert.equal(
      res.body.serviceVersion,
      JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    );
    assert.equal(res.body.demo, false);
  } finally {
    await stopServer(srv);
  }
});

test('GET /api/v2/service demo is true when the process asked for the faux runtime', async () => {
  const srv = await startServer({ env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const res = await getJson(srv.base, '/api/v2/service', {
      authorization: `Bearer ${discovery.token}`,
    });
    assert.equal(res.status, 200);
    const checked = validateResponse('/api/v2/service', 'GET', 200, res.body);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    assert.equal(res.body.demo, true);
  } finally {
    await stopServer(srv);
  }
});

function sampleSnapshot() {
  return {
    conversation: {
      id: 'c1',
      workspaceId: 'w1',
      title: 't',
      updatedAt: 1,
      status: 'idle',
      model: null,
      run: {
        status: 'idle',
        startedAt: null,
        pendingText: null,
        canSend: true,
        canStop: false,
        lockedReason: null,
        error: null,
        lastActivityAt: null,
        stalledSince: null,
        activeTool: null,
      },
      context: { used: 0, window: 128000, percent: 0, level: 'ok' },
      itemIds: [],
    },
    items: [],
    tools: [],
  };
}

test('validateResponse matches OpenAPI path templates like /conversations/{id}', () => {
  assert.equal(matchContractPath('/api/v2/conversations/abc-123'), '/api/v2/conversations/{id}');
  assert.equal(matchContractPath('/api/v2/conversations/abc/extra'), undefined);
  assert.equal(matchContractPath('/api/v2/service'), '/api/v2/service');
  const ok = validateResponse('/api/v2/conversations/abc-123', 'GET', 200, sampleSnapshot());
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const missing = validateResponse('/api/v2/conversations/nope', 'GET', 404, { error: 'not found' });
  assert.equal(missing.ok, true, JSON.stringify(missing.errors));
  const unauth = validateResponse('/api/v2/conversations/abc-123', 'GET', 401, { error: 'unauthorized', code: 'E_UNAUTHORIZED' });
  assert.equal(unauth.ok, true, JSON.stringify(unauth.errors));
  const extra = validateResponse('/api/v2/conversations/abc/extra', 'GET', 200, sampleSnapshot());
  assert.equal(extra.ok, false);
});

test('GET /api/v2/nope returns 404 V2Error', async () => {
  const srv = await startServer();
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const res = await getJson(srv.base, '/api/v2/nope', {
      authorization: `Bearer ${discovery.token}`,
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('weft-protocol'), PROTOCOL_VERSION);
    const checked = validateResponse('/api/v2/nope', 'GET', 404, res.body);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    assert.equal(typeof res.body.error, 'string');
    assert.ok(res.body.error);
  } finally {
    await stopServer(srv);
  }
});
