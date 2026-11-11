import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger, formatLine, parseLevel, trackHttp, lineLog, logLine } from '../../src/core/log.mjs';
import { redactSecrets } from '../../src/core/redact.mjs';
import { ROOT } from './_root.mjs';

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'weft-log-'));
}

const read = (dir, name = 'service.log') => readFileSync(path.join(dir, 'logs', name), 'utf8');

test('line format: local time, level, tag, fields, message; errors add an indented stack', async () => {
  const dir = await tmp();
  try {
    const logger = createLogger({ dataDir: dir, console: false });
    logger.error('WEFT_X', 'it broke', { cid: 'c1', ms: 12, note: 'two words' }, new Error('boom'));
    const text = read(dir);
    const [first, ...rest] = text.trimEnd().split('\n');
    assert.match(first, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} ERROR \[WEFT_X\] cid=c1 ms=12 note="two words" it broke$/);
    assert.match(rest[0], /^    Error: boom$/);
    assert.ok(rest.length >= 2 && rest.every((l) => l.startsWith('    ')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('formatLine: an Error alone uses its message as the head text', () => {
  const line = formatLine('warn', 'T', '', [new Error('bad thing')], new Date(2026, 10, 10, 14, 3, 22, 517));
  assert.match(line, /^2026-11-10 14:03:22\.517 WARN  \[T\] bad thing\n    Error: bad thing/);
});

test('level filter: default info, WEFT_LOG_LEVEL / configure override', async () => {
  const dir = await tmp();
  try {
    const logger = createLogger({ dataDir: dir, console: false, level: 'info' });
    logger.debug('T', 'hidden');
    logger.info('T', 'shown-info');
    logger.warn('T', 'shown-warn');
    logger.configure({ level: 'error' });
    logger.warn('T', 'now-hidden');
    logger.error('T', 'shown-error');
    logger.configure({ level: 'debug' });
    logger.debug('T', 'shown-debug');
    const text = read(dir);
    for (const want of ['shown-info', 'shown-warn', 'shown-error', 'shown-debug']) assert.ok(text.includes(want), want);
    assert.equal(text.includes('now-hidden'), false);
    assert.equal(/\bhidden\b/.test(text.replace('now-hidden', '')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(parseLevel('DEBUG'), 'debug');
  assert.equal(parseLevel('nonsense'), 'info');
  assert.equal(parseLevel(undefined), 'info');
});

test('redaction: keys, JWT, Bearer, Authorization, api_key=, token=, password=, URL credentials', async () => {
  const body = Buffer.from('{"a":1}').toString('base64url');
  const jwt = `eyJhbGciOiJub25lIn0.${body}.signature1`;
  const cases = [
    ['key sk-abcdef123456 end', 'sk-abcdef123456'],
    [`jwt ${jwt}`, jwt],
    ['Bearer abc.DEF-123_xyz', 'abc.DEF-123_xyz'],
    ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['authorization=Bearer topsecretvalue', 'topsecretvalue'],
    ['GET /x?api_key=hunter2&a=1', 'hunter2'],
    ['apiKey=hunter3', 'hunter3'],
    ['{"token":"hunter4"}', 'hunter4'],
    ['password=hunter5 next', 'hunter5'],
    ['clone https://alice:hunter6@git.example.com/r.git', 'hunter6'],
    ['clone https://hunter7@git.example.com/r.git', 'hunter7'],
  ];
  for (const [input, secret] of cases) {
    const out = redactSecrets(input);
    assert.equal(out.includes(secret), false, `${input} -> ${out}`);
  }
  assert.equal(redactSecrets('inputTokens=12 tokens=5 plain'), 'inputTokens=12 tokens=5 plain');
  const dir = await tmp();
  try {
    const logger = createLogger({ dataDir: dir, console: false });
    logger.error('T', 'failed with sk-leakleakleak', { url: 'https://u:pw123456@h/x' }, new Error('Bearer leaked-token-value'));
    const text = read(dir);
    for (const secret of ['sk-leakleakleak', 'pw123456', 'leaked-token-value']) assert.equal(text.includes(secret), false, text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotation: size-based, keeps service.log plus .1 to .N, drops the oldest', async () => {
  const dir = await tmp();
  try {
    const logger = createLogger({ dataDir: dir, console: false, maxBytes: 400, keep: 3 });
    for (let i = 0; i < 60; i++) logger.info('T', `line-${String(i).padStart(3, '0')} ${'x'.repeat(40)}`);
    const logs = path.join(dir, 'logs');
    for (const name of ['service.log', 'service.log.1', 'service.log.2', 'service.log.3']) {
      assert.ok(existsSync(path.join(logs, name)), name);
    }
    assert.equal(existsSync(path.join(logs, 'service.log.4')), false);
    // newest lines are in service.log, older in higher numbers, and every file stays near the limit
    assert.ok(read(dir).includes('line-059'));
    assert.ok(read(dir, 'service.log.1').includes('line-0'));
    assert.ok(readFileSync(path.join(logs, 'service.log.1')).length <= 400);
    assert.equal(read(dir, 'service.log.3').includes('line-000'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotation continues from the size of an existing file', async () => {
  const dir = await tmp();
  try {
    mkdirSync(path.join(dir, 'logs'));
    writeFileSync(path.join(dir, 'logs', 'service.log'), 'o'.repeat(390));
    const logger = createLogger({ dataDir: dir, console: false, maxBytes: 400, keep: 2 });
    logger.info('T', 'fresh');
    assert.ok(read(dir, 'service.log.1').startsWith('ooo'));
    assert.ok(read(dir).includes('fresh'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing write does not throw and falls back to the console', async () => {
  const dir = await tmp();
  const blocker = path.join(dir, 'file-not-dir');
  writeFileSync(blocker, 'x');
  const seen = [];
  const origErr = console.error;
  console.error = (...args) => seen.push(args.join(' '));
  try {
    const logger = createLogger({ dataDir: path.join(blocker, 'sub'), console: false });
    assert.doesNotThrow(() => logger.error('T', 'cannot be written'));
    assert.doesNotThrow(() => logger.info('T', 'again'));
  } finally {
    console.error = origErr;
    await rm(dir, { recursive: true, force: true });
  }
  assert.ok(seen.some((l) => l.includes('cannot be written')));
});

test('console output only without a data directory (or when forced)', async () => {
  const seen = [];
  const orig = console.log;
  console.log = (...args) => seen.push(args.join(' '));
  const dir = await tmp();
  try {
    createLogger({ console: null }).info('T', 'no-dir');
    createLogger({ dataDir: dir, console: false }).info('T', 'file-only');
    createLogger({ dataDir: dir, console: true }).info('T', 'both');
  } finally {
    console.log = orig;
  }
  assert.ok(seen.some((l) => l.includes('no-dir')));
  assert.equal(seen.some((l) => l.includes('file-only')), false);
  assert.ok(seen.some((l) => l.includes('both')));
  assert.ok(read(dir).includes('both'));
  await rm(dir, { recursive: true, force: true });
});

test('lineLog / logLine split a legacy "WEFT_TAG text" string', async () => {
  const dir = await tmp();
  try {
    const logger = createLogger({ dataDir: dir, console: false });
    logLine('info', 'WEFT_DB renamed a -> b', logger);
    logLine('warn', 'no tag here', logger);
    const text = read(dir);
    assert.match(text, /INFO {2}\[WEFT_DB\] renamed a -> b/);
    assert.match(text, /WARN {2}\[WEFT\] no tag here/);
    assert.equal(typeof lineLog.log, 'function');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function withHttp(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HTTP: 5xx is error, slow is warn, query string and body are not logged, fast 2xx is silent', async () => {
  const dir = await tmp();
  try {
    const logger = createLogger({ dataDir: dir, console: false });
    await withHttp((req, res) => {
      trackHttp(req, res, { logger, slowMs: 40 });
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/boom') { res.writeHead(500); res.end('secret body'); return; }
      if (url.pathname === '/slow') { setTimeout(() => { res.writeHead(200); res.end('ok'); }, 80); return; }
      if (url.pathname === '/missing') { res.writeHead(404); res.end(); return; }
      res.writeHead(200); res.end('ok');
    }, async (port) => {
      const base = `http://127.0.0.1:${port}`;
      for (const p of ['/boom?token=abc123', '/slow?q=1', '/missing', '/fast']) await (await fetch(base + p)).text();
    });
    const text = read(dir);
    assert.match(text, /ERROR \[WEFT_HTTP\] method=GET path=\/boom status=500 ms=\d+ server error/);
    assert.match(text, /WARN {2}\[WEFT_HTTP\] method=GET path=\/slow status=200 ms=\d+ slow request/);
    assert.equal(text.includes('abc123'), false);
    assert.equal(text.includes('q=1'), false);
    assert.equal(text.includes('secret body'), false);
    assert.equal(text.includes('/missing'), false);
    assert.equal(text.includes('/fast'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('uncaught exception: logged with stack, process still exits non-zero', async () => {
  const dir = await tmp();
  try {
    const script = `
      import { log, installProcessHandlers } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/core/log.mjs')).href)};
      log.configure({ dataDir: ${JSON.stringify(dir)}, console: false });
      installProcessHandlers();
      setTimeout(() => { throw new Error('kaboom'); }, 5);
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const out = `status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`;
    assert.notEqual(r.status, 0, out);
    assert.ok(existsSync(path.join(dir, 'logs', 'service.log')), out);
    const text = read(dir);
    assert.match(text, /ERROR \[WEFT_FATAL\] origin=uncaughtException uncaught exception/);
    assert.match(text, /Error: kaboom/);
    assert.match(text, /\n {8}at /);

    const dir2 = await tmp();
    const script2 = script.replace(JSON.stringify(dir), JSON.stringify(dir2)).replace("throw new Error('kaboom')", "Promise.reject(new Error('nobody-caught'))");
    const r2 = spawnSync(process.execPath, ['--input-type=module', '-e', script2], { encoding: 'utf8' });
    const out2 = `status=${r2.status}\nstdout=${r2.stdout}\nstderr=${r2.stderr}`;
    assert.notEqual(r2.status, 0, out2);
    assert.ok(existsSync(path.join(dir2, 'logs', 'service.log')), out2);
    const text2 = read(dir2);
    assert.match(text2, /origin=unhandledRejection unhandled rejection/);
    assert.match(text2, /Error: nobody-caught/);
    await rm(dir2, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP: a long SSE response is not a slow request, but an SSE 5xx is still an error', async () => {
  const dir = await tmp();
  try {
    const logger = createLogger({ dataDir: dir, console: false });
    await withHttp((req, res) => {
      trackHttp(req, res, { logger, slowMs: 20 });
      const status = req.url.startsWith('/bad') ? 500 : 200;
      res.writeHead(status, { 'content-type': 'text/event-stream' });
      setTimeout(() => res.end(), 60);
    }, async (port) => {
      const base = `http://127.0.0.1:${port}`;
      for (const p of ['/events', '/bad-events']) await (await fetch(base + p)).text();
    });
    const text = read(dir);
    assert.equal(text.includes('path=/events'), false);
    assert.match(text, /ERROR \[WEFT_HTTP\] method=GET path=\/bad-events status=500/);
    assert.equal(/slow request/.test(text), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
