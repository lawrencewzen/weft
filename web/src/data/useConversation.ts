import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { continueRun as continueRunApi, sendMessage, stop as stopApi, toolOutput } from './api';
import { getPreferredLang, type Lang } from './lang';
import { createStream, type StreamStatus } from './stream';
import {
  conversationTopic,
  createEntityStore,
  type ConversationView,
  type ThreadItem,
  type ToolCall,
} from './store';

export type ConversationActions = {
  send: (text: string) => ReturnType<typeof sendMessage>;
  stop: () => ReturnType<typeof stopApi>;
  continueRun: () => ReturnType<typeof continueRunApi>;
  loadToolOutput: (toolId: string) => ReturnType<typeof toolOutput>;
};

export type ConversationState = {
  conversation: ConversationView | undefined;
  items: ThreadItem[];
  toolsById: Record<string, ToolCall>;
  status: StreamStatus;
  missing: boolean;
  actions: ConversationActions;
};

export function useConversation(cid: string, lang: Lang = getPreferredLang()): ConversationState {
  const store = useMemo(() => createEntityStore(), [cid]);
  useSyncExternalStore(store.subscribe, store.getVersion);
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    setStatus('connecting');
    const stream = createStream({
      onStatus: setStatus,
      onSnapshot: (event) => store.applySnapshot(event),
      onUpsert: (event) => store.applyUpsert(event),
      onRemove: (event) => store.applyRemove(event),
      onTextDelta: (event) => store.applyTextDelta(event),
    });
    stream.connect(['service', conversationTopic(cid)], lang);
    return () => stream.disconnect();
  }, [cid, lang, store]);

  const conversation = store.conversation(cid);
  const items = store.items(cid);
  const toolsById = store.toolsById(cid);
  const missing = store.isMissing(conversationTopic(cid));

  const send = useCallback((text: string) => sendMessage(cid, text), [cid]);
  const stop = useCallback(() => stopApi(cid), [cid]);
  const continueRun = useCallback(() => continueRunApi(cid), [cid]);
  const loadToolOutput = useCallback((toolId: string) => toolOutput(cid, toolId), [cid]);

  const actions = useMemo(
    () => ({ send, stop, continueRun, loadToolOutput }),
    [send, stop, continueRun, loadToolOutput],
  );

  return { conversation, items, toolsById, status, missing, actions };
}
