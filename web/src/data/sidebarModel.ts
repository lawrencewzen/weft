import type { Lang } from './lang';
import { t } from '../i18n';
import { formatRelativeTime } from './relativeTime';
import type { ConversationSummary, Workspace } from './store';

export type WorkspaceGroup = {
  workspace: Workspace;
  conversations: ConversationSummary[];
};

export type ConversationMeta = {
  text: string;
  cls: string;
  ts?: number;
};

export function sortConversations(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort(
    (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || a.id.localeCompare(b.id),
  );
}

export function groupWorkspaces(
  workspaces: Workspace[],
  conversations: ConversationSummary[],
): WorkspaceGroup[] {
  return workspaces.map((workspace) => ({
    workspace,
    conversations: sortConversations(
      conversations.filter((conv) => conv.workspaceId === workspace.id && !conv.archived),
    ),
  }));
}

export function latestConversation(conversations: ConversationSummary[]): ConversationSummary | undefined {
  const live = conversations.filter((conv) => !conv.archived);
  if (!live.length) return undefined;
  return sortConversations(live)[0];
}

export function conversationStatusKind(status: string | undefined): 'running' | 'waiting' | 'failed' | '' {
  if (status === 'running') return 'running';
  if (status === 'waiting') return 'waiting';
  if (status === 'failed') return 'failed';
  return '';
}

export function conversationMeta(
  conv: ConversationSummary,
  lang: Lang,
  now = Date.now(),
): ConversationMeta {
  const st = conv.status || 'idle';
  if (st === 'running') {
    return { text: t(lang, 'status_running'), cls: 'is-running' };
  }
  if (st === 'waiting') return { text: t(lang, 'sidebar_status_waiting'), cls: 'is-waiting' };
  if (st === 'failed') return { text: t(lang, 'status_failed'), cls: 'is-failed' };
  return {
    text: conv.updatedAt ? formatRelativeTime(lang, conv.updatedAt, now) : '',
    cls: '',
    ts: conv.updatedAt,
  };
}

export function runningCount(conversations: ConversationSummary[]): number {
  return conversations.filter((conv) => conv.status === 'running').length;
}

export type OpenRecord = Record<string, boolean>;

const LIVE_TREE_STATUSES = new Set(['running', 'stuck', 'waiting']);

export function recordedFlag(record: OpenRecord, id: string): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, id)) return undefined;
  return record[id];
}

/** No record: current workspace expanded, others collapsed. */
export function workspaceIsOpen(wsId: string, isActive: boolean, record: OpenRecord): boolean {
  const explicit = recordedFlag(record, wsId);
  if (explicit !== undefined) return explicit;
  return isActive;
}

export function toggleOpenRecord(record: OpenRecord, id: string, currentlyOpen: boolean): OpenRecord {
  return { ...record, [id]: !currentlyOpen };
}

export function setOpenRecord(record: OpenRecord, id: string, open: boolean): OpenRecord {
  if (record[id] === open) return record;
  return { ...record, [id]: open };
}

export function deleteOpenRecord(record: OpenRecord, id: string): OpenRecord {
  if (!Object.prototype.hasOwnProperty.call(record, id)) return record;
  const next = { ...record };
  delete next[id];
  return next;
}

export function hasLiveSubagents(
  counts: { live?: number; total?: number } | null | undefined,
  agents: Array<{ status: string }> = [],
): boolean {
  if (agents.length) {
    return agents.some((agent) => LIVE_TREE_STATUSES.has(agent.status));
  }
  return (Number(counts?.live) || 0) > 0;
}

/** No record: expand when any sub-agent is live, collapse when all have ended. */
export function subagentTreeIsOpen(convId: string, record: OpenRecord, live: boolean): boolean {
  const explicit = recordedFlag(record, convId);
  if (explicit !== undefined) return explicit;
  return live;
}

export function pickDraftWorkspace(
  workspaces: Workspace[],
  savedId: string | null,
): Workspace | undefined {
  if (!workspaces.length) return undefined;
  return workspaces.find((ws) => ws.id === savedId) || workspaces[0];
}
