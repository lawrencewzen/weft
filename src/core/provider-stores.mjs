import { operationSignal, raceWithAbortSignal } from '@earendil-works/pi-ai/utils/abort';

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value;
}

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

/**
 * Serialize tasks per provider id, matching pi-ai's InMemoryCredentialStore:
 * wait for the previous task, then run, and let an abort cancel the wait.
 */
function createProviderQueue() {
  const chains = new Map();
  return function enqueue(providerId, task, options) {
    const signal = operationSignal(options?.signal);
    const previous = chains.get(providerId) ?? Promise.resolve();
    const queued = (async () => {
      await previous.catch(() => {});
      signal.throwIfAborted();
      return task();
    })();
    const tail = queued.catch(() => {});
    chains.set(providerId, tail);
    void tail.then(() => {
      if (chains.get(providerId) === tail) chains.delete(providerId);
    });
    return raceWithAbortSignal(queued, signal);
  };
}

/** pi-ai CredentialStore on the app sqlite store. */
export function createCredentialStore(store) {
  const enqueue = createProviderQueue();

  return {
    async read(providerId, options) {
      throwIfAborted(options?.signal);
      return asRecord(await store.getProviderCredential(providerId));
    },

    async list(options) {
      throwIfAborted(options?.signal);
      const rows = await store.listProviderCredentials();
      const out = [];
      for (const row of rows) {
        const credential = asRecord(row.credential);
        if (!credential || typeof credential.type !== 'string') continue;
        out.push({ providerId: row.providerId, type: credential.type });
      }
      return out;
    },

    modify(providerId, fn, options) {
      return enqueue(providerId, async () => {
        const current = asRecord(await store.getProviderCredential(providerId));
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        // pi-ai 1.3.0: undefined leaves the row unchanged; delete() removes it.
        if (next !== undefined) await store.putProviderCredential(providerId, next);
        return next ?? current;
      }, options);
    },

    delete(providerId, options) {
      return enqueue(providerId, async () => {
        await store.deleteProviderCredential(providerId);
      }, options);
    },
  };
}

/** pi-ai ModelsStore on the app sqlite store. */
export function createModelsStore(store) {
  return {
    async read(providerId, options) {
      throwIfAborted(options?.signal);
      return asRecord(await store.getProviderModels(providerId));
    },

    async write(providerId, entry, options) {
      throwIfAborted(options?.signal);
      await store.putProviderModels(providerId, entry);
    },

    async delete(providerId, options) {
      throwIfAborted(options?.signal);
      await store.deleteProviderModels(providerId);
    },
  };
}
