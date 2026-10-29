import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { readDiscovery, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-providers-http-token';

async function sendV2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body == null || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
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

const PATHS = [
  ['GET', '/api/v2/providers'],
  ['POST', '/api/v2/providers'],
  ['POST', '/api/v2/providers/test'],
  ['PATCH', '/api/v2/providers/custom-aaaaaaaa'],
  ['DELETE', '/api/v2/providers/custom-aaaaaaaa'],
  ['POST', '/api/v2/providers/custom-aaaaaaaa/test'],
  ['PUT', '/api/v2/providers/custom-aaaaaaaa/models/alpha/context-window'],
];

test('every /api/v2/providers route returns 503 E_UNAVAILABLE until T59-4b', async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    for (const [method, apiPath] of PATHS) {
      const got = await sendV2(
        srv.base,
        method,
        apiPath,
        discovery.token,
        method === 'GET' || method === 'HEAD' ? undefined : {},
      );
      assert.equal(got.status, 503, `${method} ${apiPath} ${got.text}`);
      assert.equal(got.body.error, 'providers api is being rewritten');
      assert.equal(got.body.code, 'E_UNAVAILABLE');
      assert.equal(got.headers.get('weft-protocol'), PROTOCOL_VERSION);
      assertChecked(apiPath.split('?')[0], method, 503, got.body);
    }

    const unauth = await sendV2(srv.base, 'GET', '/api/v2/providers');
    assert.equal(unauth.status, 401);
    assertChecked('/api/v2/providers', 'GET', 401, unauth.body);
  } finally {
    await stopServer(srv);
  }
});

test('legacy /api/sources routes also return 503 E_UNAVAILABLE', async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const listed = await sendV2(srv.base, 'GET', '/api/sources', TOKEN);
    assert.equal(listed.status, 503, listed.text);
    assert.equal(listed.body.code, 'E_UNAVAILABLE');
    const created = await sendV2(srv.base, 'POST', '/api/sources', TOKEN, { vendor: 'custom' });
    assert.equal(created.status, 503, created.text);
  } finally {
    await stopServer(srv);
  }
});
