/** Live `subagent:<cid>:<agentId>` topic: snapshot entities + kernel-driven upserts. */

import type { components } from '../contract.gen.ts';
import { fileExistsInWorkspace } from '../views/path-refs.ts';
import type { ThreadMessage } from '../views/thread.ts';
import {
  resolveStuckAfterMs,
  subagentSnapshot,
  type SubagentLike,
  type SubagentSnapshot,
} from '../views/subagents.ts';
import { COALESCE_MS, PATH_CACHE_MS, type KernelEvent } from './conversation-topic.ts';
import {
  normalizeLang,
  type Entity,
  type EventHub,
  type PublishEvent,
  type SnapshotPayload,
} from './hub.ts';
import type { StuckWatch } from './stuck-watch.ts';
import {
  applyKernelToolDelta,
  clearToolLiveTimer,
  createToolLive,
  deltaFromLive,
  markPublished,
  overlayToolLives,
  TOOL_DELTA_MS,
  type ToolLive,
} from './tool-delta.ts';

export const SUBAGENT_PREFIX = 'subagent:';

export type LoadSubagent = (cid: string, agentId: string) => Promise<{
  presented?: { id?: unknown; workspacePath?: unknown } | null;
  agent: SubagentLike;
  messages?: ThreadMessage[] | null;
} | null>;

export type SubagentTopicOpts = {
  loadSubagent?: LoadSubagent;
  subscribe?: (cid: string, fn: (ev: KernelEvent) => void) => () => void;
  coalesceMs?: number;
  pathCacheMs?: number;
  now?: () => number;
  stuckAfterMs?: number;
  stuck?: StuckWatch;
  log?: (line: string) => void;
};

type ThreadItem = components['schemas']['ThreadItem'];
type ToolCall = components['schemas']['ToolCall'];
type Subagent = components['schemas']['Subagent'];
type EntityKey = string;

type TopicKey = string;

type TopicState = {
  lastZh: Map<EntityKey, object>;
  lastEn: Map<EntityKey, object>;
  toolLives: Map<string, ToolLive>;
  pathCache: Map<string, { value: boolean; at: number }>;
  pending: KernelEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  tail: Promise<void>;
};

export type SubagentTopic = {
  kernelSubscriptionCount(): number;
  topicCount(): number;
  dispose(): void;
};

function topicOf(cid: string, agentId: string): string {
  return `${SUBAGENT_PREFIX}${cid}:${agentId}`;
}

