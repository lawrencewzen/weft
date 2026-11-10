import type { components } from '../../../src/v2/contract.gen';
import type { ThreadItem } from './store';

export type { ThreadItem };

export type ToolCall = components['schemas']['ToolCall'];
export type AskQuestion = components['schemas']['AskQuestion'];
export type AskSelection = components['schemas']['AskSelection'];

export function findPendingAsk(
  items: ThreadItem[],
  toolsById: Record<string, ToolCall>,
): ToolCall | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'tool_group') {
      for (let j = item.toolIds.length - 1; j >= 0; j--) {
        const id = item.toolIds[j];
        const tool = toolsById[id];
        if (tool && tool.kind === 'ask' && tool.ask && tool.ask.answer === null && tool.failure !== 'real') {
          return tool;
        }
      }
    }
  }
  return null;
}

export function askDraftStorageKey(cid: string, toolId: string): string {
  return `weft:ask:${cid}:${toolId}`;
}
