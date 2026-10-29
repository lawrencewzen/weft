import type { components } from '../../../src/v2/contract.gen';

export type ConversationView = components['schemas']['ConversationView'];
/** Where one send landed: the requestId the client sent and the entry it became. */
export type ConversationSend = components['schemas']['ConversationSend'];
export type ConversationSummary = components['schemas']['ConversationSummary'];
export type Workspace = components['schemas']['Workspace'];
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

function itemText(value: Record<string, unknown>): string | null {
  if (value.kind != null && value.kind !== 'assistant') return null;
  return typeof value.text === 'string' ? value.text : '';
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
};

export type StoreOptions = {
  maxRetainedTopics?: number;
};

export const DEFAULT_MAX_RETAINED_TOPICS = 8;

export function createEntityStore(options?: StoreOptions): EntityStore {
  const maxRetainedTopics = options?.maxRetainedTopics ?? DEFAULT_MAX_RETAINED_TOPICS;
  const entities = new Map<string, StoredEntity>();
  const byEntityId = new Map<string, StoredEntity>();
  const missing = new Set<string>();
  const seenTopics = new Set<string>();
  const retainedUnsubscribedTopics = new Map<string, true>();
  const staleItems = new Set<string>();
  const toolLives = new Map<string, ToolLive>();
  const listeners = new Set<Listener>();
  let version = 0;

  function notify(): void {
    version += 1;
    for (const listener of listeners) listener();
  }

  function forget(rec: StoredEntity): void {
    entities.delete(entityKey(rec.topic, rec.entity, rec.id));
    const idKey = entityIdKey(rec.entity, rec.id);
    if (byEntityId.get(idKey) === rec) byEntityId.delete(idKey);
    if (rec.entity === 'item') staleItems.delete(rec.id);
    if (rec.entity === 'tool') toolLives.delete(rec.id);
  }

  function put(rec: StoredEntity): void {
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

  return {
    applySnapshot(event) {
      const topics = Array.isArray(event.topics) ? event.topics : [];
      for (const topic of topics) {
        dropTopic(topic);
        seenTopics.add(topic);
        retainedUnsubscribedTopics.delete(topic);
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
      }
      notify();
    },

    applyUpsert(event) {
      if (event.topic && retainedUnsubscribedTopics.has(event.topic)) return;
      const value = asRecord(event.value);
      if (!value || !event.topic || !event.entity || !event.id) return;
      put({ topic: event.topic, entity: event.entity, id: event.id, value });
      missing.delete(event.topic);
      notify();
    },

    applyRemove(event) {
      if (event.topic && retainedUnsubscribedTopics.has(event.topic)) return;
      if (!event.topic || !event.entity || !event.id) return;
      const rec = get(event.topic, event.entity, event.id);
      if (!rec) return;
      forget(rec);
      notify();
    },

    applyTextDelta(event) {
      if (event.topic && retainedUnsubscribedTopics.has(event.topic)) return;
      const rec = findItem(event.topic, event.itemId);
      if (!rec) return;
      if (staleItems.has(rec.id)) return;
      const current = itemText(rec.value);
      if (current == null) return;
      const append = typeof event.append === 'string' ? event.append : '';
      const offset = event.offset;
      if (offset === current.length) {
        rec.value = { ...rec.value, text: current + append };
        notify();
        return;
      }
      if (
        offset + append.length <= current.length
        && current.slice(offset, offset + append.length) === append
      ) {
        return;
      }
      staleItems.add(rec.id);
      notify();
    },

    applyToolDelta(event) {
      if (event.topic && retainedUnsubscribedTopics.has(event.topic)) return;
      const toolId = event.toolId;
      if (!toolId) return;
      let live = toolLives.get(toolId);
      if (!live) {
        const rec = findTool(event.topic, toolId);
        const seed = rec ? outputTextOf(rec.value) : null;
        live = { text: seed ?? '', stale: false };
        toolLives.set(toolId, live);
      }
      if (live.stale) return;
      const result = applyToolDeltaText(live.text, event);
      if (result.stale) {
        live.stale = true;
        notify();
        return;
      }
      if (!result.changed) return;
      live.text = result.text;
      notify();
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
      const convRec = get(conversationTopic(cid), 'conversation', cid)
        ?? byEntityId.get(entityIdKey('conversation', cid));
      const conv = convRec?.value as ConversationView | undefined;
      if (!conv || !Array.isArray(conv.itemIds)) return [];
      const topic = conversationTopic(cid);
      const out: ThreadItem[] = [];
      for (const id of conv.itemIds) {
        const rec = get(topic, 'item', id) ?? byEntityId.get(entityIdKey('item', id));
        if (rec) out.push(rec.value as unknown as ThreadItem);
      }
      return out;
    },

    tool(toolId) {
      const rec = byEntityId.get(entityIdKey('tool', toolId));
      return rec?.value as ToolCall | undefined;
    },

    toolsById(cid) {
      touchRetained(conversationTopic(cid));
      const topic = conversationTopic(cid);
      const out: Record<string, ToolCall> = {};
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'tool') {
          out[rec.id] = rec.value as unknown as ToolCall;
        }
      }
      return out;
    },

    changes(cid) {
      touchRetained(conversationTopic(cid));
      const topic = conversationTopic(cid);
      const out: Change[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'change') {
          out.push(rec.value as unknown as Change);
        }
      }
      out.sort((a, b) => a.path.localeCompare(b.path));
      return out;
    },

    workspaces() {
      return listWorkspaces();
    },

    conversationSummaries() {
      return listSummaries();
    },

    conversationsFor(workspaceId) {
      return listSummaries()
        .filter((conv) => conv.workspaceId === workspaceId)
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || a.id.localeCompare(b.id));
    },

    providers() {
      const out: Provider[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === PROVIDERS_TOPIC && rec.entity === 'provider') {
          out.push(rec.value as unknown as Provider);
        }
      }
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
      const out: Plugin[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === EXTENSIONS_TOPIC && rec.entity === 'plugin') {
          out.push(rec.value as unknown as Plugin);
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },

    plugin(id) {
      const rec = get(EXTENSIONS_TOPIC, 'plugin', id)
        ?? byEntityId.get(entityIdKey('plugin', id));
      return rec?.value as Plugin | undefined;
    },

    skills() {
      const out: Skill[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === EXTENSIONS_TOPIC && rec.entity === 'skill') {
          out.push(rec.value as unknown as Skill);
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },

    skill(id) {
      const rec = get(EXTENSIONS_TOPIC, 'skill', id)
        ?? byEntityId.get(entityIdKey('skill', id));
      return rec?.value as Skill | undefined;
    },

    gitConnections() {
      const out: GitConnection[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === EXTENSIONS_TOPIC && rec.entity === 'git_connection') {
          out.push(rec.value as unknown as GitConnection);
        }
      }
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
      const out: Subagent[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'subagent') {
          out.push(rec.value as unknown as Subagent);
        }
      }
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
      const out: ThreadItem[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'item') {
          out.push(rec.value as unknown as ThreadItem);
        }
      }
      return out;
    },

    toolsByTopic(topic) {
      touchRetained(topic);
      const out: Record<string, ToolCall> = {};
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'tool') {
          out[rec.id] = rec.value as unknown as ToolCall;
        }
      }
      return out;
    },

    lastAssistantText(topic) {
      touchRetained(topic);
      const items = [] as ThreadItem[];
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'item') {
          items.push(rec.value as unknown as ThreadItem);
        }
      }
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
        dropped = true;
      }

      if (dropped) notify();
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
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getVersion() {
      return version;
    },
  };
}
