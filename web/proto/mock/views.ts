import type { Entity } from './hub';
import { tr, type ConversationSummary, type EntityValue, type Lang, type MockConv, type MockDb, type MockGroup, type MockItem, type MockTool, type Subagent, type ToolCall } from './types';

const LIVE_SUBAGENT_STATUS = new Set<Subagent['status']>(['running', 'stuck', 'waiting']);

export function liveSubagentCount(agents: readonly Subagent[]): number {
  return agents.filter((agent) => LIVE_SUBAGENT_STATUS.has(agent.status)).length;
}

export type TopicEntities = Entity[];

export function summaryOf(conv: MockConv): ConversationSummary {
  const view = conv.view;
  const live = liveSubagentCount(conv.subagents);
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    title: view.title,
    updatedAt: view.updatedAt,
    status: view.status,
    runningAgents: (view.status === 'running' ? 1 : 0) + live,
    subagents: conv.subagents.length ? { total: conv.subagents.length, live } : null,
    archived: false,
  };
}

function workspaceValue(ws: MockDb['workspaces'][number], rows: MockConv[]): object {
  return {
    ...ws,
    conversationCount: rows.length,
    runningCount: rows.filter((conv) => conv.view.status === 'running').length,
  };
}

export function workspacesEntities(db: MockDb): TopicEntities {
  const out: TopicEntities = [];
  for (const ws of db.workspaces) {
    const rows = [...db.conversations.values()].filter((conv) => conv.view.workspaceId === ws.id);
    out.push({ entity: 'workspace', id: ws.id, value: workspaceValue(ws, rows) });
    for (const conv of rows) {
      out.push({ entity: 'conversation_summary', id: conv.view.id, value: summaryOf(conv) });
    }
  }
  return out;
}

export function providersEntities(db: MockDb): TopicEntities {
  const out: TopicEntities = db.providers.map((provider) => ({
    entity: 'provider',
    id: provider.id,
    value: provider as unknown as object,
  }));
  out.push({ entity: 'defaults', id: 'self', value: { model: db.defaultModel } });
  return out;
}

export function extensionsEntities(db: MockDb): TopicEntities {
  const out: TopicEntities = [];
  for (const plugin of db.plugins) out.push({ entity: 'plugin', id: plugin.id, value: plugin as unknown as object });
  for (const skill of db.skills) out.push({ entity: 'skill', id: skill.id, value: skill as unknown as object });
  for (const conn of db.gitConnections) {
    out.push({ entity: 'git_connection', id: conn.id, value: conn as unknown as object });
  }
  return out;
}

export function conversationValue(conv: MockConv): EntityValue {
  return (lang: Lang) => ({
    ...conv.view,
    run: {
      ...conv.view.run,
      pendingText: conv.view.run.status === 'running' && conv.pending ? tr(conv.pending, lang) : null,
    },
  });
}

export function itemValue(item: MockItem): EntityValue {
  if (item.kind !== 'tool_group') return item as unknown as object;
  return toolGroupValue(item);
}

function toolGroupValue(item: MockGroup): EntityValue {
  return (lang: Lang) => ({
    kind: 'tool_group',
    id: item.id,
    toolIds: item.toolIds,
    summary: { text: tr(item.summary, lang), failed: item.failed, running: item.running },
    live: item.live,
  });
}

function groupIdOf(conv: MockConv, toolId: string): string {
  for (const item of conv.items) {
    if (item.kind === 'tool_group' && item.toolIds.includes(toolId)) return item.id;
  }
  return `group:${toolId}`;
}

export function toolValue(tool: MockTool, groupId: string): EntityValue {
  return (lang: Lang) => {
    const call: ToolCall = {
      id: tool.id,
      groupId,
      kind: tool.kind,
      status: tool.status,
      heading: {
        title: tr(tool.title, lang),
        detail: tool.detail ? tr(tool.detail, lang) : '',
        fromIntent: tool.fromIntent,
      },
      ...(tool.path ? { path: tool.path } : {}),
      hint: { text: tr(tool.hint, lang), failed: tool.hintFailed },
      failure: tool.failure,
      diff: tool.diff,
      ...(tool.exitCode == null ? {} : { exitCode: tool.exitCode }),
      output: {
        preview: tool.preview,
        truncated: tool.truncated,
        totalLines: tool.totalLines,
      },
    };
    return call as unknown as object;
  };
}

export function conversationEntities(conv: MockConv): TopicEntities {
  const out: TopicEntities = [
    { entity: 'conversation', id: conv.view.id, value: conversationValue(conv) },
  ];
  for (const item of conv.items) {
    out.push({ entity: 'item', id: item.id, value: itemValue(item) });
  }
  for (const tool of Object.values(conv.tools)) {
    out.push({ entity: 'tool', id: tool.id, value: toolValue(tool, groupIdOf(conv, tool.id)) });
  }
  for (const agent of conv.subagents) {
    out.push({ entity: 'subagent', id: agent.id, value: agent as unknown as object });
  }
  for (const change of conv.changes) {
    out.push({ entity: 'change', id: change.path, value: change as unknown as object });
  }
  return out;
}

export function conversationGroupId(conv: MockConv, toolId: string): string {
  return groupIdOf(conv, toolId);
}
