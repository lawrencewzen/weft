import type { Subagent } from './store';

export type DispatchMatch = {
  subagents: Subagent[];
  allDispatch: boolean;
};

/**
 * Match a tool group's toolIds against a conversation's subagents.
 *
 * Returns null if no subagents were dispatched by this group.
 * If all tools in the group are dispatch tools (i.e. every toolId corresponds
 * to at least one dispatched subagent), allDispatch is true (the card replaces
 * the tool group). Otherwise, allDispatch is false (mixed group: card is shown
 * underneath the tool group).
 */
export function matchDispatchSubagents(
  groupOrToolIds: { toolIds: readonly string[] } | readonly string[] | null | undefined,
  subagents: readonly Subagent[] | null | undefined,
): DispatchMatch | null {
  if (!groupOrToolIds || !subagents) return null;
  const toolIds: readonly string[] = Array.isArray(groupOrToolIds)
    ? groupOrToolIds
    : 'toolIds' in groupOrToolIds
      ? groupOrToolIds.toolIds
      : [];
  if (!toolIds || toolIds.length === 0 || subagents.length === 0) return null;

  const toolIdSet = new Set(toolIds);
  const matchedToolIds = new Set<string>();

  const matched: Subagent[] = [];
  for (const agent of subagents) {
    if (agent.toolCallId && toolIdSet.has(agent.toolCallId)) {
      matched.push(agent);
      matchedToolIds.add(agent.toolCallId);
    }
  }

  if (matched.length === 0) return null;

  // Order matching subagents according to toolIds dispatch order
  const toolOrder = new Map<string, number>();
  toolIds.forEach((id: string, idx: number) => {
    if (!toolOrder.has(id)) toolOrder.set(id, idx);
  });

  matched.sort((a, b) => {
    const orderA = toolOrder.get(a.toolCallId!) ?? 0;
    const orderB = toolOrder.get(b.toolCallId!) ?? 0;
    return orderA - orderB;
  });

  const allDispatch = toolIds.every((id: string) => matchedToolIds.has(id));

  return { subagents: matched, allDispatch };
}