export function parseSubagentTopic(topic: string): { cid: string; agentId: string } | null {
  if (!topic.startsWith(SUBAGENT_PREFIX)) return null;
  const rest = topic.slice(SUBAGENT_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const cid = rest.slice(0, colon);
  const agentId = rest.slice(colon + 1);
  if (!cid || !agentId) return null;
  return { cid, agentId };
}

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

export function entitiesFromSubagentSnapshot(snap: SubagentSnapshot): Entity[] {
  const out: Entity[] = [
    { entity: 'subagent', id: snap.subagent.id, value: snap.subagent },
  ];
  for (const item of snap.items) {
    out.push({ entity: 'item', id: item.id, value: item });
  }
  for (const tool of snap.tools) {
    out.push({ entity: 'tool', id: tool.id, value: tool });
  }
  return out;
}

function mapsFromSnapshot(snap: SubagentSnapshot): Map<EntityKey, object> {
  const map = new Map<EntityKey, object>();
  map.set(entityKey('subagent', snap.subagent.id), snap.subagent);
  for (const item of snap.items) map.set(entityKey('item', item.id), item);
  for (const tool of snap.tools) map.set(entityKey('tool', tool.id), tool);
  return map;
}

function orderedUpsertKeys(snap: SubagentSnapshot): EntityKey[] {
  const keys: EntityKey[] = [];
  for (const item of snap.items) keys.push(entityKey('item', item.id));
  for (const tool of snap.tools) keys.push(entityKey('tool', tool.id));
  keys.push(entityKey('subagent', snap.subagent.id));
  return keys;
}

function topicKey(cid: string, agentId: string): TopicKey {
  return `${cid}\t${agentId}`;
}

export function attachSubagentTopic(hub: EventHub, opts: SubagentTopicOpts = {}): SubagentTopic {
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  const pathCacheMs = opts.pathCacheMs ?? PATH_CACHE_MS;
  const now = opts.now ?? Date.now;
  const stuckAfterMs = opts.stuckAfterMs ?? resolveStuckAfterMs();
  const log = opts.log ?? ((line: string) => {
    console.log(line);
  });
  const states = new Map<TopicKey, TopicState>();
  const kernelUnsubs = new Map<string, { count: number; unsub: () => void }>();
  const topicsByCid = new Map<string, Set<string>>();
  let disposed = false;
  const unlisten = opts.stuck?.listen((cid) => {
    enqueueCid(cid, () => recomputeCid(cid));
  });

  function stateOf(key: TopicKey): TopicState {
    let state = states.get(key);
    if (!state) {
      state = {
        lastZh: new Map(),
        lastEn: new Map(),
        toolLives: new Map(),
        pathCache: new Map(),
        pending: [],
        timer: null,
        tail: Promise.resolve(),
      };
      states.set(key, state);
    }
    return state;
  }

  function clearTimer(state: TopicState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function dropState(key: TopicKey): void {
    const state = states.get(key);
    if (state) {
      clearTimer(state);
      for (const live of state.toolLives.values()) clearToolLiveTimer(live);
    }
    states.delete(key);
  }

  function existsFor(key: TopicKey, workspacePath: string) {
    const state = stateOf(key);
    return async (rel: string) => {
      const hit = state.pathCache.get(rel);
      const t = now();
      if (hit && t - hit.at < pathCacheMs) return hit.value;
      const value = await fileExistsInWorkspace(workspacePath, rel);
      state.pathCache.set(rel, { value, at: t });
      return value;
    };
  }

  type LoadedSubagent = NonNullable<Awaited<ReturnType<LoadSubagent>>>;

  async function loadTopicSource(cid: string, agentId: string): Promise<LoadedSubagent | null> {
    if (!opts.loadSubagent) return null;
    const loaded = await opts.loadSubagent(cid, agentId);
    if (!loaded) {
      opts.stuck?.patch(cid, [{ id: agentId, status: 'stopped' }]);
      return null;
    }
    opts.stuck?.patch(cid, [loaded.agent]);
    return loaded;
  }

  async function assembleSnapshot(
    cid: string,
    agentId: string,
    lang: 'zh' | 'en',
    loaded: LoadedSubagent,
    overlayTools = false,
  ): Promise<SubagentSnapshot> {
    const workspacePath = loaded.presented?.workspacePath == null ? '' : String(loaded.presented.workspacePath);
    const snap = await subagentSnapshot({
      presented: loaded.presented,
      agent: loaded.agent,
      messages: Array.isArray(loaded.messages) ? loaded.messages : [],
      lang,
      now: now(),
      stuckAfterMs,
      exists: existsFor(topicKey(cid, agentId), workspacePath),
    });
    if (!overlayTools) return snap;
    const state = states.get(topicKey(cid, agentId));
    if (!state?.toolLives.size) return snap;
    return { ...snap, tools: overlayToolLives(snap.tools, state.toolLives) };
  }

  async function snapshotsFor(
    cid: string,
    agentId: string,
  ): Promise<{ zh: SubagentSnapshot; en: SubagentSnapshot } | null> {
    const loaded = await loadTopicSource(cid, agentId);
    if (!loaded) return null;
    const zh = await assembleSnapshot(cid, agentId, 'zh', loaded);
    const en = await assembleSnapshot(cid, agentId, 'en', loaded);
    return { zh, en };
  }

  function seedBaseline(state: TopicState, zh: SubagentSnapshot, en: SubagentSnapshot): void {
    if (state.lastZh.size || state.lastEn.size) return;
    state.lastZh = mapsFromSnapshot(zh);
    state.lastEn = mapsFromSnapshot(en);
  }

  async function snapshotEntities(topic: string, lang: string): Promise<SnapshotPayload> {
    const parsed = parseSubagentTopic(topic);
    if (!parsed) return { entities: [], missing: [topic] };
    const state = stateOf(topicKey(parsed.cid, parsed.agentId));
    const wantEn = normalizeLang(lang) === 'en';
    if (!state.lastZh.size && !state.lastEn.size) {
      const pair = await snapshotsFor(parsed.cid, parsed.agentId);
      if (!pair) return { entities: [], missing: [topic] };
      seedBaseline(state, pair.zh, pair.en);
      return { entities: entitiesFromSubagentSnapshot(wantEn ? pair.en : pair.zh) };
    }
    const loaded = await loadTopicSource(parsed.cid, parsed.agentId);
    if (!loaded) return { entities: [], missing: [topic] };
    const snap = await assembleSnapshot(parsed.cid, parsed.agentId, wantEn ? 'en' : 'zh', loaded, true);
    return { entities: entitiesFromSubagentSnapshot(snap) };
  }

  function publishRemove(cid: string, agentId: string, entity: string, id: string): void {
    hub.publish(topicOf(cid, agentId), { event: 'remove', entity, id });
  }

  function publishUpsert(cid: string, agentId: string, entity: string, id: string, zh: object, en: object): void {
    hub.publish(topicOf(cid, agentId), {
      event: 'upsert',
      entity,
      id,
      value: (lang) => (normalizeLang(lang) === 'en' ? en : zh),
    });
  }

  function removeAll(cid: string, agentId: string, state: TopicState): void {
    const keys = new Set<EntityKey>([...state.lastZh.keys(), ...state.lastEn.keys()]);
    for (const key of keys) {
      const { entity, id } = parseKey(key);
      publishRemove(cid, agentId, entity, id);
    }
    state.lastZh.clear();
    state.lastEn.clear();
  }

  function diffAndPublish(
    cid: string,
    agentId: string,
    state: TopicState,
    zh: SubagentSnapshot,
    en: SubagentSnapshot,
  ): void {
    const nextZh = mapsFromSnapshot(zh);
    const nextEn = mapsFromSnapshot(en);
    const prevKeys = new Set<EntityKey>([...state.lastZh.keys(), ...state.lastEn.keys()]);
    for (const key of prevKeys) {
      if (nextZh.has(key) || nextEn.has(key)) continue;
      const { entity, id } = parseKey(key);
      publishRemove(cid, agentId, entity, id);
    }
    const seen = new Set<EntityKey>();
    for (const key of [...orderedUpsertKeys(zh), ...orderedUpsertKeys(en)]) {
      if (seen.has(key)) continue;
      seen.add(key);
      const zhVal = nextZh.get(key) ?? nextEn.get(key);
      const enVal = nextEn.get(key) ?? zhVal;
      if (!zhVal || !enVal) continue;
      if (jsonEq(state.lastZh.get(key), zhVal) && jsonEq(state.lastEn.get(key), enVal)) continue;
      const { entity, id } = parseKey(key);
      publishUpsert(cid, agentId, entity, id, zhVal, enVal);
    }
    state.lastZh = nextZh;
    state.lastEn = nextEn;
  }

  async function recompute(cid: string, agentId: string): Promise<void> {
    if (disposed || !kernelUnsubs.has(cid)) return;
    const key = topicKey(cid, agentId);
    const state = stateOf(key);
    let pair: { zh: SubagentSnapshot; en: SubagentSnapshot } | null = null;
    try {
      pair = await snapshotsFor(cid, agentId);
    } catch (err) {
      console.error(`WEFT_V2_SUBAGENT_SNAPSHOT ${cid} ${agentId}`, err);
      return;
    }
    if (disposed || !kernelUnsubs.has(cid)) return;
    if (!pair) {
      removeAll(cid, agentId, state);
      return;
    }
    diffAndPublish(cid, agentId, state, pair.zh, pair.en);
  }

  async function recomputeCid(cid: string): Promise<void> {
    const agentIds = topicsByCid.get(cid);
    if (!agentIds?.size) return;
    for (const agentId of [...agentIds]) {
      await recompute(cid, agentId);
    }
  }

  async function flushPending(cid: string, agentId: string): Promise<void> {
    const state = states.get(topicKey(cid, agentId));
    if (!state) return;
    clearTimer(state);
    if (!state.pending.length) return;
    state.pending.length = 0;
    await recompute(cid, agentId);
  }

  function enqueue(cid: string, agentId: string, fn: () => unknown): void {
    const state = stateOf(topicKey(cid, agentId));
    const run = state.tail.then(fn, fn);
    state.tail = run.then(() => {}, () => {});
  }

  function enqueueCid(cid: string, fn: () => unknown): void {
    const agentIds = topicsByCid.get(cid);
    if (!agentIds?.size) return;
    const first = [...agentIds][0];
    if (!first) return;
    enqueue(cid, first, fn);
  }

  function knownTool(state: TopicState, toolId: string): boolean {
    const key = entityKey('tool', toolId);
    return state.lastZh.has(key) || state.lastEn.has(key);
  }

  function ownerOfTool(cid: string, toolId: string): string | null {
    const agentIds = topicsByCid.get(cid);
    if (!agentIds) return null;
    for (const agentId of agentIds) {
      if (knownTool(stateOf(topicKey(cid, agentId)), toolId)) return agentId;
    }
    return null;
  }

  function seedToolLive(state: TopicState, toolId: string): ToolLive {
    const existing = state.toolLives.get(toolId);
    if (existing) return existing;
    const prev = (state.lastZh.get(entityKey('tool', toolId))
      ?? state.lastEn.get(entityKey('tool', toolId))) as ToolCall | undefined;
    const output = prev?.output;
    const seed = output && typeof output.text === 'string' ? output.text : '';
    const live = createToolLive(seed);
    state.toolLives.set(toolId, live);
    return live;
  }

  function publishToolDelta(
    cid: string,
    agentId: string,
    payload: PublishEvent & { event: 'tool.delta' },
  ): void {
    hub.publish(topicOf(cid, agentId), payload);
  }

  function flushToolLive(cid: string, agentId: string, toolId: string): void {
    const state = states.get(topicKey(cid, agentId));
    if (!state) return;
    const live = state.toolLives.get(toolId);
    if (!live) return;
    clearToolLiveTimer(live);
    const payload = deltaFromLive(live);
    if (!payload) return;
    markPublished(live);
    if ('set' in payload) {
      publishToolDelta(cid, agentId, { event: 'tool.delta', toolId, set: payload.set });
      return;
    }
    publishToolDelta(cid, agentId, {
      event: 'tool.delta',
      toolId,
      offset: payload.offset,
      append: payload.append,
      ...(payload.trimStart ? { trimStart: payload.trimStart } : {}),
    });
  }

  function scheduleToolFlush(cid: string, agentId: string, toolId: string): void {
    if (disposed || !kernelUnsubs.has(cid)) return;
    const state = states.get(topicKey(cid, agentId));
    const live = state?.toolLives.get(toolId);
    if (!live || live.timer) return;
    live.timer = setTimeout(() => {
      live.timer = null;
      enqueue(cid, agentId, () => {
        flushToolLive(cid, agentId, toolId);
      });
    }, TOOL_DELTA_MS);
    live.timer.unref?.();
  }

  async function handleToolDelta(cid: string, data: Record<string, unknown>): Promise<void> {
    if (disposed || !kernelUnsubs.has(cid)) return;
    const agentIds = topicsByCid.get(cid);
    if (!agentIds?.size) return;
    for (const agentId of [...agentIds]) await flushPending(cid, agentId);
    const toolId = typeof data.toolId === 'string' ? data.toolId : '';
    if (!toolId) return;
    const agentId = ownerOfTool(cid, toolId);
    if (!agentId) return;
    const live = seedToolLive(stateOf(topicKey(cid, agentId)), toolId);
    applyKernelToolDelta(live, data);
    if (typeof data.set === 'string') {
      clearToolLiveTimer(live);
      markPublished(live);
      publishToolDelta(cid, agentId, { event: 'tool.delta', toolId, set: live.text });
      return;
    }
    scheduleToolFlush(cid, agentId, toolId);
  }

  async function processKernelEvent(cid: string, ev: KernelEvent): Promise<void> {
    const agentIds = topicsByCid.get(cid);
    if (!agentIds) return;
    const event = String(ev?.event || '');
    const data = asRecord(ev?.data);
    if (event === 'tool.delta') {
      await handleToolDelta(cid, data);
      return;
    }
    if (event === 'tool.end') {
      const toolId = String(asRecord(data.tool).id || '');
      if (toolId) {
        const agentId = ownerOfTool(cid, toolId);
        if (agentId) flushToolLive(cid, agentId, toolId);
      }
    }
    for (const agentId of [...agentIds]) {
      const state = stateOf(topicKey(cid, agentId));
      state.pending.push(ev);
      if (state.timer) continue;
      state.timer = setTimeout(() => {
        state.timer = null;
        enqueue(cid, agentId, () => flushPending(cid, agentId));
      }, coalesceMs);
      state.timer.unref?.();
    }
  }

  function onKernelEvent(cid: string, ev: KernelEvent): void {
    enqueueCid(cid, () => processKernelEvent(cid, ev));
  }

  function retainKernel(cid: string): void {
    const existing = kernelUnsubs.get(cid);
    if (existing) {
      existing.count += 1;
      return;
    }
    const unsub = opts.subscribe ? opts.subscribe(cid, (ev) => {
      onKernelEvent(cid, ev);
    }) : () => {};
    kernelUnsubs.set(cid, { count: 1, unsub });
    opts.stuck?.retain(cid);
    log(`WEFT_V2_SUBAGENT_SUB ${cid}`);
  }

  function releaseKernel(cid: string): void {
    const existing = kernelUnsubs.get(cid);
    if (!existing) return;
    existing.count -= 1;
    if (existing.count > 0) return;
    kernelUnsubs.delete(cid);
    try {
      existing.unsub();
    } catch (err) {
      console.error(`WEFT_V2_SUBAGENT_UNSUB ${cid}`, err);
    }
    opts.stuck?.release(cid);
    log(`WEFT_V2_SUBAGENT_UNSUB ${cid}`);
  }

  function onFirstSubscribe(topic: string): void {
    if (disposed) return;
    const parsed = parseSubagentTopic(topic);
    if (!parsed) return;
    const { cid, agentId } = parsed;
    let set = topicsByCid.get(cid);
    if (!set) {
      set = new Set();
      topicsByCid.set(cid, set);
    }
    set.add(agentId);
    retainKernel(cid);
  }

  function onLastUnsubscribe(topic: string): void {
    const parsed = parseSubagentTopic(topic);
    if (!parsed) return;
    const { cid, agentId } = parsed;
    dropState(topicKey(cid, agentId));
    const set = topicsByCid.get(cid);
    if (set) {
      set.delete(agentId);
      if (!set.size) topicsByCid.delete(cid);
    }
    releaseKernel(cid);
  }

  hub.registerPattern(SUBAGENT_PREFIX, {
    snapshot: (topic, lang) => snapshotEntities(topic, lang),
    onFirstSubscribe,
    onLastUnsubscribe,
  });

  return {
    kernelSubscriptionCount() {
      return kernelUnsubs.size;
    },
    topicCount() {
      let n = 0;
      for (const set of topicsByCid.values()) n += set.size;
      return n;
    },
    dispose() {
      disposed = true;
      unlisten?.();
      for (const [cid, entry] of kernelUnsubs) {
        kernelUnsubs.delete(cid);
        try { entry.unsub(); } catch { /* ignore */ }
        opts.stuck?.release(cid);
        log(`WEFT_V2_SUBAGENT_UNSUB ${cid}`);
      }
      for (const key of [...states.keys()]) dropState(key);
      topicsByCid.clear();
    },
  };
}

export type { ThreadItem, ToolCall, Subagent };
