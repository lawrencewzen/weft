/** Consecutive tool-call grouping, summary text, and ToolCall views. No DOM. */

import { phrase, type Lang } from '../phrases/index.ts';
import type { components } from '../contract.gen.ts';

export type ToolKind = 'read' | 'write' | 'edit' | 'ls' | 'grep' | 'bash' | 'other';
export type ToolStatusBucket = 'running' | 'failed' | 'interrupted' | 'done';
export type ToolFailureKind = 'none' | 'probe' | 'real';

export type ToolLike = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  input?: unknown;
  output?: unknown;
  path?: unknown;
  added?: unknown;
  removed?: unknown;
  code?: unknown;
};

export type ToolFocus = { mode: 'path' | 'text'; text: string };
export type ToolRowHeading = { title: string; detail: string; intent: boolean };
export type ToolHint = { text: string; failed: boolean };

type ToolCall = components['schemas']['ToolCall'];
type ToolGroupSummary = components['schemas']['ToolGroupSummary'];
type Translate = (key: string, params?: Record<string, unknown>) => string;
type JsonObject = Record<string, unknown>;

const KINDS = new Set<string>(['read', 'write', 'edit', 'ls', 'grep', 'bash']);
const COUNT_KINDS = new Set<string>(['read', 'ls', 'grep', 'other']);
const CHANGE_KINDS = new Set<string>(['write', 'edit']);
const PROBE_KINDS = new Set<string>(['read', 'ls', 'grep']);
const NAMED_KIND_LIMIT = 2;
const OUTPUT_PREVIEW_LINES = 20;

export const TOOL_GROUP_PREVIEW = 8;
export const TOOL_ERROR_PREVIEW_LINES = 8;
export const TOOL_COMMAND_PREVIEW_LINES = 5;
export const TOOL_KINDS = ['read', 'write', 'edit', 'ls', 'grep', 'bash'] as const;

function translator(lang: Lang): Translate {
  return (key, params) => phrase(lang, key, params);
}

function asRecord(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  return {};
}

export function toolKind(name: unknown): ToolKind {
  const key = String(name || '').toLowerCase();
  return KINDS.has(key) ? key as Exclude<ToolKind, 'other'> : 'other';
}

/** running | failed | interrupted | done */
export function toolStatusBucket(status: unknown): ToolStatusBucket {
  const value = String(status || '').toLowerCase();
  if (value === 'running' || value === 'pending' || value === 'waiting') return 'running';
  if (value === 'failed' || value === 'error') return 'failed';
  if (value === 'interrupted') return 'interrupted';
  return 'done';
}

export function oneLine(value: unknown, max = 72): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function toolFileLabel(pathLike: unknown): string {
  const s = String(pathLike || '').replaceAll('\\', '/').replace(/\/+$/, '');
  if (!s || s === '.' || s === './') return '';
  const parts = s.split('/').filter(Boolean);
  return parts.pop() || s;
}

function slashPath(value: unknown): string {
  return String(value ?? '').replaceAll('\\', '/');
}

