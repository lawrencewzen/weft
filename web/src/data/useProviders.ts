import { useSyncExternalStore } from 'react';
import { useSession } from './session';
import { PROVIDERS_TOPIC, type Provider, type ResolvedModel } from './store';

export type ProvidersState = {
  providers: Provider[];
  defaultModel: ResolvedModel | null;
  ready: boolean;
  status: ReturnType<typeof useSession>['status'];
};

export function useProviders(): ProvidersState {
  const { store, status } = useSession();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const providers = store.providers();
  const defaultModel = store.defaultModel();
  const ready = store.hasTopic(PROVIDERS_TOPIC);

  return { providers, defaultModel, ready, status };
}
