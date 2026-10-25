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
    const n = Number(conv.runningAgents) || 0;
    return {
      text: n > 1 ? t(lang, 'agents_running_count', { n }) : t(lang, 'status_running'),
      cls: 'is-running',
    };
  }
  if (st === 'waiting') return { text: t(lang, 'status_waiting'), cls: 'is-waiting' };
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

export function pickDraftWorkspace(
  workspaces: Workspace[],
  savedId: string | null,
): Workspace | undefined {
  if (!workspaces.length) return undefined;
  return workspaces.find((ws) => ws.id === savedId) || workspaces[0];
}
