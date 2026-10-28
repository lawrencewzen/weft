import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { quotePwshLiteral } from '../../src/core/open-terminal.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';
import { ROOT } from './_root.mjs';

const TOKEN = 'v2-open-term-token';

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function sendV2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? v2Headers(token) : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
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

async function boot(t, extra = {}) {
  const logDir = await mkdtemp(path.join(tmpdir(), 'weft-term-http-'));
  const log = path.join(logDir, 'spawn.jsonl');
  const srv = await startServer({
    token: TOKEN,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: path.join(ROOT, 'tests/fixtures/basic.json'),
      WEFT_TERMINAL_MOCK: log,
      ...extra,
    },
  });
  t.after(() => stopServer(srv));
  const discovery = await readDiscovery(srv.dataDir);
  const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'term-ws' }, TOKEN);
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  await mkdir(path.join(ws.body.path, 'src'), { recursive: true });
  await writeFile(path.join(ws.body.path, 'src', 'app.js'), 'ok\n');
  await writeFile(path.join(ws.body.path, 'README.md'), 'hi\n');
  await writeFile(path.join(ws.body.path, '..', 'secret.txt'), 'outside\n');
  return { srv, discovery, ws: ws.body, log };
}

test('POST open-terminal opens the workspace root and a subdirectory', { timeout: 40_000 }, async (t) => {
  const { srv, discovery, ws, log } = await boot(t);
  const root = await sendV2(srv.base, 'POST', `/api/v2/workspaces/${ws.id}/open-terminal`, discovery.token, {});
  assert.equal(root.status, 200, root.text);
  assert.equal(root.headers.get('weft-protocol'), PROTOCOL_VERSION);
  assertChecked(`/api/v2/workspaces/${ws.id}/open-terminal`, 'POST', 200, root.body);
  assert.deepEqual(root.body, { opened: true });

  const nested = await sendV2(
    srv.base,
    'POST',
    `/api/v2/workspaces/${ws.id}/open-terminal`,
    discovery.token,
    { path: 'src' },
  );
  assert.equal(nested.status, 200, nested.text);
  assertChecked(`/api/v2/workspaces/${ws.id}/open-terminal`, 'POST', 200, nested.body);

  const lines = (await readFile(log, 'utf8')).trim().split('\n').map((row) => JSON.parse(row));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].dir, ws.path);
  assert.equal(lines[1].dir, path.join(ws.path, 'src'));
  assert.equal(lines[0].launches[0].detached, true);
  assert.equal(lines[0].launches[0].stdio, 'ignore');
  if (process.platform === 'win32') {
    assert.equal(lines[0].launches[0].command, 'wt.exe');
    assert.deepEqual(lines[0].launches[0].args, ['-d', ws.path]);
    assert.equal(lines[0].launches[1].command, 'cmd.exe');
    assert.ok(lines[0].launches[1].args.includes(`Set-Location -LiteralPath ${quotePwshLiteral(ws.path)}`));
  } else if (process.platform === 'darwin') {
    assert.equal(lines[0].launches[0].command, 'open');
    assert.deepEqual(lines[0].launches[0].args, ['-a', 'Terminal', ws.path]);
  } else {
    assert.equal(lines[0].launches[0].command, 'x-terminal-emulator');
    assert.equal(lines[0].launches[1].command, 'gnome-terminal');
  }
});

test('POST open-terminal rejects traversal, files, and missing workspaces', { timeout: 40_000 }, async (t) => {
  const { srv, discovery, ws } = await boot(t);
  const escaped = await sendV2(
    srv.base,
    'POST',
    `/api/v2/workspaces/${ws.id}/open-terminal`,
    discovery.token,
    { path: '../secret.txt' },
  );
  assert.equal(escaped.status, 400, escaped.text);
  assertChecked(`/api/v2/workspaces/${ws.id}/open-terminal`, 'POST', 400, escaped.body);
  assert.equal(escaped.body.code, 'E_PATH');

  const abs = await sendV2(
    srv.base,
    'POST',
    `/api/v2/workspaces/${ws.id}/open-terminal`,
    discovery.token,
    { path: path.join(ws.path, '..', 'secret.txt') },
  );
  assert.equal(abs.status, 400, abs.text);
  assert.equal(abs.body.code, 'E_PATH');

  const file = await sendV2(
    srv.base,
    'POST',
    `/api/v2/workspaces/${ws.id}/open-terminal`,
    discovery.token,
    { path: 'README.md' },
  );
  assert.equal(file.status, 400, file.text);
  assert.equal(file.body.code, 'E_PATH');
  assert.match(file.body.error, /目录|director/i);

  const missing = await sendV2(
    srv.base,
    'POST',
    '/api/v2/workspaces/nope/open-terminal',
    discovery.token,
    {},
  );
  assert.equal(missing.status, 404, missing.text);
  assertChecked('/api/v2/workspaces/nope/open-terminal', 'POST', 404, missing.body);

  const unauth = await sendV2(srv.base, 'POST', `/api/v2/workspaces/${ws.id}/open-terminal`, null, {});
  assert.equal(unauth.status, 401);
  assertChecked(`/api/v2/workspaces/${ws.id}/open-terminal`, 'POST', 401, unauth.body);
});
