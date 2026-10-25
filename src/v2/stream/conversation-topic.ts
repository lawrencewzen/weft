/** Live `conversation:<id>` topic: snapshot entities + kernel-driven upserts. */

import type { components } from '../contract.gen.ts';
import { changeViews, type Change, type KernelChange } from '../views/changes.ts';
import {
  conversationSnapshot,
  type ConversationSnapshot,
  type LoadConversation,
} from '../views/conversation.ts';
import { fileExistsInWorkspace } from '../views/path-refs.ts';
import {
  resolveStuckAfterMs,
  subagentViews,
  type Subagent,
  type SubagentLike,
} from '../views/subagents.ts';
import {
  normalizeLang,
  type Entity,
  type EventHub,
  type SnapshotPayload,
} from './hub.ts';
import type { StuckWatch } from './stuck-watch.ts';

export const CONVERSATION_PREFIX = 'conversation:';
export const COALESCE_MS = 50;
export const PATH_CACHE_MS = 2000;

export type KernelEvent = {
  event?: unknown;
  data?: unknown;
};

export type LoadChanges = (cid: string) => Promise<KernelChange[] | Change[] | null | undefined>;

export type ConversationTopicOpts = {
  loadConversation?: LoadConversation;
  loadChanges?: LoadChanges;
  subscribe?: (cid: string, fn: (ev: KernelEvent) => void) => () => void;
  coalesceMs?: number;
  pathCacheMs?: number;
  now?: () => number;
  stuckAfterMs?: number;
  stuck?: StuckWatch;
  log?: (line: string) => void;
};

type TopicSnapshot = ConversationSnapshot & { subagents: Subagent[]; changes: Change[] };

type ThreadItem = components['schemas']['ThreadItem'];
type ToolCall = components['schemas']['ToolCall'];
type ConversationView = components['schemas']['ConversationView'];
type AssistantItem = components['schemas']['ThreadItemAssistant'];

type EntityKey = string;

type TopicState = {
  lives: Map<string, { text: string }>;
  lastZh: Map<EntityKey, object>;
  lastEn: Map<EntityKey, object>;
  pathCache: Map<string, { value: boolean; at: number }>;
  pending: KernelEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  tail: Promise<void>;
  rawAgents: SubagentLike[];
};

export type ConversationTopic = {
  kernelSubscriptionCount(): number;
  notify(cid: string): void;
  dispose(): void;
};

function topicOf(cid: string): string {
  return `${CONVERSATION_PREFIX}${cid}`;
}

export function conversationIdFromTopic(topic: string): string | null {
  if (!topic.startsWith(CONVERSATION_PREFIX)) return null;
  const id = topic.slice(CONVERSATION_PREFIX.length);
  return id || null;
}

