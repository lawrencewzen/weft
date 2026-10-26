/** Load a child agent without reading the parent conversation transcript. */

import type { LoadSubagent } from './stream/subagent-topic.ts';
import type { SubagentLike } from './views/subagents.ts';
import type { ThreadMessage } from './views/thread.ts';

export type SubagentStoreRow = {
  id?: unknown;
  workspacePath?: unknown;
};

export type LoadSubagentDeps = {
  getConversation: (id: string) => Promise<SubagentStoreRow | null | undefined>;
  listSubagents: (conv: SubagentStoreRow) => Promise<SubagentLike[]>;
  childMessages: (cid: string, agentId: string) => Promise<{
    status: number;
    body?: { messages?: ThreadMessage[] | null } | null;
  }>;
};

/**
 * Workspace path comes from the store conversation row. Child roster comes from
 * `listSubagents(row)`. This does not call `present()` and does not read the
 * parent transcript.
 */
export async function loadSubagentFromStore(
  deps: LoadSubagentDeps,
  cid: string,
  agentId: string,
): ReturnType<LoadSubagent> {
  const conv = await deps.getConversation(cid);
  if (!conv) return null;
  const subagents = await deps.listSubagents(conv);
  const agent = subagents.find((item) => item.id === agentId);
  if (!agent) return null;
  const child = await deps.childMessages(cid, agentId);
  if (child.status !== 200) return null;
  return {
    presented: {
      id: conv.id,
      workspacePath: conv.workspacePath,
    },
    agent,
    messages: Array.isArray(child.body?.messages) ? child.body.messages : [],
  };
}
