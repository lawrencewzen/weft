import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Lang } from './lang';
import { createStream, type StreamStatus } from './stream';
import {
  createEntityStore,
  sessionTopics,
  type EntityStore,
} from './store';

export type SessionSubagent = { conversationId: string; agentId: string };

export type SessionValue = {
  store: EntityStore;
  status: StreamStatus;
  conversationId: string | null;
  lang: Lang;
  extraConversationIds: string[];
  setExtraConversationIds: (ids: string[] | ((prev: string[]) => string[])) => void;
  retainTopic: (topic: string) => void;
  releaseTopic: (topic: string) => void;
  topics: string[];
};

export const SessionContext = createContext<SessionValue | null>(null);

type Props = {
  conversationId?: string | null;
  subagent?: SessionSubagent | null;
  lang: Lang;
  children: ReactNode;
};

export function SessionProvider({
  conversationId = null,
  subagent = null,
  lang,
  children,
}: Props) {
  const store = useMemo(() => createEntityStore(), []);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [extraConversationIds, setExtraConversationIdsState] = useState<string[]>([]);
  const extraTopicCounts = useRef(new Map<string, number>());
  const [extraTopics, setExtraTopics] = useState<string[]>([]);
  const stream = useMemo(() => createStream({
    onStatus: setStatus,
    onSnapshot: (event) => store.applySnapshot(event),
    onUpsert: (event) => store.applyUpsert(event),
    onRemove: (event) => store.applyRemove(event),
    onTextDelta: (event) => store.applyTextDelta(event),
    onToolDelta: (event) => store.applyToolDelta(event),
  }), [store]);

  const setExtraConversationIds = useCallback((ids: string[] | ((prev: string[]) => string[])) => {
    setExtraConversationIdsState((prev) => (typeof ids === 'function' ? ids(prev) : ids));
  }, []);

  const retainTopic = useCallback((topic: string) => {
    if (!topic) return;
    const next = (extraTopicCounts.current.get(topic) || 0) + 1;
    extraTopicCounts.current.set(topic, next);
    if (next === 1) {
      setExtraTopics((prev) => (prev.includes(topic) ? prev : [...prev, topic].sort()));
    }
  }, []);

  const releaseTopic = useCallback((topic: string) => {
    const current = extraTopicCounts.current.get(topic) || 0;
    if (current <= 1) {
      extraTopicCounts.current.delete(topic);
      setExtraTopics((prev) => prev.filter((item) => item !== topic));
      return;
    }
    extraTopicCounts.current.set(topic, current - 1);
  }, []);

  const topics = useMemo(
    () => sessionTopics({ conversationId, extraConversationIds, extraTopics, subagent }),
    [conversationId, extraConversationIds, extraTopics, subagent],
  );

  useEffect(() => {
    store.retainTopics(topics);
    stream.connect(topics, lang);
  }, [stream, store, topics, lang]);

  useEffect(() => () => stream.disconnect(), [stream]);

  const value = useMemo<SessionValue>(
    () => ({
      store,
      status,
      conversationId,
      lang,
      extraConversationIds,
      setExtraConversationIds,
      retainTopic,
      releaseTopic,
      topics,
    }),
    [store, status, conversationId, lang, extraConversationIds, setExtraConversationIds, retainTopic, releaseTopic, topics],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession requires SessionProvider');
  return ctx;
}