/** Workspace-relative path for display. Paths outside the workspace stay as-is. */
export function relativizePath(pathLike: unknown, workspacePath: unknown): string {
  const raw = String(pathLike ?? '');
  const rootRaw = String(workspacePath ?? '');
  if (!raw || !rootRaw) return raw;
  const file = slashPath(raw);
  const root = slashPath(rootRaw).replace(/\/+$/, '');
  if (!root) return raw;
  const fileCmp = file.toLowerCase();
  const rootCmp = root.toLowerCase();
  if (fileCmp === rootCmp) return '.';
  if (fileCmp.startsWith(`${rootCmp}/`)) return file.slice(root.length + 1);
  return raw;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Drive-letter paths and UNC/backslash roots: Windows, case-insensitive. */
function windowsPathRoot(root: string): boolean {
  return /^[A-Za-z]:/.test(root) || root.includes('\\');
}

function driveCaseVariants(root: string): string[] {
  const match = /^([A-Za-z])(:[\s\S]*)$/.exec(root);
  if (!match) return [root];
  return [root, `${match[1].toLowerCase()}${match[2]}`, `${match[1].toUpperCase()}${match[2]}`];
}

function rootVariants(workspacePath: unknown): string[] {
  const rootRaw = String(workspacePath ?? '');
  if (!rootRaw) return [];
  const trimmed = rootRaw.replace(/[\\/]+$/, '');
  const forward = slashPath(trimmed).replace(/\/+$/, '');
  const backward = trimmed.replaceAll('/', '\\').replace(/\\+$/, '');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [trimmed, forward, backward]) {
    if (!item) continue;
    for (const variant of driveCaseVariants(item)) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      out.push(variant);
    }
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

/** Replace absolute workspace prefixes in error text with relative paths. */
export function relativizeText(text: unknown, workspacePath: unknown): string {
  const raw = String(text ?? '');
  if (!raw) return raw;
  let out = raw;
  for (const root of rootVariants(workspacePath)) {
    const escaped = escapeRegExp(root);
    // Mixed separators (`C:\\ws` + `/src/a.js`) and Windows drive-letter case.
    const flags = windowsPathRoot(root) ? 'gi' : 'g';
    out = out.replace(new RegExp(`${escaped}[\\\\/]`, flags), '');
    const quoted = new RegExp(`(['"])${escaped}\\1`, 'g');
    out = out.replace(quoted, '$1.$1');
  }
  return out;
}

const FILE_ERROR_CODES = [
  { re: /\bENOENT\b/, key: 'tool_err_enoent' },
  { re: /\bEACCES\b|\bEPERM\b/, key: 'tool_err_eacces' },
  { re: /\bE_SANDBOX\b/, key: 'tool_err_sandbox' },
  { re: /\bEISDIR\b/, key: 'tool_err_eisdir' },
  { re: /\bENOTDIR\b/, key: 'tool_err_enotdir' },
];

export function shortErrorHint(text: unknown, lang: Lang): string {
  const t = translator(lang);
  const raw = String(text ?? '');
  for (const item of FILE_ERROR_CODES) {
    if (item.re.test(raw)) return t(item.key);
  }
  return '';
}

function shortErrorHintT(text: unknown, t: Translate): string {
  const raw = String(text ?? '');
  for (const item of FILE_ERROR_CODES) {
    if (item.re.test(raw)) return t(item.key);
  }
  return '';
}

/**
 * What a row or a single-call summary should name.
 * `mode: 'path'` is a file path (may be empty). `mode: 'text'` is a command or pattern.
 */
export function toolFocus(tool: ToolLike | null | undefined): ToolFocus {
  const name = String(tool?.name || '');
  const kind = toolKind(name);
  const input = tool?.input && typeof tool.input === 'object' ? asRecord(tool.input) : {};
  if (kind === 'bash') {
    return { mode: 'text', text: oneLine(input.command || input.cmd || '') };
  }
  if (kind === 'grep') {
    const pattern = oneLine(input.pattern || input.query || '');
    const file = oneLine(tool?.path || input.path || '');
    return { mode: 'text', text: [pattern, file].filter(Boolean).join(' ') };
  }
  const file = String(tool?.path || input.path || input.file_path || input.file || '').trim();
  if (kind === 'ls' && (file === '' || file === '.' || file === './')) {
    return { mode: 'path', text: '' };
  }
  return { mode: 'path', text: file };
}

/** One-line intent from `input.description`, or empty when the model omitted it. */
export function toolIntent(tool: ToolLike | null | undefined): string {
  const input = tool?.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
    ? asRecord(tool.input)
    : {};
  if (typeof input.description !== 'string') return '';
  return oneLine(input.description);
}

/**
 * Expanded-row heading. Prefer the intent as the title and keep the command or
 * path as secondary detail so the actual call is still visible.
 */
export function toolRowHeading(tool: ToolLike | null | undefined): ToolRowHeading {
  const intent = toolIntent(tool);
  const focus = toolFocus(tool);
  if (intent) return { title: intent, detail: focus.text, intent: true };
  return { title: focus.text, detail: '', intent: false };
}

export function toolGroupKey(tools: unknown): string {
  const list = Array.isArray(tools) ? tools as ToolLike[] : [];
  const first = list.find((tool) => tool && tool.id != null && String(tool.id) !== '');
  if (first) return `g:${first.id}`;
  const name = list[0]?.name || 'tool';
  return `g:${name}:${list.length}`;
}

function presentSummary(text: string): string {
  if (!text) return '';
  const first = text.charAt(0);
  if (first >= 'a' && first <= 'z') return first.toUpperCase() + text.slice(1);
  return text;
}

function countClause(kind: string, n: number, name: unknown, t: Translate): string {
  if (kind === 'other') {
    return t(n === 1 ? 'tool_sum_other_one' : 'tool_sum_other', { n, name: name || 'tool' });
  }
  return t(n === 1 ? `tool_sum_${kind}_one` : `tool_sum_${kind}`, { n });
}

function countPhrase(tools: ToolLike[], t: Translate): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const names = new Map<string, unknown>();
  for (const tool of tools) {
    const kind = toolKind(tool?.name);
    const key = kind === 'other' ? `other:${tool?.name || 'tool'}` : kind;
    if (!counts.has(key)) {
      counts.set(key, 0);
      order.push(key);
      names.set(key, tool?.name || 'tool');
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const join = t('tool_sum_join');
  return order.map((key) => {
    const kind = key.startsWith('other:') ? 'other' : key;
    return countClause(kind, counts.get(key) ?? 0, names.get(key), t);
  }).join(join);
}

function targetOf(tool: ToolLike): string {
  return toolFocus(tool).text;
}

function shortFocus(tool: ToolLike): string {
  const focus = toolFocus(tool);
  if (focus.mode === 'path') return toolFileLabel(focus.text);
  return oneLine(focus.text, 32);
}

function singlePhrase(tool: ToolLike, t: Translate): string {
  const intent = toolIntent(tool);
  if (intent) return intent;
  const kind = toolKind(tool?.name);
  const target = targetOf(tool);
  if (kind === 'other') {
    const name = tool?.name || 'tool';
    return target
      ? t('tool_one_other_target', { name, target })
      : t('tool_one_other', { name });
  }
  if (!target) return countPhrase([tool], t);
  return t(`tool_one_${kind}`, { target });
}

function runningPhrase(tool: ToolLike, t: Translate): string {
  const intent = toolIntent(tool);
  if (intent) return intent;
  const kind = toolKind(tool?.name);
  const target = targetOf(tool);
  if (kind === 'other') {
    const name = tool?.name || 'tool';
    return target
      ? t('tool_run_other_target', { name, target })
      : t('tool_run_other', { name });
  }
  if (!target) return t(`tool_run_${kind}_bare`);
  return t(`tool_run_${kind}`, { target });
}

function actionLabel(tool: ToolLike, t: Translate): string {
  const kind = toolKind(tool?.name);
  if (kind === 'other') return String(tool?.name || 'tool');
  return t(`tool_act_${kind}`);
}

function failedPhrase(tool: ToolLike, t: Translate): string {
  const action = actionLabel(tool, t);
  const target = shortFocus(tool);
  if (!target) return t('tool_fail_bare', { action });
  return t('tool_fail_named', { action, target });
}

function changedClause(tools: ToolLike[], t: Translate): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (isCallFailed(tool)) continue;
    if (!CHANGE_KINDS.has(toolKind(tool?.name))) continue;
    const path = targetOf(tool);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    names.push(toolFileLabel(path) || path);
  }
  if (!names.length) return '';
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  const joined = shown.join(t('tool_sum_names_join'));
  if (extra > 0) return t('tool_sum_changed_more', { names: joined, n: extra });
  return t('tool_sum_changed', { names: joined });
}

