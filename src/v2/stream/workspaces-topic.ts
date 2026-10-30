/** Live `workspaces` topic: snapshot + kernel-driven upserts of sidebar entities. */

import type { KernelEvent } from './conversation-topic.ts';
import type { GitStatusCache } from '../views/git-status.ts';
import {
  buildWorkspacesSnapshot,
  type SidebarLoader,
  type WorkspacesSnapshot,
} from '../views/sidebar.ts';
import type { Entity, EventHub } from './hub.ts';

export const WORKSPACES_TOPIC = 'workspaces';
export const COALESCE_MS = 200;
export const SWEEP_MS = 5_000;

const STATUS_EVENTS = new Set(['status', 'agent']);
const TERMINAL_RUN = new Set(['done', 'failed', 'stopped']);

export type WorkspacesTopicOpts = {
  loader?: SidebarLoader;
  subscribeAll?: (fn: (cid: string, ev: KernelEvent) => void) => () => void;
  coalesceMs?: number;
  sweepMs?: number;
  log?: (line: string) => void;
  gitStatus?: GitStatusCache;
  getConversation?: (id: string) => Promise<{ workspaceId?: unknown } | null | undefined>;
  getWorkspace?: (id: string) => Promise<{ path?: unknown; removedAt?: unknown; kind?: unknown } | null | undefined>;
};

type EntityKey = string;

export type WorkspacesTopic = {
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export function entitiesFromSnapshot(snap: WorkspacesSnapshot): Entity[] {
  const out: Entity[] = [];
  for (const ws of snap.workspaces) {
    out.push({ entity: 'workspace', id: ws.id, value: ws });
  }
  for (const conv of snap.conversations) {
    out.push({ entity: 'conversation_summary', id: conv.id, value: conv });
  }
  return out;
}

function mapsFromSnapshot(snap: WorkspacesSnapshot): Map<EntityKey, object> {
  const map = new Map<EntityKey, object>();
  for (const ws of snap.workspaces) map.set(entityKey('workspace', ws.id), ws);
  for (const conv of snap.conversations) map.set(entityKey('conversation_summary', conv.id), conv);
  return map;
}

export function attachWorkspacesTopic(hub: EventHub, opts: WorkspacesTopicOpts = {}): WorkspacesTopic {
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  const sweepMs = opts.sweepMs ?? SWEEP_MS;
  const log = opts.log ?? ((line: string) => {
    console.log(line);
  });
  let last = new Map<EntityKey, object>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sweep: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;
  let active = false;
  let disposed = false;
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = tail.then(fn, fn) as Promise<T>;
    tail = run.then(() => {}, () => {});
    return run;
  }

  async function loadSnapshot(): Promise<WorkspacesSnapshot> {
    const snap = opts.loader
      ? await buildWorkspacesSnapshot(opts.loader)
      : { workspaces: [], conversations: [] };
    if (!opts.gitStatus) return snap;
    return opts.gitStatus.overlay(snap);
  }

  async function refreshGitForConversation(cid: string): Promise<void> {
    if (!opts.gitStatus || !opts.getConversation || !opts.getWorkspace) return;
    try {
      const conv = await opts.getConversation(cid);
      const wsId = conv?.workspaceId == null ? '' : String(conv.workspaceId);
      if (!wsId) return;
      const ws = await opts.getWorkspace(wsId);
      if (!ws || ws.removedAt != null || ws.path == null || String(ws.path) === '') return;
      if (ws.kind === 'chat') return;
      await opts.gitStatus.refresh(wsId, String(ws.path));
    } catch (err) {
      console.error('WEFT_V2_GIT_REFRESH', err);
    }
  }

  function publishRemove(entity: string, id: string): void {
    hub.publish(WORKSPACES_TOPIC, { event: 'remove', entity, id });
  }

  function publishUpsert(entity: string, id: string, value: object): void {
    hub.publish(WORKSPACES_TOPIC, { event: 'upsert', entity, id, value });
  }

  function diffAndPublish(snap: WorkspacesSnapshot): void {
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

  async function recompute(): Promise<WorkspacesSnapshot> {
    const snap = await loadSnapshot();
    if (disposed) return snap;
    return snap;
  }

  async function publishDiff(): Promise<void> {
    if (disposed || !active) return;
    let snap: WorkspacesSnapshot;
    try {
      snap = await recompute();
    } catch (err) {
      console.error('WEFT_V2_SIDEBAR_SNAPSHOT', err);
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

  function onKernelEvent(cid: string, ev: KernelEvent): void {
    if (disposed || !active) return;
    const event = String(ev?.event || '');
    const status = String(asRecord(ev?.data).status || '');
    if (event === 'status' && TERMINAL_RUN.has(status)) {
      enqueue(async () => {
        await refreshGitForConversation(cid);
        if (disposed || !active) return;
        await publishDiff();
      });
      return;
    }
    if (!STATUS_EVENTS.has(event)) return;
    schedule();
  }

  function start(): void {
    if (disposed || active) return;
    active = true;
    unsub = opts.subscribeAll ? opts.subscribeAll(onKernelEvent) : () => {};
    sweep = setInterval(() => {
      enqueue(() => publishDiff());
    }, sweepMs);
    sweep.unref?.();
    log('WEFT_V2_SIDEBAR_SUB');
  }

  function stop(): void {
    if (!active) return;
    active = false;
    clearCoalesce();
    if (sweep) {
      clearInterval(sweep);
      sweep = null;
    }
    try {
      unsub?.();
    } catch (err) {
      console.error('WEFT_V2_SIDEBAR_UNSUB', err);
    }
    unsub = null;
    last = new Map();
    log('WEFT_V2_SIDEBAR_UNSUB');
  }

  hub.register(WORKSPACES_TOPIC, {
    async snapshot() {
      const snap = await enqueue(async () => {
        const loaded = await recompute();
        last = mapsFromSnapshot(loaded);
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
      clearCoalesce();
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
