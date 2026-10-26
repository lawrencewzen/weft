import { useEffect, useMemo, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { getProviders } from './api';
import { useSession } from './session';
import { PROVIDERS_TOPIC, type Provider, type ResolvedModel, type Vendor } from './store';
import { withGrokVendor } from './providerWizard';

export type ProvidersState = {
  providers: Provider[];
  defaultModel: ResolvedModel | null;
  vendors: Vendor[];
  ready: boolean;
  status: ReturnType<typeof useSession>['status'];
};

export function useProviders(): ProvidersState {
  const { store, status, lang } = useSession();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const providers = store.providers();
  const defaultModel = store.defaultModel();
  const ready = store.hasTopic(PROVIDERS_TOPIC);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  useEffect(() => {
    let cancelled = false;
    getProviders(lang).then((snap) => {
      if (cancelled) return;
      setVendors(withGrokVendor(snap.vendors || []));
    }).catch(() => {
      if (!cancelled) setVendors(withGrokVendor([]));
    });
    return () => {
      cancelled = true;
    };
  }, [lang, ready]);

  const mergedVendors = useMemo(() => withGrokVendor(vendors), [vendors]);

  return { providers, defaultModel, vendors: mergedVendors, ready, status };
}
