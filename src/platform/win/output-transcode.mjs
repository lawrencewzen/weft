// Stream command output: UTF-8 lines pass through, GBK lines become UTF-8.
// Used by pwsh-utf8-wrapper.mjs so pi-durable's UTF-8 decoder never sees GBK.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IDLE_FLUSH_MS = 200;
export const PWSH_UTF8_WRAPPER = fileURLToPath(new URL('./pwsh-utf8-wrapper.mjs', import.meta.url));

const POWERSHELL_NAMES = new Set(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe']);

const utf8Fatal = () => new TextDecoder('utf-8', { fatal: true });
const gbkDecoder = () => new TextDecoder('gbk');

/** win32 always; elsewhere only when WEFT_PWSH_OUTPUT_TRANSCODE=1. */
export function isPwshOutputTranscodeEnabled(platform = process.platform, env = process.env) {
  if (platform === 'win32') return true;
  return String(env?.WEFT_PWSH_OUTPUT_TRANSCODE ?? '').trim() === '1';
}

export function isPowerShellProgram(program) {
  const normalized = String(program || '').replace(/\\/g, '/');
  return POWERSHELL_NAMES.has(path.posix.basename(normalized).toLowerCase());
}

export function isPwshUtf8WrapperPath(filePath) {
  return path.basename(String(filePath || '')).toLowerCase() === 'pwsh-utf8-wrapper.mjs';
}

function programExists(program, env = process.env, platform = process.platform) {
  const raw = String(program || '');
  if (!raw) return false;
  if (path.isAbsolute(raw) || raw.includes('/') || raw.includes('\\')) {
    try { return existsSync(raw); } catch { return false; }
  }
  const sep = platform === 'win32' ? ';' : path.delimiter;
  const pathEnv = String(env?.Path ?? env?.PATH ?? '');
  const exts = platform === 'win32'
    ? String(env?.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((part) => part.trim()).filter(Boolean)
    : [''];
  const lower = raw.toLowerCase();
  const hasExt = platform === 'win32' && exts.some((ext) => lower.endsWith(ext.toLowerCase()));
  const names = hasExt || platform !== 'win32'
    ? [raw]
    : [raw, ...exts.map((ext) => `${raw}${ext.startsWith('.') ? ext : `.${ext}`}`)];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        if (existsSync(path.join(dir, name))) return true;
      } catch { /* unreadable PATH entry */ }
    }
  }
  return false;
}

function alreadyWrapped(argv, execPath) {
  if (argv.length < 2) return false;
  if (isPwshUtf8WrapperPath(argv[0])) return true;
  return argv[0] === execPath && isPwshUtf8WrapperPath(argv[1]);
}

/**
 * Rewrite `[pwsh|powershell, ...]` to `[node, wrapper, pwsh|powershell, ...]`.
 * Bare names that are not on PATH stay unwrapped so pi-durable can still
 * treat a missing program as spawn_error and try the next one.
 *
 * @param {string | readonly string[]} command
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, execPath?: string }} [options]
 * @returns {string | readonly string[]}
 */
export function wrapPwshCommand(command, options = {}) {
  if (typeof command === 'string' || !Array.isArray(command)) return command;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  if (!isPwshOutputTranscodeEnabled(platform, env)) return command;
  if (command.length === 0) return command;
  if (alreadyWrapped(command, execPath)) return command;
  if (!isPowerShellProgram(command[0])) return command;
  if (!programExists(command[0], env, platform)) return command;
  return [execPath, PWSH_UTF8_WRAPPER, ...command];
}

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Buffer.from(bytes ?? []);
}

function utf8SequenceLength(byte) {
  if (byte <= 0x7f) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
}

/** Trailing bytes that are an incomplete UTF-8 sequence. */
export function utf8IncompleteTailLength(bytes) {
  const buf = asBuffer(bytes);
  if (buf.length === 0) return 0;
  const last = buf[buf.length - 1];
  if (last <= 0x7f) return 0;
  let cont = 0;
  let i = buf.length - 1;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80 && cont < 3) {
    cont += 1;
    i -= 1;
  }
  if (i < 0) return buf.length;
  const expected = utf8SequenceLength(buf[i]);
  const have = 1 + cont;
  if (expected <= 1) return 0;
  return have < expected ? have : 0;
}

