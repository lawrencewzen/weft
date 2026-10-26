import { useEffect, useSyncExternalStore } from 'react';
import { useSession } from './session';
import {
  EXTENSIONS_TOPIC,
  type GitConnection,
  type Plugin,
  type Skill,
} from './store';

export type ExtensionsState = {
  plugins: Plugin[];
  skills: Skill[];
  gitConnections: GitConnection[];
  ready: boolean;
  status: ReturnType<typeof useSession>['status'];
};

export function useExtensions(): ExtensionsState {
  const { store, status, retainTopic, releaseTopic } = useSession();
  useSyncExternalStore(store.subscribe, store.getVersion);
  useEffect(() => {
    retainTopic(EXTENSIONS_TOPIC);
    return () => releaseTopic(EXTENSIONS_TOPIC);
  }, [retainTopic, releaseTopic]);
  return {
    plugins: store.plugins(),
    skills: store.skills(),
    gitConnections: store.gitConnections(),
    ready: store.hasTopic(EXTENSIONS_TOPIC),
    status,
  };
}
