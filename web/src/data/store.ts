import type { components } from '../../../src/v2/contract.gen';

export type ConversationView = components['schemas']['ConversationView'];
/** Where one send landed: the requestId the client sent and the entry it became. */
export type ConversationSend = components['schemas']['ConversationSend'];
export type ConversationSummary = components['schemas']['ConversationSummary'];
export type WorkspaceKind = 'project' | 'chat';
/**
 * Prototype extension: `kind` is not in contract.gen.ts yet. Default `'project'`.
 * Real backend should add this field when T67 wires the server.
 */
export type Workspace = components['schemas']['Workspace'] & {
  kind?: WorkspaceKind;
};

export function workspaceKind(ws: Pick<Workspace, 'kind'> | null | undefined): WorkspaceKind {
  return ws?.kind === 'chat' ? 'chat' : 'project';
}

export function isChatWorkspace(ws: Pick<Workspace, 'kind'> | null | undefined): boolean {
  return workspaceKind(ws) === 'chat';
}

export function isProjectWorkspace(ws: Pick<Workspace, 'kind'> | null | undefined): boolean {
  return workspaceKind(ws) === 'project';
}
export type ThreadItem = components['schemas']['ThreadItem'];
export type ToolCall = components['schemas']['ToolCall'];
export type Subagent = components['schemas']['Subagent'];
export type Change = components['schemas']['Change'];
export type SnapshotEvent = components['schemas']['SnapshotEvent'];
export type UpsertEvent = components['schemas']['UpsertEvent'];
export type RemoveEvent = components['schemas']['RemoveEvent'];
export type TextDeltaEvent = components['schemas']['TextDeltaEvent'];
export type ToolDeltaEvent = components['schemas']['ToolDeltaEvent'];
export type EntityRef = components['schemas']['EntityRef'];
import type { Provider } from './providerTypes';
export type { Provider } from './providerTypes';
export type ProviderDefaults = components['schemas']['ProviderDefaults'];
export type ResolvedModel = components['schemas']['ResolvedModel'];
export type Plugin = components['schemas']['Plugin'];
export type Skill = components['schemas']['Skill'];
export type GitConnection = components['schemas']['GitConnection'];

type StoredEntity = {
  topic: string;
  entity: string;
  id: string;
  value: Record<string, unknown>;
};

type Listener = () => void;

function entityKey(topic: string, entity: string, id: string): string {
  return `${topic}\t${entity}\t${id}`;
}

