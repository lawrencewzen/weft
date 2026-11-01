#!/usr/bin/env node
// Spawn a program without a shell and transcode stdout/stderr to UTF-8.
// Byte conversion only: no scheduling, retry, or checkpoints.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLineTranscoder } from './output-transcode.mjs';

const TASKKILL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

function attachTranscoder(readable, writable) {
  if (!readable) {
    return { end() {} };
  }
  const tx = createLineTranscoder({
    write(buf) {
      if (writable.write(buf)) return;
      readable.pause();
      writable.once('drain', () => readable.resume());
    },
  });
  readable.on('data', (chunk) => tx.push(chunk));
  readable.on('end', () => tx.end());
  readable.on('error', () => tx.end());
  return tx;
}

function stopProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn(TASKKILL, ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      killer.unref();
      killer.once('error', () => {});
    } catch { /* ignore */ }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/**
 * Spawn `program` with `args` (no shell). stdout/stderr are transcoded onto
 * this process's stdout/stderr. Exit code is returned via `onExit`.
 *
 * @param {string} program
 * @param {readonly string[]} args
 * @param {{ onExit?: (code: number) => void }} [options]
 */
export function runWrapped(program, args, options = {}) {
  const onExit = options.onExit ?? ((code) => process.exit(code));
  let child;
  try {
    child = spawn(program, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    onExit(1);
    return { child: null, stop() {} };
  }

  const stdoutTx = attachTranscoder(child.stdout, process.stdout);
  const stderrTx = attachTranscoder(child.stderr, process.stderr);

  let stopped = false;
  let settled = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopProcessTree(child.pid);
  };

  const finish = (code) => {
    if (settled) return;
    settled = true;
    stdoutTx.end();
    stderrTx.end();
    onExit(code);
  };

  child.once('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    finish(1);
  });
  child.once('close', (code, signal) => {
    finish(code ?? (signal ? 1 : 0));
  });

  const parentPid = process.ppid;
  const parentPoll = setInterval(() => {
    if (stopped || settled) return;
    try {
      process.kill(parentPid, 0);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') return;
      stop();
    }
  }, 500);
  parentPoll.unref?.();

  const onSignal = () => stop();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('disconnect', onSignal);

  return { child, stop };
}

export function main(argv = process.argv.slice(2)) {
  const [program, ...args] = argv;
  if (!program) {
    process.stderr.write('usage: node pwsh-utf8-wrapper.mjs <program> <args...>\n');
    process.exit(2);
  }
  runWrapped(program, args);
}

if (isMain()) main();
