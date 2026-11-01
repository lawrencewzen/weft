import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import iconv from 'iconv-lite';
import {
  IDLE_FLUSH_MS,
  PWSH_UTF8_WRAPPER,
  createLineTranscoder,
  gbkIncompleteTailLength,
  isPowerShellProgram,
  isPwshOutputTranscodeEnabled,
  transcodeBuffer,
  transcodeLine,
  utf8IncompleteTailLength,
  wrapPwshCommand,
} from '../../src/platform/win/output-transcode.mjs';

const ZH = '中文输出测试';
const GBK_ZH = iconv.encode(`${ZH}\n`, 'gbk');
const UTF8_ZH = Buffer.from(`${ZH}\n`, 'utf8');
const UTF8_GIT = Buffer.from('初始提交\n', 'utf8');
const GBK_DIR = iconv.encode('你好.txt\n', 'gbk');

function collect(idleMs = -1) {
  const chunks = [];
  const tx = createLineTranscoder({
    write(buf) { chunks.push(Buffer.from(buf)); },
    idleMs,
  });
  return {
    tx,
    out: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

test('isPwshOutputTranscodeEnabled is win32 or WEFT_PWSH_OUTPUT_TRANSCODE', () => {
  assert.equal(isPwshOutputTranscodeEnabled('win32', {}), true);
  assert.equal(isPwshOutputTranscodeEnabled('linux', {}), false);
  assert.equal(isPwshOutputTranscodeEnabled('linux', { WEFT_PWSH_OUTPUT_TRANSCODE: '1' }), true);
  assert.equal(isPwshOutputTranscodeEnabled('darwin', { WEFT_PWSH_OUTPUT_TRANSCODE: '0' }), false);
  assert.equal(isPowerShellProgram('pwsh'), true);
  assert.equal(isPowerShellProgram('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), true);
  assert.equal(isPowerShellProgram('/usr/bin/powershell'), true);
  assert.equal(isPowerShellProgram('bash'), false);
  assert.equal(isPowerShellProgram('git'), false);
});

test('wrapPwshCommand rewrites pwsh on PATH and leaves other argv alone', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-wrap-pwsh-'));
  try {
    await writeFile(path.join(dir, 'pwsh'), '');
    const env = { PATH: dir, WEFT_PWSH_OUTPUT_TRANSCODE: '1' };
    const wrapped = wrapPwshCommand(['pwsh', '-NoProfile', '-Command', 'hi'], {
      env,
      platform: 'linux',
      execPath: '/usr/bin/node',
    });
    assert.deepEqual(wrapped, ['/usr/bin/node', PWSH_UTF8_WRAPPER, 'pwsh', '-NoProfile', '-Command', 'hi']);
    assert.deepEqual(
      wrapPwshCommand(wrapped, { env, platform: 'linux', execPath: '/usr/bin/node' }),
      wrapped,
    );
    assert.deepEqual(
      wrapPwshCommand(['git', 'status'], { env, platform: 'linux', execPath: '/usr/bin/node' }),
      ['git', 'status'],
    );
    assert.equal(
      wrapPwshCommand('pwsh -Command hi', { env, platform: 'linux', execPath: '/usr/bin/node' }),
      'pwsh -Command hi',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wrapPwshCommand does not wrap a missing pwsh (spawn_error fallback)', () => {
  const env = { PATH: '/no-such-weft-pwsh-dir', WEFT_PWSH_OUTPUT_TRANSCODE: '1' };
  assert.deepEqual(
    wrapPwshCommand(['pwsh', '-Command', 'hi'], { env, platform: 'linux', execPath: '/usr/bin/node' }),
    ['pwsh', '-Command', 'hi'],
  );
  assert.deepEqual(
    wrapPwshCommand(['pwsh', '-Command', 'hi'], { env: {}, platform: 'linux' }),
    ['pwsh', '-Command', 'hi'],
  );
});

test('transcodeLine keeps strict UTF-8 bytes and re-encodes GBK', () => {
  assert.deepEqual(transcodeLine(UTF8_ZH), UTF8_ZH);
  assert.deepEqual(transcodeLine(GBK_ZH), UTF8_ZH);
  assert.equal(transcodeLine(GBK_ZH).includes(0xef) || transcodeLine(GBK_ZH).toString('utf8') === `${ZH}\n`, true);
  assert.equal(transcodeLine(GBK_ZH).toString('utf8'), `${ZH}\n`);
  assert.equal(transcodeLine(GBK_ZH).includes(0xff), false);
});

test('transcodeBuffer: pure UTF-8, pure GBK, mixed lines, CRLF', () => {
  const mixed = Buffer.concat([GBK_ZH, UTF8_GIT, GBK_DIR, Buffer.from('ok\r\n', 'utf8')]);
  const out = transcodeBuffer(mixed);
  assert.equal(out.toString('utf8'), `${ZH}\n初始提交\n你好.txt\nok\r\n`);
  assert.equal(out.includes(0xef) && out.toString('utf8').includes('\uFFFD'), false);
  assert.equal(out.toString('utf8').includes('\uFFFD'), false);
  assert.deepEqual(transcodeBuffer(Buffer.from('only-ascii\n', 'utf8')).toString('utf8'), 'only-ascii\n');
  const crlfGbk = iconv.encode(`${ZH}\r\n`, 'gbk');
  assert.equal(transcodeBuffer(crlfGbk).toString('utf8'), `${ZH}\r\n`);
  assert.deepEqual(transcodeBuffer(Buffer.from(`${ZH}\r\n`, 'utf8')).toString('utf8'), `${ZH}\r\n`);
});

test('transcoder splits on newline across chunks and holds incomplete UTF-8 / GBK bytes', () => {
  const { tx, text } = collect(-1);
  tx.push(UTF8_ZH.subarray(0, 2));
  assert.equal(text(), '');
  tx.push(UTF8_ZH.subarray(2));
  assert.equal(text(), `${ZH}\n`);

  const g = collect(-1);
  g.tx.push(GBK_ZH.subarray(0, 1));
  assert.equal(g.text(), '');
  g.tx.push(GBK_ZH.subarray(1));
  assert.equal(g.text(), `${ZH}\n`);
  assert.equal(utf8IncompleteTailLength(UTF8_ZH.subarray(0, 2)) > 0, true);
  assert.equal(gbkIncompleteTailLength(GBK_ZH.subarray(0, 1)), 1);
});

test('transcoder flushes a no-newline tail on end() and after idle', async () => {
  const ended = collect(-1);
  ended.tx.push(iconv.encode(ZH, 'gbk'));
  assert.equal(ended.text(), '');
  ended.tx.end();
  assert.equal(ended.text(), ZH);

  const idle = collect(IDLE_FLUSH_MS);
  idle.tx.push(Buffer.from(ZH, 'utf8'));
  assert.equal(idle.text(), '');
  await new Promise((resolve) => setTimeout(resolve, IDLE_FLUSH_MS + 50));
  assert.equal(idle.text(), ZH);

  const held = collect(IDLE_FLUSH_MS);
  held.tx.push(GBK_ZH.subarray(0, 1));
  await new Promise((resolve) => setTimeout(resolve, IDLE_FLUSH_MS + 50));
  assert.equal(held.text(), '');
  held.tx.push(GBK_ZH.subarray(1));
  assert.equal(held.text(), `${ZH}\n`);
});