function entityIdKey(entity: string, id: string): string {
  return `${entity}\t${id}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

type ToolLive = { text: string; stale: boolean };

/** Apply one `tool.delta` onto a local retained window. Same mismatch rules as text.delta. */
export function applyToolDeltaText(
  current: string,
  event: Pick<ToolDeltaEvent, 'set' | 'offset' | 'append' | 'trimStart'>,
): { text: string; stale: boolean; changed: boolean } {
  if (typeof event.set === 'string') {
    return { text: event.set, stale: false, changed: event.set !== current };
  }
  const append = typeof event.append === 'string' ? event.append : '';
  const offset = event.offset ?? 0;
  const trim = event.trimStart ?? 0;
  if (
    append
    && offset + append.length === current.length
    && current.slice(offset) === append
  ) {
    return { text: current, stale: false, changed: false };
  }
  let next = current;
  if (trim > 0) next = current.slice(trim);
  if (offset === next.length) {
    return { text: next + append, stale: false, changed: true };
  }
  if (
    offset >= 0
    && offset + append.length <= next.length
    && next.slice(offset, offset + append.length) === append
  ) {
    return { text: current, stale: false, changed: false };
  }
  return { text: current, stale: true, changed: false };
}

function outputTextOf(value: Record<string, unknown>): string | null {
  const output = asRecord(value.output);
  if (!output || typeof output.text !== 'string') return null;
  return output.text;
}

export function conversationTopic(cid: string): string {
  return `conversation:${cid}`;
}

export function subagentTopic(cid: string, agentId: string): string {
  return `subagent:${cid}:${agentId}`;
}

export const WORKSPACES_TOPIC = 'workspaces';
export const PROVIDERS_TOPIC = 'providers';
export const EXTENSIONS_TOPIC = 'extensions';
export const PROVIDERS_DEFAULTS_ID = 'self';

export type SessionTopicOpts = {
  conversationId?: string | null;
  extraConversationIds?: readonly string[];
  /** Topics such as `extensions`, retained only while a surface needs them. */
  extraTopics?: readonly string[];
  subagent?: { conversationId: string; agentId: string } | null;
};

export function sessionTopics(
  cidOrOpts?: string | null | SessionTopicOpts,
  extra?: Omit<SessionTopicOpts, 'conversationId'>,
): string[] {
  const opts: SessionTopicOpts = cidOrOpts != null && typeof cidOrOpts === 'object'
    ? cidOrOpts
    : { conversationId: cidOrOpts, ...extra };
  const topics = [WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC];
  const extraTopics = [...new Set((opts.extraTopics || []).filter((topic) => (
    topic
    && topic !== WORKSPACES_TOPIC
    && topic !== PROVIDERS_TOPIC
    && topic !== EXTENSIONS_TOPIC
  )))].sort((a, b) => a.localeCompare(b));
  for (const topic of extraTopics) topics.push(topic);
  const current = opts.conversationId || '';
  const extraIds = [...new Set((opts.extraConversationIds || []).filter((id) => id && id !== current))]
    .sort((a, b) => a.localeCompare(b));
  if (current) topics.push(conversationTopic(current));
  for (const id of extraIds) topics.push(conversationTopic(id));
  if (opts.subagent?.conversationId && opts.subagent.agentId) {
    topics.push(subagentTopic(opts.subagent.conversationId, opts.subagent.agentId));
  }
  return topics;
}

export type EntityStore = {
  applySnapshot(event: SnapshotEvent): void;
  applyUpsert(event: UpsertEvent): void;
  applyRemove(event: RemoveEvent): void;
  applyTextDelta(event: TextDeltaEvent): void;
  applyToolDelta(event: ToolDeltaEvent): void;
  toolLiveText(toolId: string): string | undefined;
  conversation(cid: string): ConversationView | undefined;
  items(cid: string): ThreadItem[];
  tool(toolId: string): ToolCall | undefined;
  toolsById(cid: string): Record<string, ToolCall>;
  changes(cid: string): Change[];
  workspaces(): Workspace[];
  conversationSummaries(): ConversationSummary[];
  conversationsFor(workspaceId: string): ConversationSummary[];
  providers(): Provider[];
  provider(id: string): Provider | undefined;
  defaultModel(): ResolvedModel | null;
  plugins(): Plugin[];
  plugin(id: string): Plugin | undefined;
  skills(): Skill[];
  skill(id: string): Skill | undefined;
  gitConnections(): GitConnection[];
  gitConnection(id: string): GitConnection | undefined;
  subagents(cid: string): Subagent[];
  subagent(cid: string, agentId: string): Subagent | undefined;
  topicItems(topic: string): ThreadItem[];
  toolsByTopic(topic: string): Record<string, ToolCall>;
  lastAssistantText(topic: string): string;
  retainTopics(keep: readonly string[]): void;
  hasTopic(topic: string): boolean;
  isMissing(topic: string): boolean;
  needsFullValue(itemId: string): boolean;
  subscribe(listener: Listener): () => void;
  getVersion(): number;
  subscribeTopic(topic: string, listener: Listener): () => void;
  getTopicVersion(topic: string): number;
  flush(): void;
};

export type StoreOptions = {
  maxRetainedTopics?: number;
};

export const DEFAULT_MAX_RETAINED_TOPICS = 8;

type TextBuffer = {
  chunks: string[];
  totalLength: number;
  joinedText: string | null;
};

function scheduleBatch(cb: () => void): { cancel: () => void } {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(cb);
    return { cancel: () => cancelAnimationFrame(id) };
  }
  if (typeof queueMicrotask === 'function') {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) cb();
    });
    return { cancel: () => { cancelled = true; } };
  }
  const id = setTimeout(cb, 0);
  return { cancel: () => clearTimeout(id) };
}

export function createEntityStore(options?: StoreOptions): EntityStore {
  const maxRetainedTopics = options?.maxRetainedTopics ?? DEFAULT_MAX_RETAINED_TOPICS;
  const entities = new Map<string, StoredEntity>();
  const byEntityId = new Map<string, StoredEntity>();
  const missing = new Set<string>();
  const seenTopics = new Set<string>();
  const retainedUnsubscribedTopics = new Map<string, true>();
  const staleItems = new Set<string>();
  const toolLives = new Map<string, ToolLive>();
  const globalListeners = new Set<Listener>();
  const topicListeners = new Map<string, Set<Listener>>();
  let version = 0;
  const topicVersions = new Map<string, number>();

  let dirtyGlobal = false;
  const dirtyTopics = new Set<string>();
  let scheduleHandle: { cancel: () => void } | null = null;

  const textBuffers = new Map<string, TextBuffer>();

  const queryCache = {
    items: new Map<string, ThreadItem[]>(),
    toolsById: new Map<string, Record<string, ToolCall>>(),
    changes: new Map<string, Change[]>(),
    subagents: new Map<string, Subagent[]>(),
    workspaces: null as Workspace[] | null,
    summaries: null as ConversationSummary[] | null,
    providers: null as Provider[] | null,
    plugins: null as Plugin[] | null,
    skills: null as Skill[] | null,
    gitConnections: null as GitConnection[] | null,
    topicItems: new Map<string, ThreadItem[]>(),
    toolsByTopic: new Map<string, Record<string, ToolCall>>(),
  };

  function syncTextBuffers(): void {
    for (const [id, buf] of textBuffers) {
      if (buf.joinedText === null) {
        buf.joinedText = buf.chunks.join('');
        if (buf.chunks.length > 128) {
          buf.chunks = [buf.joinedText];
        }
        const rec = byEntityId.get(entityIdKey('item', id));
        if (rec && rec.value.text !== buf.joinedText) {
          rec.value = { ...rec.value, text: buf.joinedText };
          queryCache.items.delete(rec.topic);
          queryCache.topicItems.delete(rec.topic);
        }
      }
    }
  }

  function flush(): void {
    if (scheduleHandle) {
      scheduleHandle.cancel();
      scheduleHandle = null;
    }
    if (!dirtyGlobal && dirtyTopics.size === 0) return;

    syncTextBuffers();

    const topicsToFire = new Set(dirtyTopics);
    const fireGlobal = dirtyGlobal;
    dirtyTopics.clear();
    dirtyGlobal = false;

    if (fireGlobal) version += 1;
    for (const topic of topicsToFire) {
      topicVersions.set(topic, (topicVersions.get(topic) ?? 0) + 1);
    }

    if (fireGlobal) {
      for (const listener of [...globalListeners]) {
        listener();
      }
    }
    for (const topic of topicsToFire) {
      const listeners = topicListeners.get(topic);
      if (listeners) {
        for (const listener of [...listeners]) {
          listener();
        }
      }
    }
  }

  function markDirty(topic?: string, entity?: string): void {
    dirtyGlobal = true;
    if (topic) {
      dirtyTopics.add(topic);
      if (entity) dirtyTopics.add(`${topic}#${entity}`);
    }
    if (!scheduleHandle) {
      scheduleHandle = scheduleBatch(flush);
    }
  }

  function invalidateCacheFor(rec: StoredEntity): void {
    if (rec.entity === 'item') {
      textBuffers.delete(rec.id);
      queryCache.items.delete(rec.topic);
      queryCache.topicItems.delete(rec.topic);
    } else if (rec.entity === 'tool') {
      queryCache.toolsById.delete(rec.topic);
      queryCache.toolsByTopic.delete(rec.topic);
    } else if (rec.entity === 'change') {
      queryCache.changes.delete(rec.topic);
    } else if (rec.entity === 'subagent') {
      queryCache.subagents.delete(rec.topic);
    } else if (rec.entity === 'workspace') {
      queryCache.workspaces = null;
    } else if (rec.entity === 'conversation_summary') {
      queryCache.summaries = null;
    } else if (rec.entity === 'provider') {
      queryCache.providers = null;
    } else if (rec.entity === 'plugin') {
      queryCache.plugins = null;
    } else if (rec.entity === 'skill') {
      queryCache.skills = null;
    } else if (rec.entity === 'git_connection') {
      queryCache.gitConnections = null;
    } else if (rec.entity === 'conversation') {
      queryCache.items.delete(conversationTopic(rec.id));
    }
  }

  function forget(rec: StoredEntity): void {
    invalidateCacheFor(rec);
    entities.delete(entityKey(rec.topic, rec.entity, rec.id));
    const idKey = entityIdKey(rec.entity, rec.id);
    if (byEntityId.get(idKey) === rec) byEntityId.delete(idKey);
    if (rec.entity === 'item') staleItems.delete(rec.id);
    if (rec.entity === 'tool') toolLives.delete(rec.id);
  }

  function put(rec: StoredEntity): void {
    invalidateCacheFor(rec);
    const key = entityKey(rec.topic, rec.entity, rec.id);
    const prev = entities.get(key);
    if (prev) {
      prev.value = rec.value;
      byEntityId.set(entityIdKey(rec.entity, rec.id), prev);
      if (rec.entity === 'item') staleItems.delete(rec.id);
      if (rec.entity === 'tool') {
        const text = outputTextOf(rec.value);
        if (text != null) toolLives.set(rec.id, { text, stale: false });
      }
      return;
    }
    entities.set(key, rec);
    byEntityId.set(entityIdKey(rec.entity, rec.id), rec);
    if (rec.entity === 'tool') {
      const text = outputTextOf(rec.value);
      if (text != null) toolLives.set(rec.id, { text, stale: false });
    }
  }

  function dropTopic(topic: string): void {
    queryCache.items.delete(topic);
    queryCache.topicItems.delete(topic);
    queryCache.toolsById.delete(topic);
    queryCache.toolsByTopic.delete(topic);
    queryCache.changes.delete(topic);
    queryCache.subagents.delete(topic);
    for (const rec of [...entities.values()]) {
      if (rec.topic === topic) forget(rec);
    }
  }

  function get(topic: string, entity: string, id: string): StoredEntity | undefined {
    return entities.get(entityKey(topic, entity, id));
  }

  function listWorkspaces(): Workspace[] {
    const out: Workspace[] = [];
    for (const rec of entities.values()) {
      if (rec.topic === WORKSPACES_TOPIC && rec.entity === 'workspace') {
        out.push(rec.value as unknown as Workspace);
      }
    }
    return out;
  }

  function listSummaries(): ConversationSummary[] {
    const out: ConversationSummary[] = [];
    for (const rec of entities.values()) {
      if (rec.topic === WORKSPACES_TOPIC && rec.entity === 'conversation_summary') {
        out.push(rec.value as unknown as ConversationSummary);
      }
    }
    return out;
  }

  function findItem(topic: string | undefined, itemId: string): StoredEntity | undefined {
    if (topic) {
      const rec = get(topic, 'item', itemId);
      if (rec) return rec;
    }
    return byEntityId.get(entityIdKey('item', itemId));
  }

  function findTool(topic: string | undefined, toolId: string): StoredEntity | undefined {
    if (topic) {
      const rec = get(topic, 'tool', toolId);
      if (rec) return rec;
    }
    return byEntityId.get(entityIdKey('tool', toolId));
  }

  function touchRetained(topic: string): void {
    if (retainedUnsubscribedTopics.has(topic)) {
      retainedUnsubscribedTopics.delete(topic);
      retainedUnsubscribedTopics.set(topic, true);
    }
  }

  function linkSubagentTopics(entity: string, topic: string, id: string): void {
    if (entity !== 'subagent') return;
    if (topic.startsWith('conversation:')) {
      const cid = topic.slice('conversation:'.length);
      dirtyTopics.add(subagentTopic(cid, id));
      dirtyTopics.add(`${subagentTopic(cid, id)}#subagent`);
    } else if (topic.startsWith('subagent:')) {
      const parts = topic.split(':');
      if (parts.length >= 3) {
        dirtyTopics.add(conversationTopic(parts[1]));
        dirtyTopics.add(`${conversationTopic(parts[1])}#subagent`);
      }
    }
  }

  return {
    applySnapshot(event) {
      const topics = Array.isArray(event.topics) ? event.topics : [];
      for (const topic of topics) {
        dropTopic(topic);
        seenTopics.add(topic);
        retainedUnsubscribedTopics.delete(topic);
        dirtyTopics.add(topic);
      }
      const listedMissing = new Set(event.missing || []);
      for (const topic of topics) {
        if (listedMissing.has(topic)) missing.add(topic);
        else missing.delete(topic);
      }
      for (const extra of listedMissing) missing.add(extra);
      for (const ref of event.entities || []) {
        const value = asRecord(ref.value);
        if (!value || !ref.topic || !ref.entity || !ref.id) continue;
        put({ topic: ref.topic, entity: ref.entity, id: ref.id, value });
        missing.delete(ref.topic);
        dirtyTopics.add(ref.topic);
        dirtyTopics.add(`${ref.topic}#${ref.entity}`);
        linkSubagentTopics(ref.entity, ref.topic, ref.id);
      }
      markDirty();
    },

    applyUpsert(event) {
      if (event.topic && retainedUnsubscribedTopics.has(event.topic)) return;
      const value = asRecord(event.value);
      if (!value || !event.topic || !event.entity || !event.id) return;
      put({ topic: event.topic, entity: event.entity, id: event.id, value });
      missing.delete(event.topic);
      linkSubagentTopics(event.entity, event.topic, event.id);
      markDirty(event.topic, event.entity);
    },

    applyRemove(event) {
      if (event.topic && retainedUnsubscribedTopics.has(event.topic)) return;
      if (!event.topic || !event.entity || !event.id) return;
      const rec = get(event.topic, event.entity, event.id);
      if (!rec) return;
      forget(rec);
      linkSubagentTopics(event.entity, event.topic, event.id);
      markDirty(event.topic, event.entity);
    },

    applyTextDelta(event) {
      if (event.topic && retainedUnsubscribedTopics.has(event.topic)) return;
      const rec = findItem(event.topic, event.itemId);
      if (!rec) return;
      if (staleItems.has(rec.id)) return;
      if (rec.value.kind != null && rec.value.kind !== 'assistant') return;

      const append = typeof event.append === 'string' ? event.append : '';
      const offset = event.offset ?? 0;

      let buf = textBuffers.get(rec.id);
      if (!buf) {
        const initial = typeof rec.value.text === 'string' ? rec.value.text : '';
        buf = {
          chunks: initial ? [initial] : [],
          totalLength: initial.length,
          joinedText: initial,
        };
        textBuffers.set(rec.id, buf);
      }

      // Fast path: append at end
      if (offset === buf.totalLength) {
        if (append.length === 0) return;
        buf.chunks.push(append);
        buf.totalLength += append.length;
        buf.joinedText = null;
        queryCache.items.delete(rec.topic);
        queryCache.topicItems.delete(rec.topic);
        markDirty(rec.topic, 'item');
        return;
      }

      // Check if duplicate / already present
      if (buf.joinedText === null) {
        buf.joinedText = buf.chunks.join('');
        if (buf.chunks.length > 128) buf.chunks = [buf.joinedText];
      }
      const current = buf.joinedText;
      if (
        offset + append.length <= current.length
        && current.slice(offset, offset + append.length) === append
      ) {
        return;
      }

      // Mismatch
      staleItems.add(rec.id);
      markDirty(rec.topic, 'item');
    },

    applyToolDelta(event) {
      if (event.topic && retainedUnsubscribedTopics.has(event.topic)) return;
      const toolId = event.toolId;
      if (!toolId) return;
      let live = toolLives.get(toolId);
      const rec = findTool(event.topic, toolId);
      if (!live) {
        const seed = rec ? outputTextOf(rec.value) : null;
        live = { text: seed ?? '', stale: false };
        toolLives.set(toolId, live);
      }
      if (live.stale) return;
      const result = applyToolDeltaText(live.text, event);
      if (result.stale) {
        live.stale = true;
        markDirty(event.topic || rec?.topic, 'tool');
        return;
      }
      if (!result.changed) return;
      live.text = result.text;
      markDirty(event.topic || rec?.topic, 'tool');
    },

    toolLiveText(toolId) {
      return toolLives.get(toolId)?.text;
    },

    conversation(cid) {
      touchRetained(conversationTopic(cid));
      const rec = get(conversationTopic(cid), 'conversation', cid)
        ?? byEntityId.get(entityIdKey('conversation', cid));
      return rec?.value as ConversationView | undefined;
    },

    items(cid) {
      touchRetained(conversationTopic(cid));
      const topic = conversationTopic(cid);
      const convRec = get(topic, 'conversation', cid)
        ?? byEntityId.get(entityIdKey('conversation', cid));
      const conv = convRec?.value as ConversationView | undefined;
      if (!conv || !Array.isArray(conv.itemIds)) return [];

      const cached = queryCache.items.get(topic);
      if (cached) {
        let dirty = false;
        for (const item of cached) {
          const buf = textBuffers.get(item.id);
          if (buf && buf.joinedText === null) {
            dirty = true;
            break;
          }
        }
        if (!dirty) return cached;
      }

      const out: ThreadItem[] = [];
      for (const id of conv.itemIds) {
        const rec = get(topic, 'item', id) ?? byEntityId.get(entityIdKey('item', id));
        if (rec) {
          const buf = textBuffers.get(rec.id);
          if (buf && buf.joinedText === null) {
            buf.joinedText = buf.chunks.join('');
            if (buf.chunks.length > 128) buf.chunks = [buf.joinedText];
            rec.value = { ...rec.value, text: buf.joinedText };
          }
          out.push(rec.value as unknown as ThreadItem);
        }
      }
      queryCache.items.set(topic, out);
      return out;
    },

    tool(toolId) {
      const rec = byEntityId.get(entityIdKey('tool', toolId));
      return rec?.value as ToolCall | undefined;
    },

    toolsById(cid) {
      touchRetained(conversationTopic(cid));
      const topic = conversationTopic(cid);
      const cached = queryCache.toolsById.get(topic);
      if (cached) return cached;
      const out: Record<string, ToolCall> = {};
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'tool') {
          out[rec.id] = rec.value as unknown as ToolCall;
        }
      }
      queryCache.toolsById.set(topic, out);
      return out;
    },

    changes(cid) {
      touchRetained(conversationTopic(cid));
      const topic = conversationTopic(cid);
      const cached = queryCache.changes.get(topic);
      if (cached) return cached;
      const out: Change[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'change') {
          out.push(rec.value as unknown as Change);
        }
      }
      out.sort((a, b) => a.path.localeCompare(b.path));
      queryCache.changes.set(topic, out);
      return out;
    },

    workspaces() {
      if (queryCache.workspaces) return queryCache.workspaces;
      const out = listWorkspaces();
      queryCache.workspaces = out;
      return out;
    },

    conversationSummaries() {
      if (queryCache.summaries) return queryCache.summaries;
      const out = listSummaries();
      queryCache.summaries = out;
      return out;
    },

    conversationsFor(workspaceId) {
      return listSummaries()
        .filter((conv) => conv.workspaceId === workspaceId)
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || a.id.localeCompare(b.id));
    },

    providers() {
      if (queryCache.providers) return queryCache.providers;
      const out: Provider[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === PROVIDERS_TOPIC && rec.entity === 'provider') {
          out.push(rec.value as unknown as Provider);
        }
      }
      queryCache.providers = out;
      return out;
    },

    provider(id) {
      const rec = get(PROVIDERS_TOPIC, 'provider', id)
        ?? byEntityId.get(entityIdKey('provider', id));
      return rec?.value as Provider | undefined;
    },

    defaultModel() {
      const rec = get(PROVIDERS_TOPIC, 'defaults', PROVIDERS_DEFAULTS_ID);
      const value = rec?.value as ProviderDefaults | undefined;
      return value?.model ?? null;
    },

    plugins() {
      if (queryCache.plugins) return queryCache.plugins;
      const out: Plugin[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === EXTENSIONS_TOPIC && rec.entity === 'plugin') {
          out.push(rec.value as unknown as Plugin);
        }
      }
      const sorted = out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      queryCache.plugins = sorted;
      return sorted;
    },

    plugin(id) {
      const rec = get(EXTENSIONS_TOPIC, 'plugin', id)
        ?? byEntityId.get(entityIdKey('plugin', id));
      return rec?.value as Plugin | undefined;
    },

    skills() {
      if (queryCache.skills) return queryCache.skills;
      const out: Skill[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === EXTENSIONS_TOPIC && rec.entity === 'skill') {
          out.push(rec.value as unknown as Skill);
        }
      }
      const sorted = out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      queryCache.skills = sorted;
      return sorted;
    },

    skill(id) {
      const rec = get(EXTENSIONS_TOPIC, 'skill', id)
        ?? byEntityId.get(entityIdKey('skill', id));
      return rec?.value as Skill | undefined;
    },

    gitConnections() {
      if (queryCache.gitConnections) return queryCache.gitConnections;
      const out: GitConnection[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === EXTENSIONS_TOPIC && rec.entity === 'git_connection') {
          out.push(rec.value as unknown as GitConnection);
        }
      }
      queryCache.gitConnections = out;
      return out;
    },

    gitConnection(id) {
      const rec = get(EXTENSIONS_TOPIC, 'git_connection', id)
        ?? byEntityId.get(entityIdKey('git_connection', id));
      return rec?.value as GitConnection | undefined;
    },

    subagents(cid) {
      touchRetained(conversationTopic(cid));
      const topic = conversationTopic(cid);
      const cached = queryCache.subagents.get(topic);
      if (cached) return cached;
      const out: Subagent[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'subagent') {
          out.push(rec.value as unknown as Subagent);
        }
      }
      queryCache.subagents.set(topic, out);
      return out;
    },

    subagent(cid, agentId) {
      touchRetained(subagentTopic(cid, agentId));
      touchRetained(conversationTopic(cid));
      const dedicated = get(subagentTopic(cid, agentId), 'subagent', agentId);
      if (dedicated) return dedicated.value as unknown as Subagent;
      const fromConv = get(conversationTopic(cid), 'subagent', agentId);
      if (fromConv) return fromConv.value as unknown as Subagent;
      return byEntityId.get(entityIdKey('subagent', agentId))?.value as unknown as Subagent | undefined;
    },

    topicItems(topic) {
      touchRetained(topic);
      const cached = queryCache.topicItems.get(topic);
      if (cached) {
        let dirty = false;
        for (const item of cached) {
          const buf = textBuffers.get(item.id);
          if (buf && buf.joinedText === null) {
            dirty = true;
            break;
          }
        }
        if (!dirty) return cached;
      }
      const out: ThreadItem[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'item') {
          const buf = textBuffers.get(rec.id);
          if (buf && buf.joinedText === null) {
            buf.joinedText = buf.chunks.join('');
            if (buf.chunks.length > 128) buf.chunks = [buf.joinedText];
            rec.value = { ...rec.value, text: buf.joinedText };
          }
          out.push(rec.value as unknown as ThreadItem);
        }
      }
      queryCache.topicItems.set(topic, out);
      return out;
    },

    toolsByTopic(topic) {
      touchRetained(topic);
      const cached = queryCache.toolsByTopic.get(topic);
      if (cached) return cached;
      const out: Record<string, ToolCall> = {};
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'tool') {
          out[rec.id] = rec.value as unknown as ToolCall;
        }
      }
      queryCache.toolsByTopic.set(topic, out);
      return out;
    },

    lastAssistantText(topic) {
      touchRetained(topic);
      const items = this.topicItems(topic);
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i];
        if (item && item.kind === 'assistant') {
          const text = typeof item.text === 'string' ? item.text.trim() : '';
          if (text) return item.text;
        }
      }
      return '';
    },

    retainTopics(keep) {
      const keepSet = new Set(keep);
      let dropped = false;

      for (const topic of keep) {
        retainedUnsubscribedTopics.delete(topic);
      }

      for (const topic of seenTopics) {
        if (!keepSet.has(topic)) {
          if (!retainedUnsubscribedTopics.has(topic)) {
            retainedUnsubscribedTopics.set(topic, true);
          }
        }
      }

      while (retainedUnsubscribedTopics.size > maxRetainedTopics) {
        const oldestTopic = retainedUnsubscribedTopics.keys().next().value;
        if (!oldestTopic) break;
        retainedUnsubscribedTopics.delete(oldestTopic);
        dropTopic(oldestTopic);
        seenTopics.delete(oldestTopic);
        missing.delete(oldestTopic);
        dirtyTopics.add(oldestTopic);
        dropped = true;
      }

      if (dropped) markDirty();
    },

    hasTopic(topic) {
      return seenTopics.has(topic);
    },

    isMissing(topic) {
      return missing.has(topic);
    },

    needsFullValue(itemId) {
      return staleItems.has(itemId);
    },

    subscribe(listener) {
      globalListeners.add(listener);
      return () => {
        globalListeners.delete(listener);
      };
    },

    getVersion() {
      return version;
    },

    subscribeTopic(topic, listener) {
      let set = topicListeners.get(topic);
      if (!set) {
        set = new Set();
        topicListeners.set(topic, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) topicListeners.delete(topic);
      };
    },

    getTopicVersion(topic) {
      return topicVersions.get(topic) ?? 0;
    },

    flush() {
      flush();
    },
  };
}
