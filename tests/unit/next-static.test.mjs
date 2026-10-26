import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { startServer, stopServer } from './_server.mjs';
import { ROOT } from './_root.mjs';
import { NOT_BUILT_HINT } from '../../src/v2/auth.ts';

function raw({ port, method = 'GET', path: reqPath = '/' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /next redirects to / and keeps the query string', async () => {
  const srv = await startServer();
  try {
    const res = await raw({ port: srv.port, path: '/next?x=1' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/?x=1');
  } finally {
    await stopServer(srv);
  }
});

test('GET /next/<path> redirects to the same path without the prefix', async () => {
  const srv = await startServer();
  try {
    const res = await raw({ port: srv.port, path: '/next/c/abc?y=2' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/c/abc?y=2');
  } finally {
    await stopServer(srv);
  }
});

test('GET /assets/not-exist.js is 404', async () => {
  const srv = await startServer();
  try {
    const res = await raw({ port: srv.port, path: '/assets/not-exist.js' });
    assert.equal(res.status, 404);
  } finally {
    await stopServer(srv);
  }
});

test('GET / is SPA html when built, or the not-built message', async () => {
  const srv = await startServer();
  try {
    const res = await raw({ port: srv.port, path: '/' });
    const built = existsSync(path.join(ROOT, 'public-next', 'index.html'));
    if (built) {
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'] || '', /text\/html/);
      assert.match(res.text, /next-app|Weft|\/assets\//);
    } else {
      assert.equal(res.status, 404);
      assert.equal(res.text, NOT_BUILT_HINT);
    }
  } finally {
    await stopServer(srv);
  }
});

test('GET /legacy serves the old frontend', async () => {
  const srv = await startServer();
  try {
    const bounce = await raw({ port: srv.port, path: '/legacy' });
    assert.equal(bounce.status, 302);
    assert.equal(bounce.headers.location, '/legacy/');
    const res = await raw({ port: srv.port, path: '/legacy/' });
    assert.equal(res.status, 200);
    assert.match(res.text, /data-testid="new-chat-top"/);
    assert.doesNotMatch(res.text, /data-testid="next-app"/);
    assert.match(res.text, /href="\/legacy\/themes\.css"/);
  } finally {
    await stopServer(srv);
  }
});
