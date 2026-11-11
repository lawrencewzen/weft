// Main-agent and sub-agent system prompt sections.
// Pi Durable renders each section as <key>…</key> ({ tag: false } stays bare),
// appends the conversation's instructions last when that field is set, and
// resends a section only when its text changes. The main agent clears
// instructions, so that section is omitted. A sub-agent still sets its fixed text.
//
// Environment (verified against Harness.buildEnv and openConversationKernel):
// a conversation with no agent cwd gets input.env === undefined. The host env
// factory returns undefined when cwd is missing; it does not fall back to
// process.cwd(). A chat that has not selected a project still has a cwd, but
// that cwd is the service directory <dataDir>/chats/<id>, not a project.
// Neither case contributes a working-directory line or project_context.
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { section } from '@earendil-works/pi-durable';
import { decodeWorkspaceBytes } from './workspace-text.mjs';
import { log } from '../core/log.mjs';

export const PREAMBLE_TEXT = 'You are a coding assistant running inside Weft. Help users inspect files, run commands, and modify code.';
export const RULES_TEXT = [
  '- Be concise in your responses',
  '- Show file paths clearly when working with files',
].join('\n');

export const AGENTS_FILE = 'AGENTS.md';
/** Prompt cap. The file is cut on a UTF-8 boundary at or below this many bytes. */
export const AGENTS_BYTE_LIMIT = 32 * 1024;
export const AGENTS_TRUNCATION_LINE = '[AGENTS.md truncated at 32KB]';

const PLATFORM_LABEL = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

function cwdString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isInside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function existingRealpath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return '';
  }
}

/** True when `cwd` is the no-project chat directory under the data dir. */
export function isChatServiceCwd(cwd, dataDir) {
  const text = cwdString(cwd);
  if (!text || !dataDir) return false;
  const root = path.resolve(dataDir, 'chats');
  const realRoot = existingRealpath(root) || root;
  const resolved = path.resolve(text);
  const real = existingRealpath(resolved) || resolved;
  return isInside(root, resolved) || isInside(root, real) || isInside(realRoot, resolved) || isInside(realRoot, real);
}

/**
 * Project workspace for this request.
 * No agent cwd: do not use input.env.cwd (it is absent; never substitute the
 * server process directory). Chat service directories are not projects.
 * Otherwise prefer input.env.cwd, which is the workspace realpath the tools use.
 */
export function projectCwd(input, { dataDir } = {}) {
  const agentCwd = cwdString(input?.agent?.cwd);
  if (!agentCwd || isChatServiceCwd(agentCwd, dataDir)) return '';
  const envCwd = cwdString(input?.env?.cwd);
  if (!envCwd || isChatServiceCwd(envCwd, dataDir)) return agentCwd;
  return envCwd;
}

/** Main agent keeps delegate / subagent. Children have neither. */
export function isMainAgent(agent) {
  const names = new Set((agent?.tools || []).map((tool) => tool?.name).filter(Boolean));
  return names.has('delegate') || names.has('subagent');
}

export function platformLabel(platform = process.platform) {
  return PLATFORM_LABEL[platform] || platform;
}

/** Shell line from the tools actually offered. Omitted when neither is present. */
export function shellLine(tools) {
  const names = new Set((tools || []).map((tool) => tool?.name).filter(Boolean));
  if (names.has('bash')) return 'Shell: bash (use the bash tool)';
  if (names.has('powershell')) return 'Shell: PowerShell (use the powershell tool)';
  return '';
}

export function environmentText(input, { dataDir } = {}) {
  const lines = [];
  const cwd = projectCwd(input, { dataDir });
  if (cwd) lines.push(`Working directory: ${cwd}`);
  lines.push(`Platform: ${platformLabel()}`);
  const shell = shellLine(input?.agent?.tools);
  if (shell) lines.push(shell);
  return lines.join('\n');
}

