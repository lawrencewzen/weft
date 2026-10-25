import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  continueRun as continueRunApi,
  createConversation,
  sendMessage,
  stop as stopApi,
  toolOutput,
} from './api';
import { navigate, conversationPath } from './nav';
import { useSession } from './session';
import {
  conversationTopic,
  type ConversationView,
  type ThreadItem,
  type ToolCall,
} from './store';

export type ConversationActions = {
  send: (text: string, requestId?: string) => Promise<unknown>;
  stop: () => ReturnType<typeof stopApi>;
  continueRun: (requestId?: string) => ReturnType<typeof continueRunApi>;
  loadToolOutput: (toolId: string) => ReturnType<typeof toolOutput>;
};

export type ConversationState = {
  conversation: ConversationView | undefined;
  items: ThreadItem[];
  toolsById: Record<string, ToolCall>;
  status: ReturnType<typeof useSession>['status'];
  missing: boolean;
  actions: ConversationActions;
};

const noopStop = () => Promise.resolve({ stopping: true as const });
const noopContinue = () => Promise.resolve({ runId: '' });
const noopTool = () => Promise.resolve({
  id: '',
  text: '',
  totalLines: 0,
});

export function useConversation(cid: string | null | undefined): ConversationState {
  const { store, status } = useSession();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const id = cid || '';

  const conversation = id ? store.conversation(id) : undefined;
  const items = id ? store.items(id) : [];
  const toolsById = id ? store.toolsById(id) : {};
  const missing = Boolean(id) && store.isMissing(conversationTopic(id));

  const send = useCallback((text: string, requestId?: string) => sendMessage(id, text, requestId), [id]);
  const stop = useCallback(() => stopApi(id), [id]);
  const continueRun = useCallback((requestId?: string) => continueRunApi(id, requestId), [id]);
  const loadToolOutput = useCallback((toolId: string) => toolOutput(id, toolId), [id]);

  const actions = useMemo(
    () => ({ send, stop, continueRun, loadToolOutput }),
    [send, stop, continueRun, loadToolOutput],
  );

  return { conversation, items, toolsById, status, missing, actions };
}

export function useDraftSend(workspaceId: string | null | undefined): ConversationActions {
  const createdId = useRef<string | null>(null);
  const wsId = workspaceId || '';

  const send = useCallback(async (text: string, requestId?: string) => {
    if (!wsId) throw new Error('no workspace');
    if (!createdId.current) {
      const created = await createConversation(wsId);
      createdId.current = created.id;
    }
    const cid = createdId.current;
    await sendMessage(cid, text, requestId);
    navigate(conversationPath(cid));
  }, [wsId]);

  return useMemo(() => ({
    send,
    stop: noopStop,
    continueRun: noopContinue,
    loadToolOutput: noopTool,
  }), [send]);
}
