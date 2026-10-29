import { useCallback, useSyncExternalStore } from 'react';
import type { EntityStore } from './store';

/**
 * Subscribe to a single store topic. Only triggers a re-render when the topic's version changes.
 */
export function useStoreTopic(store: EntityStore, topic: string | null | undefined): number {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!topic) return () => {};
      if (typeof store.subscribeTopic === 'function') {
        return store.subscribeTopic(topic, onStoreChange);
      }
      return store.subscribe(onStoreChange);
    },
    [store, topic],
  );
  const getSnapshot = useCallback(
    () => {
      if (!topic) return 0;
      if (typeof store.getTopicVersion === 'function') {
        return store.getTopicVersion(topic);
      }
      return store.getVersion();
    },
    [store, topic],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Subscribe to multiple store topics. Only triggers a re-render when any of the topics change.
 */
export function useStoreTopics(store: EntityStore, topics: readonly string[]): number {
  const topicsKey = topics.join('\0');
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (topics.length === 0) return () => {};
      if (typeof store.subscribeTopic === 'function') {
        const unsubs = topics.map((t) => store.subscribeTopic(t, onStoreChange));
        return () => {
          for (const un of unsubs) un();
        };
      }
      return store.subscribe(onStoreChange);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, topicsKey],
  );
  const getSnapshot = useCallback(
    () => {
      if (topics.length === 0) return 0;
      if (typeof store.getTopicVersion === 'function') {
        let sum = 0;
        for (const t of topics) sum += store.getTopicVersion(t);
        return sum;
      }
      return store.getVersion();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, topicsKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
