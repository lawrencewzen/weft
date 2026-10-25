/** Subagent view: title fallback, status buckets, stuck. No DOM. */

import type { components } from '../contract.gen.ts';
import { fileExistsInWorkspace } from './path-refs.ts';
import {
  buildThread,
  type ThreadMessage,
} from './thread.ts';
import type { PresentedConversation } from './conversation.ts';

export type Subagent = components['schemas']['Subagent'];
export type SubagentSnapshot = components['schemas']['SubagentSnapshot'];
export type SubagentStatus = Subagent['status'];
export type SubagentMode = Subagent['mode'];

export const DEFAULT_STUCK_AFTER_MS = 60_000;

export type SubagentLike = {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  brief?: unknown;
  lastText?: unknown;
  status?: unknown;
  mode?: unknown;
  startedAt?: unknown;
  lastActivityAt?: unknown;
  endedAt?: unknown;
  currentAction?: unknown;
  step?: unknown;
  totalSteps?: unknown;
};

export type SubagentViewOpts = {
  parentConversationId?: string;
  now?: number;
  stuckAfterMs?: number;
};

export function resolveStuckAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.WEFT_SUBAGENT_STUCK_MS || '').trim();
  if (!raw) return DEFAULT_STUCK_AFTER_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STUCK_AFTER_MS;
  return Math.trunc(n);
}

/** Same as public/app.js finiteTs: positive finite timestamps only. */
export function finiteTs(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Same as public/app.js firstBriefLine. */
export function firstBriefLine(text: unknown): string {
  const raw = String(text || '');
  if (!raw) return '';
  const line = raw.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return String(line || raw).replace(/\s+/g, ' ').trim();
}

/** Same as public/app.js subagentTitle. */
export function subagentTitle(agent: SubagentLike | null | undefined): string {
  return String(agent?.title || '').replace(/\s+/g, ' ').trim();
}

/**
 * Title fallback, same order as public/app.js subagentSummary:
 * title → brief first line → lastText → name.
 */
export function subagentSummary(agent: SubagentLike | null | undefined): string {
  const titled = subagentTitle(agent);
  if (titled) return titled;
  const fromBrief = firstBriefLine(agent?.brief);
  if (fromBrief) return fromBrief;
  const last = String(agent?.lastText || '').replace(/\s+/g, ' ').trim();
  if (last) return last;
  return String(agent?.name || '').trim();
}

function kernelStatus(status: unknown): string {
  const value = String(status || '').toLowerCase();
  if (value === 'recovering' || value === 'resuming') return 'running';
  if (value === 'error') return 'failed';
  if (value === 'paused') return 'waiting';
  return value || 'waiting';
}

/** running and now − lastActivityAt > stuckAfterMs. Equal to the threshold is not stuck. */
export function isSubagentStuck(
  agent: SubagentLike | null | undefined,
  now: number,
  stuckAfterMs = DEFAULT_STUCK_AFTER_MS,
): boolean {
  if (kernelStatus(agent?.status) !== 'running') return false;
  const last = finiteTs(agent?.lastActivityAt);
  if (!last) return false;
  return now - last > stuckAfterMs;
}

export function subagentStatus(
  agent: SubagentLike | null | undefined,
  now: number,
  stuckAfterMs = DEFAULT_STUCK_AFTER_MS,
): SubagentStatus {
  if (isSubagentStuck(agent, now, stuckAfterMs)) return 'stuck';
  const raw = kernelStatus(agent?.status);
  if (raw === 'running' || raw === 'waiting' || raw === 'done' || raw === 'stopped' || raw === 'failed' || raw === 'stuck') {
    return raw;
  }
  return 'waiting';
}

function asTs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

function progressOf(agent: SubagentLike | null | undefined): Subagent['progress'] {
  const step = Number(agent?.step);
  const total = Number(agent?.totalSteps);
  if (!Number.isFinite(step) || !Number.isFinite(total)) return null;
  return { step, total };
}

function parentIdOf(agent: SubagentLike | null | undefined, fallback = ''): string {
  if (fallback) return fallback;
  const id = String(agent?.id ?? '');
  const at = id.indexOf(':sub:');
  return at >= 0 ? id.slice(0, at) : '';
}

export function isRealSubagent(agent: SubagentLike | null | undefined): boolean {
  return String(agent?.id || '').includes(':sub:');
}

export function subagentView(
  agent: SubagentLike | null | undefined,
  opts: SubagentViewOpts = {},
): Subagent {
  const now = opts.now ?? Date.now();
  const stuckAfterMs = opts.stuckAfterMs ?? resolveStuckAfterMs();
  const status = subagentStatus(agent, now, stuckAfterMs);
  const action = agent?.currentAction == null ? '' : String(agent.currentAction);
  const currentAction = (status === 'running' || status === 'stuck') && action ? action : null;
  return {
    id: String(agent?.id ?? ''),
    parentConversationId: parentIdOf(agent, opts.parentConversationId),
    title: subagentSummary(agent),
    name: String(agent?.name ?? '').trim(),
    mode: agent?.mode === 'background' ? 'background' : 'foreground',
    status,
    startedAt: asTs(agent?.startedAt),
    lastActivityAt: asTs(agent?.lastActivityAt),
    endedAt: asTs(agent?.endedAt),
    currentAction,
    progress: progressOf(agent),
  };
}

export function subagentViews(
  agents: SubagentLike[] | null | undefined,
  opts: SubagentViewOpts = {},
): Subagent[] {
  return (agents || [])
    .filter((agent) => isRealSubagent(agent))
    .map((agent) => subagentView(agent, opts));
}

export type SubagentSnapshotInput = {
  presented?: PresentedConversation | null;
  agent: SubagentLike;
  messages?: ThreadMessage[] | null;
  lang?: 'zh' | 'en';
  now?: number;
  stuckAfterMs?: number;
  exists?: (rel: string) => boolean | Promise<boolean>;
};

/** Full snapshot for GET /api/v2/conversations/{id}/subagents/{agentId}. */
export async function subagentSnapshot({
  presented,
  agent,
  messages = [],
  lang = 'zh',
  now,
  stuckAfterMs,
  exists,
}: SubagentSnapshotInput): Promise<SubagentSnapshot> {
  const view = subagentView(agent, {
    parentConversationId: presented?.id == null ? undefined : String(presented.id),
    now,
    stuckAfterMs,
  });
  const workspacePath = presented?.workspacePath == null ? '' : String(presented.workspacePath);
  const thread = await buildThread(messages, {
    lang,
    workspacePath,
    subagents: [],
    running: view.status === 'running' || view.status === 'stuck',
    exists: exists || (workspacePath ? (rel) => fileExistsInWorkspace(workspacePath, rel) : undefined),
  });
  return { subagent: view, items: thread.items, tools: thread.tools };
}
