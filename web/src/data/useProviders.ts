import { useSession } from './session';
import { PROVIDERS_TOPIC, type Provider, type ResolvedModel } from './store';
import { useStoreTopic } from './useStoreTopic';

export type ProvidersState = {
  providers: Provider[];
  defaultModel: ResolvedModel | null;
  ready: boolean;
  status: ReturnType<typeof useSession>['status'];
};

export function useProviders(): ProvidersState {
  const { store, status } = useSession();
  useStoreTopic(store, PROVIDERS_TOPIC);
  const providers = store.providers();
  const defaultModel = store.defaultModel();
  const ready = store.hasTopic(PROVIDERS_TOPIC);

  return { providers, defaultModel, ready, status };
}