function failedClause(tools: ToolLike[], t: Translate): string {
  const failed = tools.filter((tool) => isRealToolFailure(tool, tools));
  if (!failed.length) return '';
  return failed.slice(0, 2).map((tool) => failedPhrase(tool, t)).join(t('tool_sum_names_join'));
}

function commandClause(tools: ToolLike[], t: Translate): string {
  const cmds: string[] = [];
  for (const tool of tools) {
    if (isCallFailed(tool)) continue;
    if (toolKind(tool?.name) !== 'bash') continue;
    const text = targetOf(tool);
    if (!text) continue;
    cmds.push(oneLine(text, 40));
  }
  if (!cmds.length) return '';
  const shown = cmds.slice(0, 2);
  return t('tool_sum_ran', { names: shown.join(t('tool_sum_names_join')) });
}

function uniqueFileNames(tools: ToolLike[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const label = toolFileLabel(targetOf(tool));
    if (!label || seen.has(label)) continue;
    seen.add(label);
    names.push(label);
  }
  return names;
}

function grepQuery(tool: ToolLike): string {
  const input = tool?.input && typeof tool.input === 'object' ? asRecord(tool.input) : {};
  return oneLine(input.pattern || input.query || '', 32);
}

function namedKindPhrase(kind: string, tools: ToolLike[], t: Translate): string {
  if (kind === 'grep') {
    const query = tools.map(grepQuery).find(Boolean);
    if (query) return t('tool_sum_grep_named', { query });
    return countPhrase(tools, t);
  }
  if (kind === 'read' || kind === 'ls') {
    const names = uniqueFileNames(tools);
    if (!names.length) return countPhrase(tools, t);
    const shown = names.slice(0, NAMED_KIND_LIMIT);
    const joined = shown.join(t('tool_sum_names_join'));
    if (tools.length > shown.length) {
      return t(`tool_sum_${kind}_named_more`, { names: joined, n: tools.length });
    }
    return t(`tool_sum_${kind}_named`, { names: joined });
  }
  return countPhrase(tools, t);
}

