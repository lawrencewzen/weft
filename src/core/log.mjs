// Server log. One line per record:
//   2026-11-10 14:03:22.517 ERROR [WEFT_TAG] key=value ... message
// Local time. Errors add their stack on indented lines. Every line is redacted before it is
// written. In service mode the lines go to <dataDir>/logs/service.log, rotated by size; during
// development (TTY, or no data directory) they also go to the console. A log write never throws.
//
// Never pass conversation text, prompts, or tool arguments/output to this module.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact.mjs';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const KEEP_LOG_FILES = 5;
export const LOG_FILE = 'service.log';
export const STDIO_LOG_FILE = 'service-stdio.log';

export function parseLevel(value, fallback = 'info') {
  const key = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(LEVELS, key) ? key : fallback;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

export function formatTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function fieldValue(value) {
  if (value == null) return '-';
  const text = typeof value === 'string' ? value : String(value);
  return /[\s"=]/.test(text) || text === '' ? JSON.stringify(text) : text;
}

function oneLine(text) {
  return String(text).replace(/\r?\n/g, ' ');
}

function indent(text) {
  return String(text).split(/\r?\n/).map((l) => `    ${l}`).join('\n');
}

function errorBlock(err) {
  if (err instanceof Error) {
    const stack = typeof err.stack === 'string' && err.stack ? err.stack : `${err.name}: ${err.message}`;
    const cause = err.cause instanceof Error ? `\nCaused by: ${err.cause.stack || err.cause.message}` : '';
    return indent(stack + cause);
  }
  return null;
}

/** Build the full text of one record (without the trailing newline). Not yet redacted. */
export function formatLine(level, tag, message, extras, date = new Date()) {
  const fields = [];
  const blocks = [];
  let text = message == null ? '' : message;
  if (text instanceof Error) {
    blocks.push(errorBlock(text));
    text = text.message;
  }
  for (const extra of extras) {
    if (extra == null) continue;
    if (extra instanceof Error) {
      blocks.push(errorBlock(extra));
    } else if (typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) continue;
        fields.push(`${k}=${fieldValue(v instanceof Error ? v.message : v)}`);
      }
    } else {
      // a thrown non-Error value
      blocks.push(indent(String(extra)));
    }
  }
  if (text === '' && extras.some((e) => e instanceof Error)) text = extras.find((e) => e instanceof Error).message;
  const head = [formatTime(date), level.toUpperCase().padEnd(5), `[${tag}]`];
  if (fields.length) head.push(fields.join(' '));
  const first = oneLine(text);
  let line = head.join(' ');
  if (first) line += ` ${first}`;
  const multi = String(text).includes('\n') ? `\n${indent(String(text).split(/\r?\n/).slice(1).join('\n'))}` : '';
  return line + multi + blocks.map((b) => `\n${b}`).join('');
}

/** service.log -> .1 -> .2 ... -> .<keep>; the oldest one is dropped. */
export function rotateFiles(file, keep) {
  try { rmSync(`${file}.${keep}`, { force: true }); } catch { /* ignore */ }
  for (let i = keep - 1; i >= 1; i--) {
    try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* missing is fine */ }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
  }
}