export function liveItemId(messageId: string): string {
  return `live:${messageId}`;
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

function liveAssistant(id: string, text: string): AssistantItem {
  return {
    kind: 'assistant',
    id,
    text,
    pathRefs: [],
    streaming: true,
    truncated: false,
  };
}

export function entitiesFromSnapshot(snap: TopicSnapshot | ConversationSnapshot): Entity[] {
  const out: Entity[] = [
    { entity: 'conversation', id: snap.conversation.id, value: snap.conversation },
  ];
  for (const item of snap.items) {
    out.push({ entity: 'item', id: item.id, value: item });
  }
  for (const tool of snap.tools) {
    out.push({ entity: 'tool', id: tool.id, value: tool });
  }
  for (const agent of 'subagents' in snap ? snap.subagents : []) {
    out.push({ entity: 'subagent', id: agent.id, value: agent });
  }
  for (const change of 'changes' in snap ? snap.changes : []) {
    out.push({ entity: 'change', id: change.path, value: change });
  }
  return out;
}

function overlayLive(snap: TopicSnapshot, lives: Map<string, { text: string }>): TopicSnapshot {
  if (!lives.size) return snap;
  const itemIds = [...snap.conversation.itemIds];
  const items = [...snap.items];
  const have = new Set(itemIds);
  for (const [id, live] of lives) {
    if (have.has(id)) {
      const idx = items.findIndex((item) => item.id === id);
      if (idx >= 0 && items[idx]?.kind === 'assistant') {
        items[idx] = { ...items[idx], text: live.text, streaming: true } as ThreadItem;
      }
      continue;
    }
    items.push(liveAssistant(id, live.text));
    itemIds.push(id);
  }
  return {
    ...snap,
    items,
    conversation: { ...snap.conversation, itemIds },
  };
}

function mapsFromSnapshot(snap: TopicSnapshot): Map<EntityKey, object> {
  const map = new Map<EntityKey, object>();
  map.set(entityKey('conversation', snap.conversation.id), snap.conversation);
  for (const item of snap.items) map.set(entityKey('item', item.id), item);
  for (const tool of snap.tools) map.set(entityKey('tool', tool.id), tool);
  for (const agent of snap.subagents) map.set(entityKey('subagent', agent.id), agent);
  for (const change of snap.changes) map.set(entityKey('change', change.path), change);
  return map;
}

function orderedUpsertKeys(snap: TopicSnapshot): EntityKey[] {
  const keys: EntityKey[] = [];
  for (const id of snap.conversation.itemIds) keys.push(entityKey('item', id));
  for (const tool of snap.tools) keys.push(entityKey('tool', tool.id));
  for (const agent of snap.subagents) keys.push(entityKey('subagent', agent.id));
  for (const change of snap.changes) keys.push(entityKey('change', change.path));
  keys.push(entityKey('conversation', snap.conversation.id));
  return keys;
}

export function attachConversationTopic(hub: EventHub, opts: ConversationTopicOpts = {}): ConversationTopic {
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  const pathCacheMs = opts.pathCacheMs ?? PATH_CACHE_MS;
  const now = opts.now ?? Date.now;
  const stuckAfterMs = opts.stuckAfterMs ?? resolveStuckAfterMs();
  const log = opts.log ?? ((line: string) => {
    console.log(line);
  });
  const states = new Map<string, TopicState>();
  const kernelUnsubs = new Map<string, () => void>();
  let disposed = false;
  const unlisten = opts.stuck?.listen((cid) => {
    enqueue(cid, () => recompute(cid));
  });

  function stateOf(cid: string): TopicState {
    let state = states.get(cid);
    if (!state) {
      state = {
        lives: new Map(),
        lastZh: new Map(),
        lastEn: new Map(),
        pathCache: new Map(),
        pending: [],
        timer: null,
        tail: Promise.resolve(),
        rawAgents: [],
      };
      states.set(cid, state);
    }
    return state;
  }

  function clearTimer(state: TopicState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function dropState(cid: string): void {
    const state = states.get(cid);
    if (state) clearTimer(state);
    states.delete(cid);
  }

  function existsFor(cid: string, workspacePath: string) {
    const state = stateOf(cid);
    return async (rel: string) => {
      const hit = state.pathCache.get(rel);
      const t = now();
      if (hit && t - hit.at < pathCacheMs) return hit.value;
      const value = await fileExistsInWorkspace(workspacePath, rel);
      state.pathCache.set(rel, { value, at: t });
      return value;
    };
  }

  async function snapshotFor(cid: string, lang: 'zh' | 'en', state: TopicState): Promise<TopicSnapshot | null> {
    if (!opts.loadConversation) return null;
    const loaded = await opts.loadConversation(cid);
    if (!loaded) {
      state.rawAgents = [];
      opts.stuck?.sync(cid, []);
      return null;
    }
    const rawAgents = Array.isArray(loaded.subagents) ? loaded.subagents : [];
    state.rawAgents = rawAgents;
    opts.stuck?.sync(cid, rawAgents);
    const workspacePath = loaded.presented?.workspacePath == null ? '' : String(loaded.presented.workspacePath);
    const snap = await conversationSnapshot({
      ...loaded,
      lang,
      exists: existsFor(cid, workspacePath),
    });
    let changes: Change[] = [];
    if (opts.loadChanges) {
      try {
        changes = changeViews(await opts.loadChanges(cid));
      } catch (err) {
        console.error(`WEFT_V2_CONV_CHANGES ${cid}`, err);
        changes = [];
      }
    }
    const t = now();
    return overlayLive({
      ...snap,
      subagents: subagentViews(rawAgents, {
        parentConversationId: cid,
        now: t,
        stuckAfterMs,
      }),
      changes,
    }, state.lives);
  }

  async function snapshotEntities(topic: string, lang: string): Promise<SnapshotPayload> {
    const cid = conversationIdFromTopic(topic);
    if (!cid) return { entities: [], missing: [topic] };
    const state = stateOf(cid);
    const snap = await snapshotFor(cid, normalizeLang(lang) === 'en' ? 'en' : 'zh', state);
    if (!snap) return { entities: [], missing: [topic] };
    return { entities: entitiesFromSnapshot(snap) };
  }

  function publishRemove(cid: string, entity: string, id: string): void {
    hub.publish(topicOf(cid), { event: 'remove', entity, id });
  }

  function publishUpsert(cid: string, entity: string, id: string, zh: object, en: object): void {
    hub.publish(topicOf(cid), {
      event: 'upsert',
      entity,
      id,
      value: (lang) => (normalizeLang(lang) === 'en' ? en : zh),
    });
  }

  function removeAll(cid: string, state: TopicState): void {
    const keys = new Set<EntityKey>([...state.lastZh.keys(), ...state.lastEn.keys()]);
    for (const id of state.lives.keys()) keys.add(entityKey('item', id));
    for (const key of keys) {
      const { entity, id } = parseKey(key);
      publishRemove(cid, entity, id);
    }
    state.lastZh.clear();
    state.lastEn.clear();
    state.lives.clear();
  }

  function diffAndPublish(cid: string, state: TopicState, zh: TopicSnapshot, en: TopicSnapshot): void {
    const nextZh = mapsFromSnapshot(zh);
    const nextEn = mapsFromSnapshot(en);
    const prevKeys = new Set<EntityKey>([...state.lastZh.keys(), ...state.lastEn.keys()]);
    for (const key of prevKeys) {
      if (nextZh.has(key) || nextEn.has(key)) continue;
      const { entity, id } = parseKey(key);
      publishRemove(cid, entity, id);
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
      publishUpsert(cid, entity, id, zhVal, enVal);
    }
    state.lastZh = nextZh;
    state.lastEn = nextEn;
  }

  async function recompute(cid: string): Promise<void> {
    if (disposed || !kernelUnsubs.has(cid)) return;
    const state = stateOf(cid);
    let zh: TopicSnapshot | null = null;
    let en: TopicSnapshot | null = null;
    try {
      zh = await snapshotFor(cid, 'zh', state);
      en = await snapshotFor(cid, 'en', state);
    } catch (err) {
      console.error(`WEFT_V2_CONV_SNAPSHOT ${cid}`, err);
      return;
    }
    if (disposed || !kernelUnsubs.has(cid)) return;
    if (!zh || !en) {
      removeAll(cid, state);
      return;
    }
    diffAndPublish(cid, state, zh, en);
  }

  function rememberLiveItem(state: TopicState, cid: string, item: AssistantItem): void {
    const key = entityKey('item', item.id);
    state.lastZh.set(key, item);
    state.lastEn.set(key, item);
    const convKey = entityKey('conversation', cid);
    for (const map of [state.lastZh, state.lastEn]) {
      const conv = map.get(convKey) as ConversationView | undefined;
      if (!conv) continue;
      if (conv.itemIds.includes(item.id)) continue;
      map.set(convKey, { ...conv, itemIds: [...conv.itemIds, item.id] });
    }
  }

  async function handleDelta(cid: string, messageId: string, append: string): Promise<void> {
    if (!append || disposed || !kernelUnsubs.has(cid)) return;
    const state = stateOf(cid);
    const id = liveItemId(messageId);
    let live = state.lives.get(id);
    if (!live) {
      if (!state.lastZh.size && !state.lastEn.size) await recompute(cid);
      if (disposed || !kernelUnsubs.has(cid)) return;
      live = { text: '' };
      state.lives.set(id, live);
      const item = liveAssistant(id, '');
      hub.publish(topicOf(cid), { event: 'upsert', entity: 'item', id, value: item });
      rememberLiveItem(state, cid, item);
      const convZh = state.lastZh.get(entityKey('conversation', cid));
      const convEn = state.lastEn.get(entityKey('conversation', cid));
      if (convZh || convEn) {
        publishUpsert(cid, 'conversation', cid, convZh || convEn || {}, convEn || convZh || {});
      }
    }
    const offset = live.text.length;
    live.text += append;
    const item = liveAssistant(id, live.text);
    rememberLiveItem(state, cid, item);
    hub.publish(topicOf(cid), { event: 'text.delta', itemId: id, offset, append });
  }

  async function flushPending(cid: string): Promise<void> {
    const state = states.get(cid);
    if (!state) return;
    clearTimer(state);
    if (!state.pending.length) return;
    state.pending.length = 0;
    await recompute(cid);
  }

  function catchUpLiveText(cid: string, data: Record<string, unknown>): void {
    const liveKey = typeof data.liveId === 'string' && data.liveId ? data.liveId : '';
    if (!liveKey) return;
    const id = liveItemId(liveKey);
    const state = stateOf(cid);
    const live = state.lives.get(id);
    const finalText = typeof data.text === 'string' ? data.text : '';
    if (!live || !finalText.startsWith(live.text) || finalText.length <= live.text.length) return;
    const append = finalText.slice(live.text.length);
    const offset = live.text.length;
    live.text = finalText;
    rememberLiveItem(state, cid, liveAssistant(id, live.text));
    hub.publish(topicOf(cid), { event: 'text.delta', itemId: id, offset, append });
  }

  function noteMessageDone(cid: string, data: Record<string, unknown>): void {
    catchUpLiveText(cid, data);
    const liveId = typeof data.liveId === 'string' && data.liveId ? data.liveId : '';
    if (!liveId) return;
    stateOf(cid).lives.delete(liveItemId(liveId));
  }

  async function onKernelEvent(cid: string, ev: KernelEvent): Promise<void> {
    if (disposed || !kernelUnsubs.has(cid)) return;
    const event = String(ev?.event || '');
    const data = asRecord(ev?.data);
    if (event === 'message.delta') {
      await flushPending(cid);
      const messageId = typeof data.messageId === 'string' ? data.messageId : '';
      const append = typeof data.text === 'string' ? data.text : '';
      if (!messageId || !append) return;
      await handleDelta(cid, messageId, append);
      return;
    }
    if (event === 'message.done') noteMessageDone(cid, data);
    const state = stateOf(cid);
    state.pending.push(ev);
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      enqueue(cid, () => flushPending(cid));
    }, coalesceMs);
    state.timer.unref?.();
  }

  function enqueue(cid: string, fn: () => unknown): void {
    const state = stateOf(cid);
    const run = state.tail.then(fn, fn);
    state.tail = run.then(() => {}, () => {});
  }

  function onFirstSubscribe(topic: string): void {
    if (disposed) return;
    const cid = conversationIdFromTopic(topic);
    if (!cid || kernelUnsubs.has(cid)) return;
    const unsub = opts.subscribe ? opts.subscribe(cid, (ev) => {
      enqueue(cid, () => onKernelEvent(cid, ev));
    }) : () => {};
    kernelUnsubs.set(cid, unsub);
    opts.stuck?.retain(cid);
    log(`WEFT_V2_CONV_SUB ${cid}`);
  }

  function onLastUnsubscribe(topic: string): void {
    const cid = conversationIdFromTopic(topic);
    if (!cid) return;
    const unsub = kernelUnsubs.get(cid);
    kernelUnsubs.delete(cid);
    try {
      unsub?.();
    } catch (err) {
      console.error(`WEFT_V2_CONV_UNSUB ${cid}`, err);
    }
    opts.stuck?.release(cid);
    dropState(cid);
    if (unsub) log(`WEFT_V2_CONV_UNSUB ${cid}`);
  }

  hub.registerPattern(CONVERSATION_PREFIX, {
    snapshot: (topic, lang) => snapshotEntities(topic, lang),
    onFirstSubscribe,
    onLastUnsubscribe,
  });

  return {
    kernelSubscriptionCount() {
      return kernelUnsubs.size;
    },
    notify(cid: string) {
      if (disposed || !kernelUnsubs.has(cid)) return;
      enqueue(cid, () => recompute(cid));
    },
    dispose() {
      disposed = true;
      unlisten?.();
      for (const [cid, unsub] of kernelUnsubs) {
        kernelUnsubs.delete(cid);
        try { unsub(); } catch { /* ignore */ }
        opts.stuck?.release(cid);
        dropState(cid);
        log(`WEFT_V2_CONV_UNSUB ${cid}`);
      }
      states.clear();
    },
  };
}

export type { ThreadItem, ToolCall, ConversationView };
