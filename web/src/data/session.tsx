import {
  createContext,
  useContext,
  useEffect,
  useMemo,
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

export type SessionValue = {
  store: EntityStore;
  status: StreamStatus;
  conversationId: string | null;
  lang: Lang;
};

const SessionContext = createContext<SessionValue | null>(null);

type Props = {
  conversationId?: string | null;
  lang: Lang;
  children: ReactNode;
};

export function SessionProvider({ conversationId = null, lang, children }: Props) {
  const store = useMemo(() => createEntityStore(), []);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const stream = useMemo(() => createStream({
    onStatus: setStatus,
    onSnapshot: (event) => store.applySnapshot(event),
    onUpsert: (event) => store.applyUpsert(event),
    onRemove: (event) => store.applyRemove(event),
    onTextDelta: (event) => store.applyTextDelta(event),
  }), [store]);

  useEffect(() => {
    stream.connect(sessionTopics(conversationId), lang);
  }, [stream, conversationId, lang]);

  useEffect(() => () => stream.disconnect(), [stream]);

  const value = useMemo<SessionValue>(
    () => ({ store, status, conversationId, lang }),
    [store, status, conversationId, lang],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession requires SessionProvider');
  return ctx;
}
