// Problem report: gathers on-site information into one zip, in memory. Nothing is uploaded.
// Every text goes through redactSecrets before it is written; settings use an allow-list.
import os from 'node:os';
import path from 'node:path';
import { open, readdir } from 'node:fs/promises';
import { runDoctor } from './doctor.mjs';
import { LOG_FILE, STDIO_LOG_FILE } from './log.mjs';
import { redactSecrets } from './redact.mjs';
import { createZip } from './zip.mjs';

export const LOG_BUDGET_BYTES = 20 * 1024 * 1024;
export const STDIO_TAIL_BYTES = 2 * 1024 * 1024;
export const TOOL_OUTPUT_MAX_CHARS = 20 * 1024;
export const CONVERSATION_MAX_BYTES = 20 * 1024 * 1024;
export const REPORT_MAX_BYTES = 50 * 1024 * 1024;

function pad(n) {
  return String(n).padStart(2, '0');
}

export function reportFileName(now = new Date()) {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `weft-report-${d}-${t}.zip`;
}

function stamp(now) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ---- settings (allow-list) ------------------------------------------------

/** baseUrl without userinfo, query or fragment. Unparseable values are dropped. */
export function safeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const u = new URL(value.trim());
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

function pickFlags(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [k, v] of Object.entries(map)) if (typeof v === 'boolean') out[k] = v;
  return out;
}

function pickNumbers(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) if (typeof obj[k] === 'number' && Number.isFinite(obj[k])) out[k] = obj[k];
  return out;
}

function safeProvider(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const k of ['id', 'kind', 'name', 'api']) if (typeof p[k] === 'string') out[k] = p[k];
  if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
  const baseUrl = safeBaseUrl(p.baseUrl);
  if (baseUrl) out.baseUrl = baseUrl;
  if (p.overrides && typeof p.overrides === 'object' && !Array.isArray(p.overrides)) {
    const overrides = {};
    for (const [model, o] of Object.entries(p.overrides)) {
      const picked = pickNumbers(o, ['contextWindow', 'maxTokens']);
      if (Object.keys(picked).length) overrides[model] = picked;
    }
    out.overrides = overrides;
  }
  const t = p.lastTest;
  if (t && typeof t === 'object') {
    const lastTest = {};
    if (typeof t.ok === 'boolean') lastTest.ok = t.ok;
    if (typeof t.at === 'number' || typeof t.at === 'string') lastTest.at = t.at;
    if (typeof t.code === 'string') lastTest.code = t.code;
    if (typeof t.status === 'number') lastTest.status = t.status;
    if (typeof t.error === 'string') lastTest.error = t.error.slice(0, 500);
    out.lastTest = lastTest;
  }
  return out;
}

/** Only fields known to be safe. Credentials, headers and anything unknown are left out. */
export function safeSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const out = {};
  for (const k of ['version', 'language', 'theme', 'appearance']) {
    if (typeof s[k] === 'string' || typeof s[k] === 'number') out[k] = s[k];
  }
  const dm = s.defaultModel;
  if (dm && typeof dm === 'object' && typeof dm.providerId === 'string' && typeof dm.modelId === 'string') {
    out.defaultModel = { providerId: dm.providerId, modelId: dm.modelId };
  } else {
    out.defaultModel = null;
  }
  out.compaction = pickNumbers(s.compaction, ['triggerPercent']);
  out.plugins = pickFlags(s.plugins);
  out.skills = pickFlags(s.skills);
  out.providers = (Array.isArray(s.providers) ? s.providers : []).map(safeProvider).filter(Boolean);
  out.gitConnectionCount = Array.isArray(s.gitConnections) ? s.gitConnections.length : 0;
  return out;
}

// ---- conversation ---------------------------------------------------------

