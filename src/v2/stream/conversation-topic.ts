/** Live `conversation:<id>` topic: snapshot entities + kernel-driven upserts. */

import type { components } from '../contract.gen.ts';
import { changeViews, posixPath, type Change, type KernelChange } from '../views/changes.ts';
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
import {
  clearTextLiveTimer,
  createTextLive,
  publishedText,
  takeTextDelta,
  TEXT_DELTA_MS,
  type TextLive,
} from './text-delta.ts';

export const CONVERSATION_PREFIX = 'conversation:';
export const COALESCE_MS = 50;
export const PATH_CACHE_MS = 2000;
export { TOOL_DELTA_MS, TEXT_DELTA_MS };
/** After write/edit ends, suppress a first +0 −0 change until disk catches up. */
export const FRESH_WRITE_MS = 400;
export const CHANGE_RETRY_MS = 40;
const FILE_CHANGE_TOOLS = new Set(['write', 'edit']);

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
  textDeltaMs?: number;
  pathCacheMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
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
  lives: Map<string, TextLive>;
  toolLives: Map<string, ToolLive>;
  lastZh: Map<EntityKey, object>;
  lastEn: Map<EntityKey, object>;
  pathCache: Map<string, { value: boolean; at: number }>;
  pending: KernelEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  changeRetry: ReturnType<typeof setTimeout> | null;
  changeRetryNeeded: boolean;
  inflightPaths: Set<string>;
  freshWrites: Map<string, number>;
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

function fileToolPath(ev: KernelEvent): string | null {
  const event = String(ev?.event || '');
  if (event !== 'tool.start' && event !== 'tool.end') return null;
  const tool = asRecord(asRecord(ev?.data).tool);
  if (!FILE_CHANGE_TOOLS.has(String(tool.name || ''))) return null;
  const raw = tool.path ?? asRecord(tool.input).path;
  if (typeof raw !== 'string' || !raw) return null;
  return posixPath(raw);
}

