import { useCallback, useMemo } from 'react';
import { sendSubagentMessage, stopSubagent, toolOutput } from './api';
import { useSession } from './session';
import {
  subagentTopic,
  type Subagent,
  type ThreadItem,
  type ToolCall,
} from './store';
import { useStoreTopic } from './useStoreTopic';
import type { ConversationActions } from './useConversation';

export type SubagentState = {
  subagent: Subagent | undefined;
  items: ThreadItem[];
  toolsById: Record<string, ToolCall>;
  missing: boolean;
  lastAssistantText: string;
  actions: ConversationActions;
};

const noopContinue = () => Promise.resolve({ runId: '' });

export function useSubagent(cid: string, agentId: string): SubagentState {
  const { store } = useSession();
  const topic = subagentTopic(cid, agentId);
  useStoreTopic(store, topic);
  const subagent = store.subagent(cid, agentId);
  const items = store.topicItems(topic);
  const toolsById = store.toolsByTopic(topic);
  const missing = store.isMissing(topic);
  const lastAssistantText = store.lastAssistantText(topic);

  const send = useCallback((text: string, _requestId?: string) => (
    sendSubagentMessage(cid, agentId, text)
  ), [cid, agentId]);
  const stop = useCallback(() => stopSubagent(cid, agentId), [cid, agentId]);
  const loadToolOutput = useCallback((toolId: string) => toolOutput(cid, toolId), [cid]);

  const actions = useMemo<ConversationActions>(
    () => ({
      send,
      stop,
      continueRun: noopContinue,
      loadToolOutput,
      withdraw: () => Promise.resolve({ ok: true as const }),
    }),
    [send, stop, loadToolOutput],
  );

  return { subagent, items, toolsById, missing, lastAssistantText, actions };
}
