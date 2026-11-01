import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installUtf8Stdio, toUtf8Buffer, wrapUtf8Write } from '../../src/platform/win/stdio-utf8.mjs';

const READY = '打开新版界面';
const READY_UTF8 = Buffer.from(`${READY}\n`, 'utf8');
const ZH_GBK = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xd4, 0xbc, 0xec]); // 中文自检 in GBK
const STDIO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/platform/win/stdio-utf8.mjs');

test('toUtf8Buffer encodes Chinese as UTF-8, not GBK', () => {
  const buf = toUtf8Buffer('中文自检');
  assert.deepEqual(buf, Buffer.from('中文自检', 'utf8'));
  assert.notEqual(Buffer.compare(buf, ZH_GBK), 0);
  assert.equal(new TextDecoder('utf-8').decode(buf), '中文自检');
  assert.notEqual(new TextDecoder('gbk').decode(buf), '中文自检');
});

test('wrapUtf8Write sends UTF-8 buffers instead of JS strings', () => {
  const chunks = [];
  const stream = {
    write(chunk, encoding, cb) {
      chunks.push({ chunk, encoding });
      if (typeof cb === 'function') cb();
      return true;
    },
    setDefaultEncoding() {},
  };
  wrapUtf8Write(stream);
  stream.write('打开新版界面');
  assert.equal(Buffer.isBuffer(chunks[0].chunk), true);
  assert.deepEqual(chunks[0].chunk, Buffer.from('打开新版界面', 'utf8'));
  assert.equal(chunks[0].encoding, undefined);
  stream.write('中文自检', 'utf8');
  assert.deepEqual(chunks[1].chunk, Buffer.from('中文自检', 'utf8'));
});

test('wrapUtf8Write is idempotent', () => {
  const stream = { write() { return true; }, setDefaultEncoding() {} };
  const first = wrapUtf8Write(stream).write;
  wrapUtf8Write(stream);
  assert.equal(stream.write, first);
});

test('installUtf8Stdio wraps stdout and stderr of a fake process', () => {
  const proc = {
    stdout: { write() { return true; }, setDefaultEncoding() {} },
    stderr: { write() { return true; }, setDefaultEncoding() {} },
  };
  const outOrig = proc.stdout.write;
  installUtf8Stdio(proc);
  assert.notEqual(proc.stdout.write, outOrig);
});

test('stdout redirected to a file writes UTF-8 Chinese (service.log shape)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-utf8-log-'));
  const outFile = path.join(dir, 'service.log');
  const script = path.join(dir, 'child.mjs');
  try {
    await writeFile(script, `
      import { installUtf8Stdio } from ${JSON.stringify(pathToFileURL(STDIO_PATH).href)};
      installUtf8Stdio();
      process.stdout.write(${JSON.stringify(`${READY}\n`)});
    `);
    const fd = openSync(outFile, 'w');
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        stdio: ['ignore', fd, 'pipe'],
        windowsHide: true,
      });
      let err = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.once('error', reject);
      child.once('close', (exit) => {
        try { closeSync(fd); } catch { /* ignore */ }
        if (exit !== 0) reject(new Error(`child exit ${exit}\n${err}`));
        else resolve(exit);
      });
    });
    assert.equal(code, 0);
    const written = readFileSync(outFile);
    assert.deepEqual(written, READY_UTF8);
    assert.equal(written.length, 19); // 6 chars × 3 UTF-8 bytes + newline
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(written), `${READY}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