function utf8SequenceLength(lead) {
  if ((lead & 0x80) === 0) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

/**
 * Longest prefix of at most `limit` bytes that does not split a UTF-8 character.
 * `bytes` may extend past `limit`; the byte at `limit` decides whether a
 * character straddles the cut.
 */
export function clipUtf8Bytes(bytes, limit = AGENTS_BYTE_LIMIT) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buf.length <= limit) return buf;
  let start = limit;
  while (start > 0 && start > limit - 4 && (buf[start] & 0xc0) === 0x80) start -= 1;
  if (start === limit) return buf.subarray(0, limit);
  const need = utf8SequenceLength(buf[start]);
  if (start + need > limit) return buf.subarray(0, start);
  return buf.subarray(0, start + need);
}

/** project_context inner text. Empty source omits the section (returns undefined). */
export function renderAgentsBody(bytes, truncated) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const clipped = truncated ? clipUtf8Bytes(buf, AGENTS_BYTE_LIMIT) : buf;
  const text = decodeWorkspaceBytes(clipped);
  if (!truncated && text.trim() === '') return undefined;
  const body = truncated
    ? `${text.endsWith('\n') ? text : `${text}\n`}${AGENTS_TRUNCATION_LINE}\n`
    : (text.endsWith('\n') ? text : `${text}\n`);
  return `<project_instructions path="${AGENTS_FILE}">\n${body}</project_instructions>`;
}

/** A refused path is not a missing file: say so instead of dropping the section silently. */
function noteRefused(result) {
  const message = String(result?.error?.message ?? '');
  if (message.includes('E_SENSITIVE')) log.error('WEFT_KERNEL_AGENT', `AGENTS.md not loaded: ${message}`);
}

async function loadAgentsBytes(env, context) {
  const info = await env.fileInfo(AGENTS_FILE, context);
  if (!info?.ok) {
    noteRefused(info);
    return null;
  }
  if (info.value.kind === 'directory') return null;
  const size = Number(info.value.size) || 0;
  if (size === 0) return { bytes: Buffer.alloc(0), truncated: false };
  if (info.value.kind === 'file' && size > AGENTS_BYTE_LIMIT && typeof env.openBinaryReader === 'function') {
    const opened = await env.openBinaryReader(AGENTS_FILE, undefined, context);
    if (!opened?.ok) return null;
    try {
      const read = await opened.value.read(0, AGENTS_BYTE_LIMIT + 4, context);
      if (!read?.ok) return null;
      return { bytes: Buffer.from(read.value), truncated: true };
    } finally {
      await opened.value.close(context).catch(() => {});
    }
  }
  if (typeof env.readBinaryFile !== 'function') return null;
  const read = await env.readBinaryFile(AGENTS_FILE, context);
  if (!read?.ok) {
    noteRefused(read);
    return null;
  }
  const bytes = Buffer.from(read.value);
  return { bytes, truncated: bytes.length > AGENTS_BYTE_LIMIT };
}

async function projectContext(input, context, options) {
  try {
    if (!projectCwd(input, options)) return undefined;
    const env = input?.env;
    if (!env || typeof env.fileInfo !== 'function') return undefined;
    const loaded = await loadAgentsBytes(env, context);
    if (!loaded) return undefined;
    return renderAgentsBody(loaded.bytes, loaded.truncated);
  } catch (err) {
    log.error('WEFT_KERNEL_AGENT', '', err);
    return undefined;
  }
}

/** preamble, rules, environment, project_context. skills stays last in the extension. */
export function systemPromptSections({ dataDir } = {}) {
  return [
    section('preamble', (input) => (isMainAgent(input?.agent) ? PREAMBLE_TEXT : undefined), { tag: false }),
    section('rules', (input) => (isMainAgent(input?.agent) ? RULES_TEXT : undefined)),
    section('environment', (input) => environmentText(input, { dataDir })),
    section('project_context', (input, context) => projectContext(input, context, { dataDir })),
  ];
}
