import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readDiscovery, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function v2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

test('service mode writes service.log: startup line, 404, model call, stop reason; console stays quiet', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('weft-server-log-');
  const logFile = path.join(dataDir, 'logs', 'service.log');
  const srv = await startServer({
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_LOG_CONSOLE: '0', WEFT_LOG_LEVEL: 'debug' },
  });
  let stopped = false;
  try {
    const { token } = await readDiscovery(dataDir);
    const missing = await v2(srv.base, 'GET', '/api/v2/no-such-route', token);
    assert.equal(missing.status, 404, missing.text);
    const created = await v2(srv.base, 'POST', '/api/v2/conversations', token, { title: 'log' });
    const cid = JSON.parse(created.text).id;
    const sent = await v2(srv.base, 'POST', `/api/v2/conversations/${cid}/messages`, token, {
      text: 'PRIVATE PROMPT TEXT',
      requestId: 'log-1',
    });
    assert.equal(sent.status, 202, sent.text);
    let text = '';
    for (let i = 0; i < 100 && !/\[WEFT_LLM\].*model call/.test(text); i += 1) {
      await sleep(100);
      text = await readFile(logFile, 'utf8').catch(() => '');
    }
    assert.match(text, /INFO {2}\[WEFT_START\] version=\S+ .*node=v\d+.* port=\d+ dataDir=.* startupMs=\d+ listening/);
    assert.match(text, /DEBUG \[WEFT_HTTP\] method=GET path=\/api\/v2\/no-such-route status=404 ms=\d+ client error/);
    assert.match(text, new RegExp(`INFO {2}\\[WEFT_LLM\\] cid=${cid} provider=faux model=\\S+ .*stopReason=\\w+ model call`));
    assert.equal(text.includes('PRIVATE PROMPT TEXT'), false);
    assert.equal(/^\d{4}-\d\d-\d\d /m.test(srv.logs()), false, 'console should not get log lines in service mode');

    await stopServer(srv);
    stopped = true;
    text = await readFile(logFile, 'utf8');
    assert.match(text, /\[WEFT_STOP\] reason=stdin-closed code=0 uptimeSec=\d+ exit/);
  } finally {
    if (!stopped) await stopServer(srv);
    await removeTempDir(dataDir);
  }
});