const SECRET_KEY = /^(.*[_-])?(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|credentials?|cookie|set-cookie)$/i;

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... truncated ${text.length - max} characters]`;
}

/** Copy of `value` with strings clipped, secret-named string fields masked and cycles cut. */
export function trimForReport(value, maxChars = TOOL_OUTPUT_MAX_CHARS, seen = new WeakSet()) {
  if (typeof value === 'string') return clip(value, maxChars);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => trimForReport(v, maxChars, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'function' || v === undefined) continue;
    out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '***' : trimForReport(v, maxChars, seen);
  }
  return out;
}

export function conversationJson(presented, { maxBytes = CONVERSATION_MAX_BYTES } = {}) {
  const { messages, live, sends, ...meta } = presented && typeof presented === 'object' ? presented : {};
  const list = Array.isArray(messages) ? messages.map((m) => trimForReport(m)) : [];
  const head = trimForReport(meta);
  let text = JSON.stringify({ ...head, messages: list }, null, 2);
  if (Buffer.byteLength(text) > maxBytes) {
    // Keep the newest messages: the end of a conversation is what the failure usually concerns.
    let kept = list;
    while (kept.length > 1 && Buffer.byteLength(text) > maxBytes) {
      kept = kept.slice(Math.ceil(kept.length / 4));
      text = JSON.stringify({ ...head, truncatedMessages: list.length - kept.length, messages: kept }, null, 2);
    }
  }
  return redactSecrets(text);
}

// ---- logs -----------------------------------------------------------------

async function readTail(file, bytes) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    if (length) await handle.read(buf, 0, length, size - length);
    let start = 0;
    if (length < size) {
      // Cut at a line start so no partial line (or partial UTF-8 character) is left.
      const nl = buf.indexOf(0x0a);
      start = nl >= 0 ? nl + 1 : 0;
    }
    return { text: buf.subarray(start).toString('utf8'), truncated: length < size };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** service.log, service.log.1, ... newest first. */
async function listRotated(logsDir) {
  let names = [];
  try { names = await readdir(logsDir); } catch { return []; }
  const rotated = names
    .map((name) => ({ name, m: new RegExp(`^${LOG_FILE.replace('.', '\\.')}(?:\\.(\\d+))?$`).exec(name) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.name, n: x.m[1] ? Number(x.m[1]) : 0 }))
    .sort((a, b) => a.n - b.n);
  return rotated.map((x) => x.name);
}

/**
 * Entries for logs/. Newest files first within `budget` bytes; when the budget runs out the
 * oldest content is cut (a file is trimmed at its head, older files are dropped).
 */
export async function collectLogs(dataDir, { budget = LOG_BUDGET_BYTES, stdioBytes = STDIO_TAIL_BYTES } = {}) {
  const logsDir = path.join(dataDir, 'logs');
  const entries = [];
  let left = budget;
  for (const name of await listRotated(logsDir)) {
    if (left <= 0) break;
    const tail = await readTail(path.join(logsDir, name), left);
    if (!tail) continue;
    left -= Buffer.byteLength(tail.text);
    const text = tail.truncated ? `[... older lines cut to stay within the report size limit]\n${tail.text}` : tail.text;
    entries.push({ name: `logs/${name}`, data: redactSecrets(text) });
    if (tail.truncated) break;
  }
  const stdio = await readTail(path.join(logsDir, STDIO_LOG_FILE), stdioBytes);
  if (stdio) {
    const text = stdio.truncated ? `[... only the last ${stdioBytes} bytes are kept]\n${stdio.text}` : stdio.text;
    entries.push({ name: `logs/${STDIO_LOG_FILE}`, data: redactSecrets(text) });
  }
  return entries;
}

// ---- system ---------------------------------------------------------------

export function systemText({ version, commit, dataDir, startedAt, level, now = new Date() }) {
  const mem = (n) => `${Math.round(n / 1024 / 1024)} MB`;
  const lines = [
    `Weft version: ${version || 'unknown'}`,
    ...(commit ? [`git commit: ${commit}`] : []),
    `Node: ${process.version}`,
    `Platform: ${process.platform}-${process.arch}`,
    `OS: ${os.type()} ${os.release()}${typeof os.version === 'function' ? ` (${os.version()})` : ''}`,
    `Memory: total ${mem(os.totalmem())}, free ${mem(os.freemem())}, process rss ${mem(process.memoryUsage().rss)}`,
    `Data directory: ${dataDir || 'unknown'}`,
    `Uptime: ${Math.round((now.getTime() - (startedAt || now.getTime())) / 1000)} s`,
    `Log level: ${level || 'unknown'}`,
  ];
  return `${lines.join('\n')}\n`;
}

// ---- build ----------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.description
 * @param {boolean} input.includeLogs
 * @param {boolean} input.includeDoctor
 * @param {object} [input.conversation]  presented conversation (with messages)
 * @param {string} [input.conversationId]
 * @param {object} host  { version, commit, dataDir, startedAt, level, settings }
 */
export async function buildReport(input, host, now = new Date()) {
  const entries = [];
  const text = (name, data) => entries.push({ name, data: redactSecrets(data) });
  text('report.txt', `${String(input.description || '').trim() || '(no description)'}\n\nGenerated: ${stamp(now)}\nWeft version: ${host.version || 'unknown'}\n`);
  text('system.txt', systemText({ ...host, now }));
  if (input.includeDoctor) text('doctor.txt', await runDoctor({ dataDir: host.dataDir }));
  if (input.includeLogs && host.dataDir) entries.push(...await collectLogs(host.dataDir));
  entries.push({
    name: 'settings.json',
    data: redactSecrets(`${JSON.stringify(safeSettings(host.settings), null, 2)}\n`),
  });
  if (input.conversation && input.conversationId) {
    entries.push({
      name: `conversation-${input.conversationId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`,
      data: conversationJson(input.conversation),
    });
  }
  const files = entries.map((e) => e.name);
  const buffer = createZip(entries, { now });
  if (buffer.length > REPORT_MAX_BYTES) {
    const err = new Error('report too large');
    err.code = 'E_TOO_LARGE';
    throw err;
  }
  return { buffer, files, name: reportFileName(now) };
}