function namedCountClause(tools: ToolLike[], t: Translate): string {
  const rest = tools.filter((tool) => {
    if (isCallFailed(tool)) return false;
    return COUNT_KINDS.has(toolKind(tool?.name));
  });
  if (!rest.length) return '';
  const order: string[] = [];
  const groups = new Map<string, ToolLike[]>();
  for (const tool of rest) {
    const kind = toolKind(tool?.name);
    const key = kind === 'other' ? `other:${tool?.name || 'tool'}` : kind;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(tool);
  }
  return order.map((key) => {
    const kind = key.startsWith('other:') ? 'other' : key;
    return namedKindPhrase(kind, groups.get(key)!, t);
  }).join(t('tool_sum_join'));
}

function richSummary(list: ToolLike[], t: Translate): string {
  if (list.length === 1) {
    const tool = list[0];
    if (toolStatusBucket(tool.status) === 'failed') return failedPhrase(tool, t);
    const intent = toolIntent(tool);
    if (intent) return intent;
    const kind = toolKind(tool?.name);
    if (CHANGE_KINDS.has(kind)) return changedClause(list, t) || singlePhrase(tool, t);
    if (kind === 'bash') return commandClause(list, t) || singlePhrase(tool, t);
    return singlePhrase(tool, t);
  }
  const clauses = [changedClause(list, t), failedClause(list, t), commandClause(list, t), namedCountClause(list, t)]
    .filter(Boolean);
  if (!clauses.length) return countPhrase(list, t);
  return clauses.join(t('tool_sum_join'));
}

export function summarizeToolGroup(tools: unknown, lang: Lang): ToolGroupSummary {
  const t = translator(lang);
  const list = (Array.isArray(tools) ? tools : []).filter(Boolean) as ToolLike[];
  const failed = list.filter((tool) => isRealToolFailure(tool, list)).length;
  let runningTool: ToolLike | null = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (toolStatusBucket(list[i].status) === 'running') {
      runningTool = list[i];
      break;
    }
  }
  let text = '';
  if (runningTool) text = runningPhrase(runningTool, t);
  else if (list.length) text = richSummary(list, t);
  return {
    text: presentSummary(text),
    failed,
    running: Boolean(runningTool),
  };
}

export function toolGroupPreview(
  tools: unknown,
  showAll = false,
  limit = TOOL_GROUP_PREVIEW,
): { tools: ToolLike[]; hidden: number } {
  const list = (Array.isArray(tools) ? tools : []).filter(Boolean) as ToolLike[];
  if (showAll || list.length <= limit) return { tools: list, hidden: 0 };
  return {
    tools: list.slice(-limit),
    hidden: list.length - limit,
  };
}

function nonemptyLines(text: unknown): string[] {
  const raw = String(text ?? '');
  if (!raw) return [];
  return raw.split(/\r?\n/).filter((line) => line.length > 0);
}

export function outputLineCount(text: unknown): number {
  const raw = String(text ?? '');
  if (!raw) return 0;
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

export function parseToolOutput(output: unknown): { text: string; json: unknown } {
  if (output == null || output === '') return { text: '', json: null };
  if (typeof output === 'object') {
    return { text: JSON.stringify(output), json: output };
  }
  const text = String(output);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const json = JSON.parse(trimmed);
      if (json && typeof json === 'object') return { text, json };
    } catch {
      /* keep as text */
    }
  }
  return { text, json: null };
}

const HARNESS_TAG = /^<\/?harness>$/;
const HARNESS_SEVERITY = /^\[(error|warn|warning|info)\]\s+/i;

/**
 * Pi Durable appends diagnostics as:
 *   <harness>
 *   [error] ENOENT: ...
 *   </harness>
 * Drop the wrapper lines and the severity prefix. Text without that wrapper is unchanged.
 */
