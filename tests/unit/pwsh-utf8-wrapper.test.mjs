import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ok } from '@earendil-works/pi-durable/env';
import iconv from 'iconv-lite';
import { PWSH_UTF8_WRAPPER, wrapPwshCommand } from '../../src/platform/win/output-transcode.mjs';
import { WorkspaceExecutionEnv } from '../../src/kernel/workspace-env.mjs';

const ZH_GBK = '中文GBK';
const ZH_UTF8 = '中文UTF8';
const GBK_LINE = [...iconv.encode(`${ZH_GBK}\n`, 'gbk')];
const UTF8_LINE = [...Buffer.from(`${ZH_UTF8}\n`, 'utf8')];
const GBK_ERR = [...iconv.encode('错误GBK\n', 'gbk')];

function emitScript() {
  return `
    const mode = process.argv[2] || '0';
    process.stdout.write(String(process.pid) + '\\n');
    process.stdout.write(Buffer.from(${JSON.stringify(GBK_LINE)}));
    process.stdout.write(Buffer.from(${JSON.stringify(UTF8_LINE)}));
    process.stderr.write(Buffer.from(${JSON.stringify(GBK_ERR)}));
    if (mode === 'hang') {
      setInterval(() => {}, 60_000);
    } else {
      process.exit(Number(mode) || 0);
    }
  `;
}

function runWrapper(args, { timeoutMs = 15_000, killAfterMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PWSH_UTF8_WRAPPER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    let killTimer;
    if (killAfterMs != null) {
      killTimer = setTimeout(() => {
        child.kill('SIGTERM');
      }, killAfterMs);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('wrapper timed out'));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        pid: child.pid,
      });
    });
  });
}

test('wrapper transcodes mixed GBK/UTF-8 lines and forwards the exit code', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-wrap-emit-'));
  const script = path.join(dir, 'emit.mjs');
  try {
    await writeFile(script, emitScript());
    const zero = await runWrapper([process.execPath, script, '0']);
    assert.equal(zero.code, 0, zero.stderr.toString('utf8'));
    const zeroText = zero.stdout.toString('utf8');
    assert.match(zeroText, new RegExp(`\\d+\\n${ZH_GBK}\\n${ZH_UTF8}\\n`));
    assert.equal(zeroText.includes('\uFFFD'), false);
    assert.equal(zero.stderr.toString('utf8').includes('错误GBK'), true);
    assert.equal(zero.stderr.toString('utf8').includes('\uFFFD'), false);

    const seven = await runWrapper([process.execPath, script, '7']);
    assert.equal(seven.code, 7);
    assert.equal(seven.stdout.toString('utf8').includes(ZH_GBK), true);
    assert.equal(seven.stdout.toString('utf8').includes(ZH_UTF8), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wrapper stop() ends the child process', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-wrap-hang-'));
  const script = path.join(dir, 'hang.mjs');
  try {
    await writeFile(script, emitScript('hang'));
    const child = spawn(process.execPath, [PWSH_UTF8_WRAPPER, process.execPath, script, 'hang'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const grandchildPid = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('no grandchild pid')), 10_000);
      child.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        const pid = Number.parseInt(buf.subarray(0, nl).toString('utf8'), 10);
        if (!Number.isInteger(pid) || pid <= 0) return;
        clearTimeout(timer);
        resolve(pid);
      });
      child.once('error', reject);
    });
    assert.equal(typeof grandchildPid, 'number');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
    const closed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 10_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve('closed');
      });
    });
    assert.equal(closed, 'closed');
    await new Promise((resolve) => setTimeout(resolve, 200));
    let live = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      live = false;
    }
    assert.equal(live, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('WorkspaceExecutionEnv.exec wraps pwsh argv when transcode is enabled', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-env-wrap-'));
  const bin = path.join(dir, 'bin');
  const previous = process.env.WEFT_PWSH_OUTPUT_TRANSCODE;
  const previousPath = process.env.PATH;
  try {
    await mkdir(bin);
    await writeFile(path.join(bin, 'pwsh'), '');
    process.env.WEFT_PWSH_OUTPUT_TRANSCODE = '1';
    process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
    const calls = [];
    const inner = {
      id: 'fake',
      cwd: dir,
      async absolutePath(filePath) {
        return ok(path.resolve(dir, filePath));
      },
      async exec(command) {
        calls.push(command);
        return ok({ exitCode: 0 });
      },
    };
    const env = new WorkspaceExecutionEnv(inner, dir);
    await env.exec(['pwsh', '-NoProfile', '-Command', 'Write-Output x'], {}, BACKGROUND_CONTEXT);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], process.execPath);
    assert.equal(calls[0][1], PWSH_UTF8_WRAPPER);
    assert.equal(calls[0][2], 'pwsh');
    assert.deepEqual(calls[0].slice(3), ['-NoProfile', '-Command', 'Write-Output x']);

    await env.exec(['git', 'status'], {}, BACKGROUND_CONTEXT);
    assert.deepEqual(calls[1], ['git', 'status']);

    const twice = wrapPwshCommand(calls[0]);
    assert.deepEqual(twice, calls[0]);
  } finally {
    if (previous === undefined) delete process.env.WEFT_PWSH_OUTPUT_TRANSCODE;
    else process.env.WEFT_PWSH_OUTPUT_TRANSCODE = previous;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
