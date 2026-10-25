import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { startServer, stopServer } from './_server.mjs';
import { ROOT } from './_root.mjs';

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

test('GET /next redirects to /next/', async () => {
  const srv = await startServer();
  try {
    const res = await raw({ port: srv.port, path: '/next' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/next/');
  } finally {
    await stopServer(srv);
  }
});

test('GET /next/assets/not-exist.js is 404', async () => {
  const srv = await startServer();
  try {
    const res = await raw({ port: srv.port, path: '/next/assets/not-exist.js' });
    assert.equal(res.status, 404);
  } finally {
    await stopServer(srv);
  }
});

test('GET /next/ is SPA html when built, or the not-built message', async () => {
  const srv = await startServer();
  try {
    const res = await raw({ port: srv.port, path: '/next/' });
    const built = existsSync(path.join(ROOT, 'public-next', 'index.html'));
    if (built) {
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'] || '', /text\/html/);
      assert.match(res.text, /next-app|Weft|\/next\/assets\//);
    } else {
      assert.equal(res.status, 404);
      assert.match(res.text, /npm run build:web/);
    }
  } finally {
    await stopServer(srv);
  }
});

test('GET / still serves the old frontend', async () => {
  const srv = await startServer();
  try {
    const res = await raw({ port: srv.port, path: '/' });
    assert.equal(res.status, 200);
    assert.match(res.text, /data-testid="new-chat-top"/);
    assert.doesNotMatch(res.text, /data-testid="next-app"/);
  } finally {
    await stopServer(srv);
  }
});