export function unwrapHarnessDiagnostics(text: unknown): string {
  const raw = text == null ? '' : String(text);
  const lines = raw.split(/\r?\n/);
  if (!lines.some((line) => line.trim() === '<harness>')) return raw;
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (HARNESS_TAG.test(trimmed)) {
      inside = trimmed === '<harness>';
      continue;
    }
    out.push(inside ? line.replace(HARNESS_SEVERITY, '') : line);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function firstLine(text: unknown, max = 72): string {
  const line = String(text ?? '').split(/\r?\n/).find((item) => item.trim()) || '';
  return oneLine(line, max);
}

function lastLine(text: unknown, max = 72): string {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) return oneLine(lines[i], max);
  }
  return '';
}

/** Official bash appends this diagnostic: `Command exited with code ${exitCode}`. */
const BASH_EXIT_NOTICE = /^(?:\[(?:error|warn|warning|info)\]\s+)?Command exited with code (\d+)\s*$/i;

function stripTrailingBashExitNotice(text: unknown): { text: string; exitCode: number | null } {
  const lines = String(text ?? '').split(/\r?\n/);
  let exitCode: number | null = null;
  while (lines.length) {
    const trimmed = lines[lines.length - 1].trim();
    if (!trimmed) {
      lines.pop();
      continue;
    }
    const match = trimmed.match(BASH_EXIT_NOTICE);
    if (!match) break;
    exitCode = Number(match[1]);
    lines.pop();
  }
  return { text: lines.join('\n'), exitCode };
}

function bashResultText(tool: ToolLike | null | undefined): string {
  const { parsed, json, stdout, stderr } = bashStreams(tool);
  if (json && (json.stdout != null || json.stderr != null)) return stdout || stderr;
  return parsed.text;
}

function bashStreams(tool: ToolLike | null | undefined) {
  const parsed = parseToolOutput(tool?.output);
  const json = parsed.json && typeof parsed.json === 'object' ? parsed.json as JsonObject : null;
  const stdout = json && json.stdout != null ? String(json.stdout) : '';
  const stderr = json && json.stderr != null ? String(json.stderr) : '';
  const code = json && json.code != null
    ? json.code
    : (tool?.code != null ? tool.code : null);
  return { parsed, json, stdout, stderr, code };
}

function bashNonZero(tool: ToolLike | null | undefined): boolean {
  if (toolKind(tool?.name) !== 'bash') return false;
  const { code } = bashStreams(tool);
  if (code == null || code === '') return false;
  return Number(code) !== 0;
}

function isCallFailed(tool: ToolLike | null | undefined): boolean {
  return toolStatusBucket(tool?.status) === 'failed' || bashNonZero(tool);
}

function isCallSuccessful(tool: ToolLike | null | undefined): boolean {
  return toolStatusBucket(tool?.status) === 'done' && !bashNonZero(tool);
}

function indexInGroup(tool: ToolLike | null | undefined, list: ToolLike[]): number {
  const direct = list.indexOf(tool as ToolLike);
  if (direct >= 0) return direct;
  if (tool?.id == null || String(tool.id) === '') return -1;
  return list.findIndex((item) => item && item.id === tool.id);
}

/**
 * A failed read/ls/grep is a probe when a later call in the same group succeeded.
 * Write/edit/bash failures, a non-zero bash exit, and the group's last failure are real.
 */
export function isProbeFailure(tool: ToolLike | null | undefined, tools: unknown): boolean {
  if (!isCallFailed(tool)) return false;
  if (!PROBE_KINDS.has(toolKind(tool?.name))) return false;
  const list = Array.isArray(tools) ? (tools as ToolLike[]).filter(Boolean) : [];
  const index = indexInGroup(tool, list);
  if (index < 0 || index === list.length - 1) return false;
  return list.slice(index + 1).some(isCallSuccessful);
}

export function isRealToolFailure(tool: ToolLike | null | undefined, tools: unknown): boolean {
  return isCallFailed(tool) && !isProbeFailure(tool, tools);
}