export function createLogger(options = {}) {
  let level = parseLevel(options.level ?? process.env.WEFT_LOG_LEVEL);
  let dataDir = options.dataDir || null;
  let maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  let keep = options.keep ?? KEEP_LOG_FILES;
  let consoleOut = options.console ?? null;
  let file = null;
  let size = 0;
  let dirReady = false;
  const clock = options.now ?? (() => new Date());

  function shouldConsole() {
    if (consoleOut != null) return consoleOut;
    return !file || Boolean(process.stdout.isTTY) || process.env.WEFT_LOG_CONSOLE === '1';
  }

  function openFile() {
    file = dataDir ? path.join(dataDir, 'logs', LOG_FILE) : null;
    dirReady = false;
    size = 0;
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      dirReady = true;
      size = statSync(file).size;
    } catch { /* new file, or unwritable: write() handles it */ }
  }
  openFile();

  function toConsole(lvl, line) {
    try {
      if (lvl === 'debug' || lvl === 'info') console.log(line);
      else console.error(line);
    } catch { /* ignore */ }
  }

  function writeFile(text) {
    const data = `${text}\n`;
    const bytes = Buffer.byteLength(data);
    if (!dirReady) {
      mkdirSync(path.dirname(file), { recursive: true });
      dirReady = true;
    }
    if (size > 0 && size + bytes > maxBytes) {
      rotateFiles(file, keep);
      size = 0;
    }
    appendFileSync(file, data);
    size += bytes;
  }

  function emit(lvl, tag, message, extras) {
    if (LEVELS[lvl] < LEVELS[level]) return;
    let line;
    try {
      line = redactSecrets(formatLine(lvl, String(tag || 'WEFT'), message, extras, clock()));
    } catch {
      return;
    }
    let wrote = false;
    if (file) {
      try {
        writeFile(line);
        wrote = true;
      } catch {
        dirReady = false;
      }
    }
    if (!wrote || shouldConsole()) toConsole(lvl, line);
  }

  const logger = {
    debug: (tag, message, ...extras) => emit('debug', tag, message, extras),
    info: (tag, message, ...extras) => emit('info', tag, message, extras),
    warn: (tag, message, ...extras) => emit('warn', tag, message, extras),
    error: (tag, message, ...extras) => emit('error', tag, message, extras),
    /** Point the logger at a data directory (service mode) and/or change its settings. */
    configure(next = {}) {
      if (next.level !== undefined) level = parseLevel(next.level, level);
      if (next.maxBytes !== undefined) maxBytes = next.maxBytes;
      if (next.keep !== undefined) keep = next.keep;
      if (next.console !== undefined) consoleOut = next.console;
      if (next.dataDir !== undefined) {
        dataDir = next.dataDir || null;
        openFile();
      }
      return logger;
    },
    get level() { return level; },
    get file() { return file; },
  };
  return logger;
}

/** The process-wide logger. server.mjs points it at the data directory on start. */
export const log = createLogger();

let handlersInstalled = false;

/**
 * Record uncaught exceptions and unhandled rejections with their stack. This uses the
 * monitor event, which does not change what Node does next: an uncaught error still exits
 * the process, and an unhandled rejection is still raised as an uncaught exception.
 */
export function installProcessHandlers(logger = log) {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    logger.error('WEFT_FATAL', origin === 'unhandledRejection' ? 'unhandled rejection' : 'uncaught exception', { origin }, err);
  });
}

/**
 * Log one finished HTTP request: 5xx as error, slow as warn (SSE streams are long by design and never slow), 4xx as debug.
 * The path has no query string; headers and bodies are never logged.
 */
export function trackHttp(req, res, { logger = log, slowMs = httpSlowMs() } = {}) {
  const started = Date.now();
  // writeHead(status, headers) does not populate getHeader(), so remember the type here.
  let streamType = false;
  const writeHead = res.writeHead;
  res.writeHead = function patched(...args) {
    const headers = args.find((a) => a && typeof a === 'object');
    streamType = /^text\/event-stream/i.test(contentTypeOf(headers));
    return writeHead.apply(this, args);
  };
  res.on('finish', () => {
    const ms = Date.now() - started;
    const status = res.statusCode;
    const fields = { method: req.method, path: String(req.url || '/').split('?')[0], status, ms };
    if (status >= 500) logger.error('WEFT_HTTP', 'server error', fields);
    else if (ms > slowMs && !(streamType || /^text\/event-stream/i.test(String(res.getHeader('content-type') || '')))) logger.warn('WEFT_HTTP', 'slow request', fields);
    else if (status >= 400) logger.debug('WEFT_HTTP', 'client error', fields);
  });
}

function contentTypeOf(headers) {
  if (!headers) return '';
  if (Array.isArray(headers)) {
    for (let k = 0; k + 1 < headers.length; k += 2) {
      if (String(headers[k]).toLowerCase() === 'content-type') return String(headers[k + 1]);
    }
    return '';
  }
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === 'content-type') return String(v);
  return '';
}

export function httpSlowMs() {
  const n = Number(process.env.WEFT_LOG_SLOW_MS);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

/**
 * Split a legacy "WEFT_TAG message" line into tag and message and log it at `level`.
 * For callers that take a console-like `log` option and pass one preformatted string.
 */
export function logLine(level, line, logger = log) {
  const text = String(line ?? '');
  const m = /^(WEFT_[A-Z0-9_]+)(?: ([\s\S]*))?$/.exec(text);
  logger[level](m ? m[1] : 'WEFT', m ? (m[2] ?? '') : text);
}

/** Drop-in for the `{ log = console }` options: same method names, routed to the server log. */
export const lineLog = {
  log: (line) => logLine('info', line),
  info: (line) => logLine('info', line),
  debug: (line) => logLine('debug', line),
  warn: (line) => logLine('warn', line),
  error: (line) => logLine('error', line),
};
