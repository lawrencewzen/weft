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
import { toolGroupSummaryView, type ToolLike } from './tools.ts';
import type { ThreadMessage, ThreadSubagent } from './thread.ts';

export type RunState = components['schemas']['RunState'];
export type RunStatus = RunState['status'];
export type ConversationStatus = components['schemas']['ConversationView']['status'];

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
}: RunStateInput = {}): RunState {
  const runStatus = normalizeRunStatus(status);
  const running = runStatus === 'running';
  return {
    status: runStatus,
    startedAt: asStartedAt(startedAt),
    pendingText: running ? pendingTextFor(lang, messages, tools, subagents) : null,
    canSend: Boolean(hasWorkspace),
    canStop: running,
    lockedReason: hasWorkspace ? null : 'no_workspace',
    error: runStatus === 'failed' ? errorView(llmError) : null,
  };
}