function bashFailedHint(tool: ToolLike, t: Translate, workspacePath: string): ToolHint {
  const { parsed, json, code } = bashStreams(tool);
  const failText = json
    ? String(json.stderr || json.message || json.error || json.stdout || bashResultText(tool) || parsed.text || '')
    : (bashResultText(tool) || parsed.text);
  const unwrapped = relativizeText(unwrapHarnessDiagnostics(failText || parsed.text), workspacePath);
  const short = shortErrorHintT(unwrapped, t);
  if (short) return { text: short, failed: true };
  const stripped = stripTrailingBashExitNotice(unwrapped);
  const exit = (code != null && code !== '') ? code : stripped.exitCode;
  const line = lastLine(stripped.text, 64);
  if (exit != null && exit !== '' && line) {
    return { text: t('tool_hint_exit_line', { code: exit, line }), failed: true };
  }
  if (exit != null && exit !== '') {
    return { text: t('tool_hint_exit', { code: exit }), failed: true };
  }
  return { text: line, failed: true };
}

function bashSuccessHint(tool: ToolLike, t: Translate): ToolHint {
  const line = lastLine(bashResultText(tool), 48);
  return { text: line || t('tool_hint_no_output'), failed: false };
}

/** Short result hint shown on a row without expanding it. */
export function toolResultHint(
  tool: ToolLike | null | undefined,
  lang: Lang,
  options: { workspacePath?: string } = {},
): ToolHint {
  if (!tool) return { text: '', failed: false };
  const t = translator(lang);
  const workspacePath = options.workspacePath || '';
  const bucket = toolStatusBucket(tool.status);
  const parsed = parseToolOutput(tool.output);
  const json = parsed.json && typeof parsed.json === 'object' ? parsed.json as JsonObject : null;
  const failText = json
    ? String(json.stderr || json.message || json.error || json.stdout || parsed.text || '')
    : parsed.text;
  const kind = toolKind(tool?.name);

  if (kind === 'bash' && (bucket === 'failed' || bashNonZero(tool))) {
    return bashFailedHint(tool, t, workspacePath);
  }
  if (bucket === 'failed' || bashNonZero(tool)) {
    const unwrapped = relativizeText(unwrapHarnessDiagnostics(failText || parsed.text), workspacePath);
    const short = shortErrorHintT(unwrapped, t);
    return { text: short || firstLine(unwrapped, 64), failed: true };
  }
  if (bucket === 'running') return { text: '', failed: false };

  if (kind === 'read') {
    return { text: t('tool_hint_lines', { n: outputLineCount(parsed.text) }), failed: false };
  }
  if (kind === 'ls') {
    return { text: t('tool_hint_items', { n: nonemptyLines(parsed.text).length }), failed: false };
  }
  if (kind === 'grep') {
    return { text: t('tool_hint_matches', { n: nonemptyLines(parsed.text).length }), failed: false };
  }
  if (kind === 'bash') {
    return bashSuccessHint(tool, t);
  }
  return { text: '', failed: false };
}

/** Keep the first `limit` lines unless the caller asked for the full text. */
export function clipOutputText(text: unknown, showAll: boolean, limit = OUTPUT_PREVIEW_LINES): { text: string; clipped: boolean } {
  const raw = text == null ? '' : String(text);
  if (showAll) return { text: raw, clipped: false };
  const lines = raw.split(/\r?\n/);
  if (lines.length <= limit) return { text: raw, clipped: false };
  return { text: lines.slice(0, limit).join('\n'), clipped: true };
}

/** Command rows keep the last `limit` lines, matching public/app.js clipTailLines. */
export function clipTailLines(text: unknown, limit = TOOL_COMMAND_PREVIEW_LINES): { text: string; clipped: boolean } {
  const raw = text == null ? '' : String(text);
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= limit) return { text: raw, clipped: false };
  return { text: lines.slice(-limit).join('\n'), clipped: true };
}

/** Badge numbers from the tool, or from `wrote path (+N −M)` when the payload omitted them. */
export function toolDiffCounts(tool: ToolLike | null | undefined): { added: number | null; removed: number | null } {
  if (!tool) return { added: null, removed: null };
  if (tool.added != null || tool.removed != null) {
    return {
      added: tool.added != null ? Number(tool.added) : null,
      removed: tool.removed != null ? Number(tool.removed) : null,
    };
  }
  const output = typeof tool.output === 'string' ? tool.output : '';
  const match = output.match(/\(\+(\d+)\s*[−-]\s*(\d+)\)/);
  if (!match) return { added: null, removed: null };
  return { added: Number(match[1]), removed: Number(match[2]) };
}

