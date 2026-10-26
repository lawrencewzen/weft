/** Live `providers` topic: snapshot + upserts of Provider and defaults. */

import type { Lang } from '../phrases/index.ts';
import {
  providersSnapshot,
  type Provider,
  type ProviderDefaults,
  type ProvidersSnapshot,
  type ResolvedModel,
  type SettingsLike,
} from '../views/providers.ts';
import { normalizeLang, type Entity, type EventHub } from './hub.ts';

export const PROVIDERS_TOPIC = 'providers';

export type ProvidersLoader = {
  getSettings?: () => Promise<SettingsLike | null | undefined>;
  grokSignedIn?: () => Promise<boolean>;
};

export type ProvidersTopicOpts = {
  loader?: ProvidersLoader;
  log?: (line: string) => void;
};

type EntityKey = string;

export type ProvidersTopic = {
  notify(): void;
  subscriberActive(): boolean;
  dispose(): void;
};

function entityKey(entity: string, id: string): EntityKey {
  return `${entity}\t${id}`;
}

function parseKey(key: EntityKey): { entity: string; id: string } {
  const tab = key.indexOf('\t');
  if (tab < 0) return { entity: key, id: '' };
  return { entity: key.slice(0, tab), id: key.slice(tab + 1) };
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function entitiesFromSnapshot(snap: ProvidersSnapshot): Entity[] {
  const out: Entity[] = [];
  for (const provider of snap.providers) {
    out.push({ entity: 'provider', id: provider.id, value: provider });
  }
  const defaults: ProviderDefaults = { model: snap.defaultModel };
  out.push({ entity: 'defaults', id: 'self', value: defaults });
  return out;
}

function mapsFromSnapshot(snap: ProvidersSnapshot): Map<EntityKey, object> {
  const map = new Map<EntityKey, object>();
  for (const provider of snap.providers) map.set(entityKey('provider', provider.id), provider);
  map.set(entityKey('defaults', 'self'), { model: snap.defaultModel } satisfies ProviderDefaults);
  return map;
}

export function attachProvidersTopic(hub: EventHub, opts: ProvidersTopicOpts = {}): ProvidersTopic {
  const log = opts.log ?? ((line: string) => {
    console.log(line);
  });
  let lastZh = new Map<EntityKey, object>();
  let lastEn = new Map<EntityKey, object>();
  let unsubLog = false;
  let active = false;
  let disposed = false;
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = tail.then(fn, fn) as Promise<T>;
    tail = run.then(() => {}, () => {});
    return run;
  }

  async function loadSnapshot(lang: Lang): Promise<ProvidersSnapshot> {
    const settings = opts.loader?.getSettings ? await opts.loader.getSettings() : null;
    const grokSignedIn = opts.loader?.grokSignedIn ? await opts.loader.grokSignedIn() : false;
    return providersSnapshot({ settings, grokSignedIn, lang });
  }

  function publishRemove(entity: string, id: string): void {
    hub.publish(PROVIDERS_TOPIC, { event: 'remove', entity, id });
  }

  function publishUpsert(entity: string, id: string, zh: object, en: object): void {
    hub.publish(PROVIDERS_TOPIC, {
      event: 'upsert',
      entity,
      id,
      value: (lang) => (normalizeLang(lang) === 'en' ? en : zh),
    });
  }

  function diffAndPublish(zh: ProvidersSnapshot, en: ProvidersSnapshot): void {
    const nextZh = mapsFromSnapshot(zh);
    const nextEn = mapsFromSnapshot(en);
    const prevKeys = new Set<EntityKey>([...lastZh.keys(), ...lastEn.keys()]);
    for (const key of prevKeys) {
      if (nextZh.has(key) || nextEn.has(key)) continue;
      const { entity, id } = parseKey(key);
      publishRemove(entity, id);
    }
    const seen = new Set<EntityKey>();
    for (const key of [...nextZh.keys(), ...nextEn.keys()]) {
      if (seen.has(key)) continue;
      seen.add(key);
      const zhVal = nextZh.get(key) ?? nextEn.get(key);
      const enVal = nextEn.get(key) ?? zhVal;
      if (!zhVal || !enVal) continue;
      if (jsonEq(lastZh.get(key), zhVal) && jsonEq(lastEn.get(key), enVal)) continue;
      const { entity, id } = parseKey(key);
      publishUpsert(entity, id, zhVal, enVal);
    }
    lastZh = nextZh;
    lastEn = nextEn;
  }

  async function publishDiff(): Promise<void> {
    if (disposed || !active) return;
    let zh: ProvidersSnapshot;
    let en: ProvidersSnapshot;
    try {
      zh = await loadSnapshot('zh');
      en = await loadSnapshot('en');
    } catch (err) {
      console.error('WEFT_V2_PROVIDERS_SNAPSHOT', err);
      return;
    }
    if (disposed || !active) return;
    diffAndPublish(zh, en);
  }

  function start(): void {
    if (disposed || active) return;
    active = true;
    unsubLog = true;
    log('WEFT_V2_PROVIDERS_SUB');
  }

  function stop(): void {
    if (!active) return;
    active = false;
    lastZh = new Map();
    lastEn = new Map();
    if (unsubLog) log('WEFT_V2_PROVIDERS_UNSUB');
    unsubLog = false;
  }

  hub.register(PROVIDERS_TOPIC, {
    async snapshot(lang) {
      const snap = await enqueue(async () => {
        const resolved = normalizeLang(lang) === 'en' ? 'en' : 'zh';
        const loaded = await loadSnapshot(resolved);
        if (resolved === 'en') lastEn = mapsFromSnapshot(loaded);
        else lastZh = mapsFromSnapshot(loaded);
        return loaded;
      });
      return entitiesFromSnapshot(snap);
    },
    onFirstSubscribe() {
      start();
    },
    onLastUnsubscribe() {
      stop();
    },
  });

  return {
    notify() {
      if (disposed || !active) return;
      enqueue(() => publishDiff());
    },
    subscriberActive() {
      return active;
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}

export type { Provider, ResolvedModel };
