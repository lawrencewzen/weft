/**
 * Sidebar view models: Workspace and ConversationSummary.
 * Status buckets match views/run.ts conversationStatus (ARCHITECTURE_V2.md §6.1).
 * runningAgents matches public/app.js conversationMeta "N 个 Agent 运行中":
 * main agent running counts as 1, plus live sub-agents from subagentDigests.
 */

import type { components } from '../contract.gen.ts';
import { conversationStatus } from './run.ts';

export type Workspace = components['schemas']['Workspace'];
export type ConversationSummary = components['schemas']['ConversationSummary'];
export type WorkspacesSnapshot = components['schemas']['WorkspacesSnapshot'];
export type SubagentCounts = components['schemas']['SubagentCounts'];

export type SidebarConv = {
  id?: unknown;
  workspaceId?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  archived?: unknown;
  [key: string]: unknown;
};

export type SidebarWorkspace = {
  id?: unknown;
  name?: unknown;
  path?: unknown;
  source?: unknown;
  [key: string]: unknown;
};

export type SubagentDigest = {
  total?: unknown;
  live?: unknown;
} | null | undefined;

export type SidebarLoader = {
  listWorkspaces: () => Promise<SidebarWorkspace[]>;
  listConversations: (workspaceId: string) => Promise<SidebarConv[]>;
  statusOf: (conv: SidebarConv) => Promise<unknown>;
  subagentDigests: (convs: SidebarConv[]) => Promise<Map<string, { total: number; live: number }>>;
};

function asId(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

function asUpdatedAt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function workspaceSource(source: unknown): Workspace['source'] {
  return source === 'git' ? 'git' : 'local';
}

export function conversationSummaryView(input: {
  conv: SidebarConv;
  status?: unknown;
  digest?: SubagentDigest;
  archived?: boolean;
}): ConversationSummary {
  const status = conversationStatus(input.status);
  const total = Math.max(0, Math.trunc(Number(input.digest?.total) || 0));
  const live = Math.max(0, Math.trunc(Number(input.digest?.live) || 0));
  const runningAgents = (status === 'running' ? 1 : 0) + live;
  const archived = input.archived ?? Boolean(input.conv.archived);
  return {
    id: asId(input.conv.id),
    workspaceId: asId(input.conv.workspaceId),
    title: input.conv.title == null ? '' : String(input.conv.title),
    updatedAt: asUpdatedAt(input.conv.updatedAt),
    status,
    runningAgents,
    subagents: total > 0 ? { total, live } : null,
    archived,
  };
}

export function workspaceView(input: {
  workspace: SidebarWorkspace;
  conversations: ConversationSummary[];
}): Workspace {
  const conversations = input.conversations;
  return {
    id: asId(input.workspace.id),
    name: input.workspace.name == null ? '' : String(input.workspace.name),
    path: input.workspace.path == null ? '' : String(input.workspace.path),
    source: workspaceSource(input.workspace.source),
    conversationCount: conversations.length,
    runningCount: conversations.filter((row) => row.status === 'running').length,
  };
}

export async function buildWorkspacesSnapshot(loader: SidebarLoader): Promise<WorkspacesSnapshot> {
  const workspaces: Workspace[] = [];
  const conversations: ConversationSummary[] = [];
  const rows = await loader.listWorkspaces();
  for (const ws of rows) {
    const id = asId(ws.id);
    const convs = id ? await loader.listConversations(id) : [];
    const digests = convs.length ? await loader.subagentDigests(convs) : new Map();
    const statuses = await Promise.all(convs.map((conv) => loader.statusOf(conv)));
    const summaries = convs.map((conv, i) => {
      const cid = conv.id == null ? '' : String(conv.id);
      return conversationSummaryView({
        conv,
        status: statuses[i],
        digest: cid ? digests.get(cid) : undefined,
      });
    });
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    workspaces.push(workspaceView({ workspace: ws, conversations: summaries }));
    conversations.push(...summaries);
  }
  return { workspaces, conversations };
}