export function toolOutputText(tool: ToolLike | null | undefined, workspacePath: string): string {
  const parsed = parseToolOutput(tool?.output);
  const json = parsed.json && typeof parsed.json === 'object' ? parsed.json as JsonObject : null;
  let raw = parsed.text;
  if (toolKind(tool?.name) === 'bash' && json && (json.stdout != null || json.stderr != null)) {
    const stdout = json.stdout == null ? '' : String(json.stdout);
    const stderr = json.stderr == null ? '' : String(json.stderr);
    raw = [stdout, stderr].filter((part) => part !== '').join(stdout && stderr ? '\n' : '');
    if (!raw) raw = parsed.text;
  }
  return relativizeText(unwrapHarnessDiagnostics(raw), workspacePath);
}

function displayPath(tool: ToolLike | null | undefined, workspacePath: string): string | undefined {
  const input = tool?.input && typeof tool.input === 'object' ? asRecord(tool.input) : {};
  const file = String(tool?.path || input.path || input.file_path || input.file || '').trim();
  if (!file) return undefined;
  const rel = relativizePath(file, workspacePath);
  return rel || undefined;
}

function headingView(tool: ToolLike, workspacePath: string): ToolCall['heading'] {
  const heading = toolRowHeading(tool);
  const focus = toolFocus(tool);
  const fix = (text: string) => {
    if (!text || focus.mode !== 'path') return text;
    return relativizePath(text, workspacePath);
  };
  return {
    title: heading.intent ? heading.title : fix(heading.title),
    detail: fix(heading.detail),
    fromIntent: heading.intent,
  };
}

function bashExitCode(tool: ToolLike | null | undefined): number | undefined {
  if (toolKind(tool?.name) !== 'bash') return undefined;
  const { parsed, json, code } = bashStreams(tool);
  if (code != null && code !== '') {
    const n = Number(code);
    if (Number.isFinite(n)) return n;
  }
  const failText = json
    ? String(json.stderr || json.message || json.error || json.stdout || bashResultText(tool) || parsed.text || '')
    : (bashResultText(tool) || parsed.text);
  const stripped = stripTrailingBashExitNotice(unwrapHarnessDiagnostics(failText || ''));
  if (stripped.exitCode != null && Number.isFinite(stripped.exitCode)) return stripped.exitCode;
  return undefined;
}

function toolFailure(tool: ToolLike, group: ToolLike[]): ToolFailureKind {
  if (isProbeFailure(tool, group)) return 'probe';
  if (isRealToolFailure(tool, group)) return 'real';
  return 'none';
}

function diffView(tool: ToolLike): ToolCall['diff'] {
  const counts = toolDiffCounts(tool);
  if (counts.added == null && counts.removed == null) return null;
  return { added: counts.added, removed: counts.removed };
}

export function toolCallView(
  tool: ToolLike,
  groupTools: unknown,
  opts: { lang: Lang; workspacePath?: string },
): ToolCall {
  const lang = opts.lang;
  const workspacePath = opts.workspacePath || '';
  const group = (Array.isArray(groupTools) && groupTools.length ? groupTools : [tool]).filter(Boolean) as ToolLike[];
  const kind = toolKind(tool?.name);
  const status = toolStatusBucket(tool?.status);
  const path = displayPath(tool, workspacePath);
  const outputText = toolOutputText(tool, workspacePath);
  const failed = isCallFailed(tool);
  const clipped = kind === 'bash'
    ? clipTailLines(outputText, TOOL_COMMAND_PREVIEW_LINES)
    : clipOutputText(outputText, false, failed ? TOOL_ERROR_PREVIEW_LINES : OUTPUT_PREVIEW_LINES);
  const view: ToolCall = {
    id: String(tool?.id ?? ''),
    groupId: toolGroupKey(group),
    kind,
    status,
    heading: headingView(tool, workspacePath),
    hint: toolResultHint(tool, lang, { workspacePath }),
    failure: toolFailure(tool, group),
    diff: diffView(tool),
    output: {
      preview: clipped.text,
      truncated: clipped.clipped,
      totalLines: outputLineCount(outputText),
    },
  };
  if (kind === 'bash' && outputText && (clipped.clipped || status === 'running')) {
    view.output.text = outputText;
  }
  if (path) view.path = path;
  const exitCode = bashExitCode(tool);
  if (kind === 'bash' && exitCode != null) view.exitCode = exitCode;
  return view;
}

export function toolGroupSummaryView(tools: unknown, lang: Lang): ToolGroupSummary {
  return summarizeToolGroup(tools, lang);
}
