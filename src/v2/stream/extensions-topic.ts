/** Live `extensions` topic: plugins, skills, and git connections. */

import {
  gitConnectionView,
  pluginView,
  skillView,
  type RawGitConnection,
  type RawPlugin,
  type RawSkill,
} from '../views/extensions.ts';
import { normalizeLang, type Entity, type EventHub } from './hub.ts';
import type { Lang } from '../phrases/index.ts';

export const EXTENSIONS_TOPIC = 'extensions';
export const COALESCE_MS = 50;

export type ExtensionsSnapshot = {
  plugins: RawPlugin[];
  skills: RawSkill[];
  connections: RawGitConnection[];
};

export type ExtensionsTopicOpts = {
  load?: () => Promise<ExtensionsSnapshot>;
  coalesceMs?: number;
  log?: (line: string) => void;
};

type EntityKey = string;

export type ExtensionsTopic = {
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

function langOf(lang: string): Lang {
  return normalizeLang(lang) === 'en' ? 'en' : 'zh';
}

function asId(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

export function entitiesFromSnapshot(snap: ExtensionsSnapshot, lang: Lang): Entity[] {
  const out: Entity[] = [];
  for (const plugin of snap.plugins) {
    const id = asId(plugin.id);
    if (!id) continue;
    out.push({ entity: 'plugin', id, value: pluginView(lang, plugin) });
  }
  for (const skill of snap.skills) {
    const id = asId(skill.id);
    if (!id) continue;
    out.push({ entity: 'skill', id, value: skillView(skill) });
  }
  for (const conn of snap.connections) {
    const id = asId(conn.id);
    if (!id) continue;
    out.push({ entity: 'git_connection', id, value: gitConnectionView(lang, conn) });
  }
  return out;
}

function mapsFromSnapshot(snap: ExtensionsSnapshot): Map<EntityKey, object> {
  const map = new Map<EntityKey, object>();
  for (const plugin of snap.plugins) {
    const id = asId(plugin.id);
    if (id) map.set(entityKey('plugin', id), plugin as object);
  }
  for (const skill of snap.skills) {
    const id = asId(skill.id);
    if (id) map.set(entityKey('skill', id), skill as object);
  }
  for (const conn of snap.connections) {
    const id = asId(conn.id);
    if (id) map.set(entityKey('git_connection', id), conn as object);
  }
  return map;
}

function viewFor(entity: string, raw: object, lang: Lang): object {
  if (entity === 'plugin') return pluginView(lang, raw);
  if (entity === 'skill') return skillView(raw);
  return gitConnectionView(lang, raw);
}

export function attachExtensionsTopic(hub: EventHub, opts: ExtensionsTopicOpts = {}): ExtensionsTopic {
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  const log = opts.log ?? ((line: string) => {
    console.log(line);
  });
  let last = new Map<EntityKey, object>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let disposed = false;
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = tail.then(fn, fn) as Promise<T>;
    tail = run.then(() => {}, () => {});
    return run;
  }

  async function loadSnapshot(): Promise<ExtensionsSnapshot> {
    if (!opts.load) return { plugins: [], skills: [], connections: [] };
    return opts.load();
  }

  function publishRemove(entity: string, id: string): void {
    hub.publish(EXTENSIONS_TOPIC, { event: 'remove', entity, id });
  }

  function publishUpsert(entity: string, id: string, raw: object): void {
    hub.publish(EXTENSIONS_TOPIC, {
      event: 'upsert',
      entity,
      id,
      value: (lang) => viewFor(entity, raw, langOf(lang)),
    });
  }

  function diffAndPublish(snap: ExtensionsSnapshot): void {
    const next = mapsFromSnapshot(snap);
    for (const key of last.keys()) {
      if (next.has(key)) continue;
      const { entity, id } = parseKey(key);
      publishRemove(entity, id);
    }
    for (const [key, value] of next) {
      if (jsonEq(last.get(key), value)) continue;
      const { entity, id } = parseKey(key);
      publishUpsert(entity, id, value);
    }
    last = next;
  }

  async function publishDiff(): Promise<void> {
    if (disposed || !active) return;
    let snap: ExtensionsSnapshot;
    try {
      snap = await loadSnapshot();
    } catch (err) {
      console.error('WEFT_V2_EXTENSIONS_SNAPSHOT', err);
      return;
    }
    if (disposed || !active) return;
    diffAndPublish(snap);
  }

  function clearCoalesce(): void {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    if (disposed || !active || timer) return;
    timer = setTimeout(() => {
      timer = null;
      enqueue(() => publishDiff());
    }, coalesceMs);
    timer.unref?.();
  }

  function start(): void {
    if (disposed || active) return;
    active = true;
    log('WEFT_V2_EXTENSIONS_SUB');
  }

  function stop(): void {
    if (!active) return;
    active = false;
    clearCoalesce();
    last = new Map();
    log('WEFT_V2_EXTENSIONS_UNSUB');
  }

  hub.register(EXTENSIONS_TOPIC, {
    async snapshot(lang) {
      const snap = await enqueue(async () => {
        const loaded = await loadSnapshot();
        last = mapsFromSnapshot(loaded);
        return loaded;
      });
      return entitiesFromSnapshot(snap, langOf(lang));
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
      if (coalesceMs <= 0) {
        enqueue(() => publishDiff());
        return;
      }
      schedule();
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