/** 1 if `bytes` ends on a GBK lead with no trail; else 0. Scans from the start. */
export function gbkIncompleteTailLength(bytes) {
  const buf = asBuffer(bytes);
  let i = 0;
  while (i < buf.length) {
    const lead = buf[i];
    if (lead <= 0x7f || lead === 0x80 || lead === 0xff) {
      i += 1;
      continue;
    }
    if (lead >= 0x81 && lead <= 0xfe) {
      if (i + 1 >= buf.length) return 1;
      const trail = buf[i + 1];
      if (trail >= 0x40 && trail <= 0xfe && trail !== 0x7f) i += 2;
      else i += 1;
      continue;
    }
    i += 1;
  }
  return 0;
}

export function isStrictUtf8(bytes) {
  try {
    utf8Fatal().decode(asBuffer(bytes));
    return true;
  } catch {
    return false;
  }
}

/** One complete line (including `\\n` / `\\r\\n`) or a flushed tail: UTF-8 bytes in, UTF-8 bytes out. */
export function transcodeLine(bytes) {
  const buf = asBuffer(bytes);
  if (buf.length === 0) return buf;
  if (isStrictUtf8(buf)) return Buffer.from(buf);
  const text = gbkDecoder().decode(buf);
  return Buffer.from(text, 'utf8');
}

function splitIdleTail(buf) {
  if (buf.length === 0) return { emit: buf, hold: buf };
  if (isStrictUtf8(buf)) return { emit: buf, hold: Buffer.alloc(0) };
  const utf8Hold = utf8IncompleteTailLength(buf);
  if (utf8Hold === buf.length) return { emit: Buffer.alloc(0), hold: buf };
  if (utf8Hold > 0) {
    const prefix = buf.subarray(0, buf.length - utf8Hold);
    if (isStrictUtf8(prefix)) {
      return { emit: prefix, hold: buf.subarray(buf.length - utf8Hold) };
    }
  }
  const gbkHold = gbkIncompleteTailLength(buf);
  if (gbkHold === buf.length) return { emit: Buffer.alloc(0), hold: buf };
  if (gbkHold > 0) {
    return {
      emit: buf.subarray(0, buf.length - gbkHold),
      hold: buf.subarray(buf.length - gbkHold),
    };
  }
  return { emit: buf, hold: Buffer.alloc(0) };
}

/**
 * Byte-stream line transcoder. Splits on `\\n` (keeps `\\r\\n`). A tail without a
 * newline is flushed on `end()` or after `idleMs` of silence, holding back an
 * incomplete UTF-8 / GBK character until the next chunk.
 *
 * @param {{ write?: (bytes: Buffer) => void, idleMs?: number }} [options]
 */
export function createLineTranscoder(options = {}) {
  const write = options.write ?? (() => {});
  const idleMs = options.idleMs ?? IDLE_FLUSH_MS;
  let buf = Buffer.alloc(0);
  let idleTimer = null;
  let ended = false;

  function clearIdle() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function emit(bytes) {
    if (bytes.length === 0) return;
    write(bytes);
  }

  function processCompleteLines() {
    while (true) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) break;
      const line = buf.subarray(0, nl + 1);
      buf = buf.subarray(nl + 1);
      emit(transcodeLine(line));
    }
  }

  function flushTail({ end = false } = {}) {
    if (buf.length === 0) return;
    if (end) {
      emit(transcodeLine(buf));
      buf = Buffer.alloc(0);
      return;
    }
    const { emit: ready, hold } = splitIdleTail(buf);
    buf = hold;
    emit(transcodeLine(ready));
  }

  function armIdle() {
    if (ended || buf.length === 0 || idleMs < 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (ended || buf.length === 0) return;
      flushTail({ end: false });
    }, idleMs);
    idleTimer.unref?.();
  }

  return {
    push(chunk) {
      if (ended) return;
      const next = asBuffer(chunk);
      if (next.length === 0) return;
      buf = buf.length === 0 ? Buffer.from(next) : Buffer.concat([buf, next]);
      processCompleteLines();
      clearIdle();
      if (buf.length > 0) armIdle();
    },
    end() {
      if (ended) return;
      ended = true;
      clearIdle();
      processCompleteLines();
      flushTail({ end: true });
    },
  };
}

/** Decode a whole buffer the same way the stream would (one push + end). */
export function transcodeBuffer(bytes) {
  const chunks = [];
  const tx = createLineTranscoder({
    write(out) { chunks.push(out); },
    idleMs: -1,
  });
  tx.push(bytes);
  tx.end();
  return Buffer.concat(chunks);
}
