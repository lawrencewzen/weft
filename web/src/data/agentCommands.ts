import type { EntityStore, Subagent, ThreadItem, ToolCall } from './store';
import { conversationTopic, subagentTopic } from './store';

export type AgentCommand = {
  toolId: string;
  topic: string;
  title: string;
  ownerKind: 'main' | 'subagent';
  ownerName: string;
  status: ToolCall['status'];
  exitCode?: number;
  running: boolean;
};

function bashTitle(tool: ToolCall): string {
  return tool.heading.title || tool.heading.detail || tool.kind;
}

function pushBash(
  out: AgentCommand[],
  seen: Set<string>,
  tool: ToolCall | undefined,
  topic: string,
  ownerKind: AgentCommand['ownerKind'],
  ownerName: string,
): void {
  if (!tool || tool.kind !== 'bash' || seen.has(tool.id)) return;
  seen.add(tool.id);
  out.push({
    toolId: tool.id,
    topic,
    title: bashTitle(tool),
    ownerKind,
    ownerName,
    status: tool.status,
    exitCode: tool.exitCode,
    running: tool.status === 'running',
  });
}

function collectFromItems(
  items: ThreadItem[],
  tools: Record<string, ToolCall>,
  topic: string,
  ownerKind: AgentCommand['ownerKind'],
  ownerName: string,
  out: AgentCommand[],
  seen: Set<string>,
): void {
  for (const item of items) {
    if (item.kind !== 'tool_group') continue;
    for (const id of item.toolIds) {
      pushBash(out, seen, tools[id], topic, ownerKind, ownerName);
    }
  }
  for (const tool of Object.values(tools)) {
    pushBash(out, seen, tool, topic, ownerKind, ownerName);
  }
}

export function commandTopics(cid: string, agents: readonly Subagent[] = []): string[] {
  if (!cid) return [];
  const topics = [
    `${conversationTopic(cid)}#subagent`,
    `${conversationTopic(cid)}#tool`,
  ];
  for (const agent of agents) {
    const child = subagentTopic(cid, agent.id);
    topics.push(`${child}#item`, `${child}#tool`);
  }
  return topics;
}

/** Bash calls in this conversation: main agent first, then each sub-agent. */
export function agentCommands(store: EntityStore, cid: string, agents: Subagent[] = []): AgentCommand[] {
  if (!cid) return [];
  const out: AgentCommand[] = [];
  const seen = new Set<string>();
  const topic = conversationTopic(cid);
  collectFromItems(store.items(cid), store.toolsById(cid), topic, 'main', '', out, seen);
  for (const agent of agents) {
    const childTopic = subagentTopic(cid, agent.id);
    collectFromItems(
      store.topicItems(childTopic),
      store.toolsByTopic(childTopic),
      childTopic,
      'subagent',
      agent.title || agent.name || agent.id,
      out,
      seen,
    );
  }
  return out;
}
