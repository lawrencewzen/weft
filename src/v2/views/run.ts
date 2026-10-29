/**
 * RunState view. Status buckets match docs/ARCHITECTURE_V2.md §6.1 / §6.2.
 * pendingText matches public/app.js pendingStatusText.
 *
 * Pi Durable `SubmissionRecord` has no start timestamp (see
 * node_modules/@earendil-works/pi-durable/dist/types.d.ts). startedAt is null
 * unless the caller already has one.
 */

import { phrase, type Lang } from '../phrases/index.ts';
import type { components } from '../contract.gen.ts';
import { activeToolSummary, toolGroupSummaryView, type ToolLike } from './tools.ts';
import type { ThreadMessage, ThreadSubagent } from './thread.ts';

export type RunState = components['schemas']['RunState'];
export type RunStatus = RunState['status'];
export type ConversationStatus = components['schemas']['ConversationView']['status'];
export type ActiveTool = NonNullable<RunState['activeTool']>;

/** Main-run stall threshold. Equal to the threshold is not stalled. */
export const DEFAULT_STALL_AFTER_MS = 180_000;

export function resolveStallAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.WEFT_MAIN_STALL_MS || '').trim();
  if (!raw) return DEFAULT_STALL_AFTER_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STALL_AFTER_MS;
  return Math.trunc(n);
}

/** Same as subagent finiteTs: positive finite timestamps only. */
export function finiteTs(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** running and now − lastActivityAt > stallAfterMs. Equal to the threshold is not stalled. */
export function isRunStalled(
  lastActivityAt: unknown,
  now: number,
  stallAfterMs = DEFAULT_STALL_AFTER_MS,
): boolean {
  const last = finiteTs(lastActivityAt);
  if (!last) return false;
  return now - last > stallAfterMs;
}

export function stalledSinceOf(
  running: boolean,
  lastActivityAt: unknown,
  now: number,
  stallAfterMs = DEFAULT_STALL_AFTER_MS,
): number | null {
  if (!running) return null;
  const last = finiteTs(lastActivityAt);
  if (!last) return null;
  return now - last > stallAfterMs ? last : null;
}

export function activeToolView(
  tool: ToolLike | null | undefined,
  startedAt: number,
): ActiveTool | null {
  const name = String(tool?.name ?? '').trim();
  if (!name || !Number.isFinite(startedAt) || startedAt <= 0) return null;
  return {
    name,
    startedAt: Math.trunc(startedAt),
    summary: activeToolSummary(tool),
  };
}

export type LlmErrorLike = {
  code?: unknown;
  message?: unknown;
  retry?: {
    attempt?: unknown;
    delayMs?: unknown;
  };
};

export type RunStateInput = {
  status?: unknown;
  llmError?: LlmErrorLike | null;
  messages?: ThreadMessage[] | null;
  tools?: ToolLike[] | null;
  subagents?: ThreadSubagent[] | null;
  lang?: Lang;
  hasWorkspace?: boolean;
  startedAt?: unknown;
  lastActivityAt?: unknown;
  activeTool?: ActiveTool | null;
  now?: number;
  stallAfterMs?: number;
};

function isRealSubagent(agent: ThreadSubagent | null | undefined): boolean {
  return String(agent?.id || '').includes(':sub:');
}

/** recovering/resuming → running; paused → waiting; error → failed; done → idle. */
export function normalizeRunStatus(status: unknown): RunStatus {
  const value = String(status || '').toLowerCase();
  if (value === 'running' || value === 'recovering' || value === 'resuming') return 'running';
  if (value === 'paused' || value === 'waiting') return 'waiting';
  if (value === 'error' || value === 'failed') return 'failed';
  if (value === 'stopped') return 'stopped';
  return 'idle';
}

/** ConversationView status: same buckets as 6.1 (no stopped). */
export function conversationStatus(status: unknown): ConversationStatus {
  const run = normalizeRunStatus(status);
  if (run === 'running') return 'running';
  if (run === 'waiting') return 'waiting';
  if (run === 'failed') return 'failed';
  return 'idle';
}

function toolsFromMessages(messages: ThreadMessage[] | null | undefined): ToolLike[] {
  const tools: ToolLike[] = [];
  for (const m of messages || []) {
    if (m?.role === 'tool' && m.tool) tools.push(m.tool);
  }
  return tools;
}

function liveSubagentCount(subagents: ThreadSubagent[] | null | undefined): number {
  return (subagents || []).filter((ag) => isRealSubagent(ag) && String(ag.status || '') === 'running').length;
}

function asStartedAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

function errorView(llmError: LlmErrorLike | null | undefined): RunState['error'] {
  if (!llmError) return { code: 'E_LLM', message: '' };
  const out: NonNullable<RunState['error']> = {
    code: String(llmError.code || 'E_LLM'),
    message: String(llmError.message || ''),
  };
  const attempt = Number(llmError.retry?.attempt);
  const delayMs = Number(llmError.retry?.delayMs);
  if (Number.isFinite(attempt) && Number.isFinite(delayMs)) {
    out.retry = { attempt, delayMs };
  }
  return out;
}

function pendingTextFor(
  lang: Lang,
  messages: ThreadMessage[] | null | undefined,
  tools: ToolLike[] | null | undefined,
  subagents: ThreadSubagent[] | null | undefined,
): string {
  const list = Array.isArray(tools) && tools.length ? tools : toolsFromMessages(messages);
  const summary = toolGroupSummaryView(list, lang);
  let text = summary.running ? summary.text : phrase(lang, 'pending_thinking');
  const live = liveSubagentCount(subagents);
  if (live) text = `${text} ${phrase(lang, 'pending_subagents', { n: live })}`;
  return text;
}

export function runStateView({
  status,
  llmError,
  messages,
  tools,
  subagents,
  lang = 'zh',
  hasWorkspace = true,
  startedAt,
  lastActivityAt,
  activeTool = null,
  now,
  stallAfterMs,
}: RunStateInput = {}): RunState {
  const runStatus = normalizeRunStatus(status);
  const running = runStatus === 'running';
  const last = running ? asStartedAt(lastActivityAt) : null;
  const t = now ?? Date.now();
  const threshold = stallAfterMs ?? resolveStallAfterMs();
  return {
    status: runStatus,
    startedAt: asStartedAt(startedAt),
    pendingText: running ? pendingTextFor(lang, messages, tools, subagents) : null,
    canSend: Boolean(hasWorkspace),
    canStop: running,
    lockedReason: hasWorkspace ? null : 'no_workspace',
    error: runStatus === 'failed' ? errorView(llmError) : null,
    lastActivityAt: last,
    stalledSince: stalledSinceOf(running, last, t, threshold),
    activeTool: running ? activeTool : null,
  };
}