function isZeroChange(row: Change | undefined): boolean {
  return row != null && row.added === 0 && row.removed === 0 && row.error == null;
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

function overlayLive(
  snap: TopicSnapshot,
  lives: Map<string, TextLive>,
  toolLives?: Map<string, ToolLive>,
): TopicSnapshot {
  let next = snap;
  if (lives.size) {
    const itemIds = [...snap.conversation.itemIds];
    const items = [...snap.items];
    const have = new Set(itemIds);
    for (const [id, live] of lives) {
      const text = publishedText(live);
      if (have.has(id)) {
        const idx = items.findIndex((item) => item.id === id);
        if (idx >= 0 && items[idx]?.kind === 'assistant') {
          items[idx] = { ...items[idx], text, streaming: true } as ThreadItem;
        }
        continue;
      }
      items.push(liveAssistant(id, text));
      itemIds.push(id);
    }
    next = {
      ...snap,
      items,
      conversation: { ...snap.conversation, itemIds },
    };
  }
  if (toolLives?.size) {
    next = { ...next, tools: overlayToolLives(next.tools, toolLives) };
  }
  return next;
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
  const textDeltaMs = opts.textDeltaMs ?? TEXT_DELTA_MS;
  const pathCacheMs = opts.pathCacheMs ?? PATH_CACHE_MS;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  });
  const cancelTimer = opts.clearTimer ?? ((handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
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
        toolLives: new Map(),
        lastZh: new Map(),
        lastEn: new Map(),
        pathCache: new Map(),
        pending: [],
        timer: null,
        changeRetry: null,
        changeRetryNeeded: false,
        inflightPaths: new Set(),
        freshWrites: new Map(),
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

  function clearChangeRetry(state: TopicState): void {
    if (state.changeRetry) {
      clearTimeout(state.changeRetry);
      state.changeRetry = null;
    }
  }

  function cancelTextTimer(live: TextLive): void {
    clearTextLiveTimer(live, cancelTimer);
  }

  function dropState(cid: string): void {
    const state = states.get(cid);
    if (state) {
      flushAllTextLives(cid);
      clearTimer(state);
      clearChangeRetry(state);
      for (const live of state.lives.values()) cancelTextTimer(live);
      for (const live of state.toolLives.values()) clearToolLiveTimer(live);
    }
    states.delete(cid);
  }

  function previousChange(state: TopicState, lang: 'zh' | 'en', rel: string): Change | undefined {
    const map = lang === 'en' ? state.lastEn : state.lastZh;
    return map.get(entityKey('change', rel)) as Change | undefined;
  }

  function overlayLiveChanges(state: TopicState, lang: 'zh' | 'en', rows: Change[]): Change[] {
    const t = now();
    const byPath = new Map(rows.map((row) => [row.path, row]));
    for (const [rel, at] of state.freshWrites) {
      if (t - at > FRESH_WRITE_MS) state.freshWrites.delete(rel);
    }
    for (const rel of state.inflightPaths) {
      const prev = previousChange(state, lang, rel);
      if (prev) byPath.set(rel, prev);
      else byPath.delete(rel);
    }
    for (const rel of state.freshWrites.keys()) {
      if (state.inflightPaths.has(rel)) continue;
      const row = byPath.get(rel);
      if (!isZeroChange(row)) {
        if (row && (row.added !== 0 || row.removed !== 0)) state.freshWrites.delete(rel);
        continue;
      }
      const prev = previousChange(state, lang, rel);
      if (prev && !isZeroChange(prev)) byPath.set(rel, prev);
      else byPath.delete(rel);
      state.changeRetryNeeded = true;
    }
    return [...byPath.values()];
  }

  function scheduleChangeRetry(cid: string): void {
    const state = states.get(cid);
    if (!state || state.changeRetry || disposed || !kernelUnsubs.has(cid)) return;
    state.changeRetry = setTimeout(() => {
      state.changeRetry = null;
      enqueue(cid, () => recompute(cid));
    }, CHANGE_RETRY_MS);
    state.changeRetry.unref?.();
  }

  function noteFileTool(state: TopicState, ev: KernelEvent): void {
    const event = String(ev?.event || '');
    const rel = fileToolPath(ev);
    if (!rel) return;
    if (event === 'tool.start') {
      state.inflightPaths.add(rel);
      return;
    }
    state.inflightPaths.delete(rel);
    state.freshWrites.set(rel, now());
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

  type LoadedConversation = NonNullable<Awaited<ReturnType<LoadConversation>>>;
  type TopicSource = { loaded: LoadedConversation; changeRows: Change[] };

  async function loadTopicSource(cid: string, state: TopicState): Promise<TopicSource | null> {
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
    let changeRows: Change[] = [];
    if (opts.loadChanges) {
      try {
        changeRows = changeViews(await opts.loadChanges(cid));
      } catch (err) {
        console.error(`WEFT_V2_CONV_CHANGES ${cid}`, err);
        changeRows = [];
      }
    }
    return { loaded, changeRows };
  }

  async function assembleSnapshot(
    cid: string,
    lang: 'zh' | 'en',
    state: TopicState,
    source: TopicSource,
    overlayTools = false,
  ): Promise<TopicSnapshot> {
    const workspacePath = source.loaded.presented?.workspacePath == null
      ? ''
      : String(source.loaded.presented.workspacePath);
    const snap = await conversationSnapshot({
      ...source.loaded,
      lang,
      exists: existsFor(cid, workspacePath),
    });
    const t = now();
    return overlayLive({
      ...snap,
      subagents: subagentViews(state.rawAgents, {
        parentConversationId: cid,
        now: t,
        stuckAfterMs,
      }),
      changes: overlayLiveChanges(state, lang, source.changeRows),
    }, state.lives, overlayTools ? state.toolLives : undefined);
  }

  async function snapshotsFor(
    cid: string,
    state: TopicState,
  ): Promise<{ zh: TopicSnapshot; en: TopicSnapshot } | null> {
    const source = await loadTopicSource(cid, state);
    if (!source) return null;
    const zh = await assembleSnapshot(cid, 'zh', state, source);
    const en = await assembleSnapshot(cid, 'en', state, source);
    return { zh, en };
  }

  function seedBaseline(state: TopicState, zh: TopicSnapshot, en: TopicSnapshot): void {
    if (state.lastZh.size || state.lastEn.size) return;
    state.lastZh = mapsFromSnapshot(zh);
    state.lastEn = mapsFromSnapshot(en);
  }

  async function snapshotEntities(topic: string, lang: string): Promise<SnapshotPayload> {
    const cid = conversationIdFromTopic(topic);
    if (!cid) return { entities: [], missing: [topic] };
    const state = stateOf(cid);
    const wantEn = normalizeLang(lang) === 'en';
    if (!state.lastZh.size && !state.lastEn.size) {
      const pair = await snapshotsFor(cid, state);
      if (!pair) return { entities: [], missing: [topic] };
      seedBaseline(state, pair.zh, pair.en);
      return { entities: entitiesFromSnapshot(wantEn ? pair.en : pair.zh) };
    }
    const source = await loadTopicSource(cid, state);
    if (!source) return { entities: [], missing: [topic] };
    const snap = await assembleSnapshot(cid, wantEn ? 'en' : 'zh', state, source, true);
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
    state.changeRetryNeeded = false;
    let pair: { zh: TopicSnapshot; en: TopicSnapshot } | null = null;
    try {
      pair = await snapshotsFor(cid, state);
    } catch (err) {
      console.error(`WEFT_V2_CONV_SNAPSHOT ${cid}`, err);
      return;
    }
    if (disposed || !kernelUnsubs.has(cid)) return;
    if (!pair) {
      removeAll(cid, state);
      return;
    }
    diffAndPublish(cid, state, pair.zh, pair.en);
    if (state.changeRetryNeeded) {
      state.changeRetryNeeded = false;
      scheduleChangeRetry(cid);
    }
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

  function flushTextLive(cid: string, itemId: string): void {
    const state = states.get(cid);
    if (!state) return;
    const live = state.lives.get(itemId);
    if (!live) return;
    cancelTextTimer(live);
    const payload = takeTextDelta(live);
    if (!payload) return;
    rememberLiveItem(state, cid, liveAssistant(itemId, publishedText(live)));
    hub.publish(topicOf(cid), {
      event: 'text.delta',
      itemId,
      offset: payload.offset,
      append: payload.append,
    });
  }

  function flushAllTextLives(cid: string): void {
    const state = states.get(cid);
    if (!state) return;
    for (const itemId of [...state.lives.keys()]) flushTextLive(cid, itemId);
  }

  function scheduleTextFlush(cid: string, itemId: string): void {
    if (disposed || !kernelUnsubs.has(cid)) return;
    const state = states.get(cid);
    const live = state?.lives.get(itemId);
    if (!live || live.timer != null) return;
    live.timer = setTimer(() => {
      live.timer = null;
      enqueue(cid, () => {
        flushTextLive(cid, itemId);
      });
    }, textDeltaMs);
  }

  async function handleDelta(cid: string, messageId: string, append: string): Promise<void> {
    if (!append || disposed || !kernelUnsubs.has(cid)) return;
    const state = stateOf(cid);
    const id = liveItemId(messageId);
    let live = state.lives.get(id);
    if (!live) {
      if (!state.lastZh.size && !state.lastEn.size) await recompute(cid);
      if (disposed || !kernelUnsubs.has(cid)) return;
      live = createTextLive();
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
    const first = live.published === 0 && live.text.length === 0;
    live.text += append;
    if (first) {
      flushTextLive(cid, id);
      return;
    }
    scheduleTextFlush(cid, id);
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
    live.text = finalText;
    flushTextLive(cid, id);
  }

  function noteMessageDone(cid: string, data: Record<string, unknown>): void {
    const liveId = typeof data.liveId === 'string' && data.liveId ? data.liveId : '';
    if (liveId) flushTextLive(cid, liveItemId(liveId));
    catchUpLiveText(cid, data);
    if (!liveId) return;
    stateOf(cid).lives.delete(liveItemId(liveId));
  }

  function knownTool(state: TopicState, toolId: string): boolean {
    const key = entityKey('tool', toolId);
    return state.lastZh.has(key) || state.lastEn.has(key);
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

  function publishToolDelta(cid: string, toolId: string, payload: PublishEvent & { event: 'tool.delta' }): void {
    hub.publish(topicOf(cid), { ...payload, toolId });
  }

  function flushToolLive(cid: string, toolId: string): void {
    const state = states.get(cid);
    if (!state) return;
    const live = state.toolLives.get(toolId);
    if (!live) return;
    clearToolLiveTimer(live);
    const payload = deltaFromLive(live);
    if (!payload) return;
    markPublished(live);
    if ('set' in payload) {
      publishToolDelta(cid, toolId, { event: 'tool.delta', toolId, set: payload.set });
      return;
    }
    publishToolDelta(cid, toolId, {
      event: 'tool.delta',
      toolId,
      offset: payload.offset,
      append: payload.append,
      ...(payload.trimStart ? { trimStart: payload.trimStart } : {}),
    });
  }

  function scheduleToolFlush(cid: string, toolId: string): void {
    const state = states.get(cid);
    if (!state || disposed || !kernelUnsubs.has(cid)) return;
    const live = state.toolLives.get(toolId);
    if (!live || live.timer) return;
    live.timer = setTimeout(() => {
      live.timer = null;
      enqueue(cid, () => {
        flushToolLive(cid, toolId);
      });
    }, TOOL_DELTA_MS);
    live.timer.unref?.();
  }

  async function handleToolDelta(cid: string, data: Record<string, unknown>): Promise<void> {
    if (disposed || !kernelUnsubs.has(cid)) return;
    const toolId = typeof data.toolId === 'string' ? data.toolId : '';
    if (!toolId) return;
    const state = stateOf(cid);
    if (!knownTool(state, toolId)) return;
    const live = seedToolLive(state, toolId);
    applyKernelToolDelta(live, data);
    if (typeof data.set === 'string') {
      clearToolLiveTimer(live);
      markPublished(live);
      publishToolDelta(cid, toolId, { event: 'tool.delta', toolId, set: live.text });
      return;
    }
    scheduleToolFlush(cid, toolId);
  }

  async function onKernelEvent(cid: string, ev: KernelEvent): Promise<void> {
    if (disposed || !kernelUnsubs.has(cid)) return;
    const event = String(ev?.event || '');
    const data = asRecord(ev?.data);
    noteFileTool(stateOf(cid), ev);
    if (event === 'message.delta') {
      await flushPending(cid);
      const messageId = typeof data.messageId === 'string' ? data.messageId : '';
      const append = typeof data.text === 'string' ? data.text : '';
      if (!messageId || !append) return;
      await handleDelta(cid, messageId, append);
      return;
    }
    if (event === 'tool.delta') {
      await flushPending(cid);
      await handleToolDelta(cid, data);
      return;
    }
    flushAllTextLives(cid);
    if (event === 'tool.end') {
      const tool = asRecord(data.tool);
      const toolId = typeof tool.id === 'string' ? tool.id : '';
      if (toolId) flushToolLive(cid, toolId);
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
