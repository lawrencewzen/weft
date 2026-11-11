import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readDiscovery, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';
import {
  createClientLogLimiter,
  safePath,
  truncateBytes,
} from '../../src/v2/http/client-log.ts';


let TOKEN = '';
async function post(base, body, token = TOKEN) {
  const res = await fetch(`${base}/api/v2/client-log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function readLog(dataDir) {
  try { return await readFile(path.join(dataDir, 'logs', 'service.log'), 'utf8'); } catch { return ''; }
}

test('client-log: auth, validation, truncation, redaction of query, 204', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('weft-client-log-');
  const srv = await startServer({ dataDir, env: { WEFT_LLM: 'faux', WEFT_LOG_CONSOLE: '0', WEFT_V2_VALIDATE: '1' } });
  try {
    TOKEN = (await readDiscovery(dataDir)).token;
    const noAuth = await post(srv.base, { level: 'error', message: 'x' }, null);
    assert.equal(noAuth.status, 401);

    assert.equal((await post(srv.base, { level: 'info', message: 'x' })).status, 400);
    assert.equal((await post(srv.base, { level: 'error' })).status, 400);
    assert.equal((await post(srv.base, { level: 'error', message: 'x', source: 'nope' })).status, 400);

    const big = await post(srv.base, {
      level: 'error',
      message: `BIGMSG${'m'.repeat(5000)}`,
      stack: `at ${'s'.repeat(20000)}ENDSTACK`,
      source: 'window.onerror',
      url: 'http://127.0.0.1:1/c/abc?token=SECRETQ#/x',
      userAgent: 'UA/1',
    });
    assert.equal(big.status, 204);
    assert.equal(big.text, '');
    const warn = await post(srv.base, { level: 'warn', message: 'just a warning', source: 'console', url: '/settings#a?q=1' });
    assert.equal(warn.status, 204);

    let text = '';
    for (let i = 0; i < 50 && !text.includes('just a warning'); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      text = await readLog(dataDir);
    }
    const line = text.split('\n').find((l) => l.includes('BIGMSG'));
    assert.match(line, /ERROR \[WEFT_CLIENT\] source=window\.onerror path=\/c\/abc#\/x ua=UA\/1 BIGMSG/);
    assert.ok(line.length < 2300, `message truncated (${line.length})`);
    assert.ok(!text.includes('SECRETQ'));
    assert.ok(!text.includes('ENDSTACK'), 'stack truncated');
    assert.match(text, /WARN {2}\[WEFT_CLIENT\] source=console path="?\/settings#a"? just a warning/);
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});

test('truncateBytes and safePath', () => {
  assert.equal(truncateBytes('abc', 10), 'abc');
  const cut = truncateBytes('你好世界'.repeat(10), 10);
  assert.ok(Buffer.byteLength(cut.replace('…[truncated]', '')) <= 10);
  assert.equal(safePath('https://h:1/a/b?x=1#/c'), '/a/b#/c');
  assert.equal(safePath('/a?x=1'), '/a');
});

test('limiter: 30 per minute per session, drops reported once per window', () => {
  const records = [];
  let now = 1000;
  const logger = { warn: (tag, msg) => records.push([tag, msg]), error() {} };
  const lim = createClientLogLimiter({ logger, now: () => now });
  let allowed = 0;
  for (let i = 0; i < 40; i += 1) if (lim.allow('a')) allowed += 1;
  assert.equal(allowed, 30);
  assert.equal(lim.allow('b'), true, 'other session unaffected');
  assert.equal(records.length, 0);
  now += 61_000;
  assert.equal(lim.allow('a'), true);
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 'WEFT_CLIENT');
  assert.match(records[0][1], /dropped 10 /);
});
