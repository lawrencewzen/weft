import type { components } from '../../../src/v2/contract.gen';

export type ConversationView = components['schemas']['ConversationView'];
export type ConversationSummary = components['schemas']['ConversationSummary'];
export type Workspace = components['schemas']['Workspace'];
export type ThreadItem = components['schemas']['ThreadItem'];
export type ToolCall = components['schemas']['ToolCall'];
export type Subagent = components['schemas']['Subagent'];
export type SnapshotEvent = components['schemas']['SnapshotEvent'];
export type UpsertEvent = components['schemas']['UpsertEvent'];
export type RemoveEvent = components['schemas']['RemoveEvent'];
export type TextDeltaEvent = components['schemas']['TextDeltaEvent'];
export type EntityRef = components['schemas']['EntityRef'];

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

export function conversationTopic(cid: string): string {
  return `conversation:${cid}`;
}

export function subagentTopic(cid: string, agentId: string): string {
  return `subagent:${cid}:${agentId}`;
}

export const WORKSPACES_TOPIC = 'workspaces';

export type SessionTopicOpts = {
  conversationId?: string | null;
  extraConversationIds?: readonly string[];
  subagent?: { conversationId: string; agentId: string } | null;
};

export function sessionTopics(
  cidOrOpts?: string | null | SessionTopicOpts,
  extra?: Omit<SessionTopicOpts, 'conversationId'>,
): string[] {
  const opts: SessionTopicOpts = cidOrOpts != null && typeof cidOrOpts === 'object'
    ? cidOrOpts
    : { conversationId: cidOrOpts, ...extra };
  const topics = [WORKSPACES_TOPIC];
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
  conversation(cid: string): ConversationView | undefined;
  items(cid: string): ThreadItem[];
  tool(toolId: string): ToolCall | undefined;
  toolsById(cid: string): Record<string, ToolCall>;
  workspaces(): Workspace[];
  conversationSummaries(): ConversationSummary[];
  conversationsFor(workspaceId: string): ConversationSummary[];
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

export function createEntityStore(): EntityStore {
  const entities = new Map<string, StoredEntity>();
  const byEntityId = new Map<string, StoredEntity>();
  const missing = new Set<string>();
  const seenTopics = new Set<string>();
  const staleItems = new Set<string>();
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
  }

  function put(rec: StoredEntity): void {
    const key = entityKey(rec.topic, rec.entity, rec.id);
    const prev = entities.get(key);
    if (prev) {
      prev.value = rec.value;
      byEntityId.set(entityIdKey(rec.entity, rec.id), prev);
      if (rec.entity === 'item') staleItems.delete(rec.id);
      return;
    }
    entities.set(key, rec);
    byEntityId.set(entityIdKey(rec.entity, rec.id), rec);
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

  return {
    applySnapshot(event) {
      const topics = Array.isArray(event.topics) ? event.topics : [];
      for (const topic of topics) {
        dropTopic(topic);
        seenTopics.add(topic);
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
      const value = asRecord(event.value);
      if (!value || !event.topic || !event.entity || !event.id) return;
      put({ topic: event.topic, entity: event.entity, id: event.id, value });
      missing.delete(event.topic);
      notify();
    },

    applyRemove(event) {
      if (!event.topic || !event.entity || !event.id) return;
      const rec = get(event.topic, event.entity, event.id);
      if (!rec) return;
      forget(rec);
      notify();
    },

    applyTextDelta(event) {
      const rec = findItem(event.topic, event.itemId);
      if (!rec) return;
      if (staleItems.has(rec.id)) return;
      const current = itemText(rec.value);
      if (current == null) return;
      if (event.offset === current.length) {
        rec.value = { ...rec.value, text: current + event.append };
        notify();
        return;
      }
      staleItems.add(rec.id);
      notify();
    },

    conversation(cid) {
      const rec = get(conversationTopic(cid), 'conversation', cid)
        ?? byEntityId.get(entityIdKey('conversation', cid));
      return rec?.value as ConversationView | undefined;
    },

    items(cid) {
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
      const topic = conversationTopic(cid);
      const out: Record<string, ToolCall> = {};
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'tool') {
          out[rec.id] = rec.value as unknown as ToolCall;
        }
      }
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

    subagents(cid) {
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
      const dedicated = get(subagentTopic(cid, agentId), 'subagent', agentId);
      if (dedicated) return dedicated.value as unknown as Subagent;
      const fromConv = get(conversationTopic(cid), 'subagent', agentId);
      if (fromConv) return fromConv.value as unknown as Subagent;
      return byEntityId.get(entityIdKey('subagent', agentId))?.value as unknown as Subagent | undefined;
    },

    topicItems(topic) {
      const out: ThreadItem[] = [];
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'item') {
          out.push(rec.value as unknown as ThreadItem);
        }
      }
      return out;
    },

    toolsByTopic(topic) {
      const out: Record<string, ToolCall> = {};
      for (const rec of entities.values()) {
        if (rec.topic === topic && rec.entity === 'tool') {
          out[rec.id] = rec.value as unknown as ToolCall;
        }
      }
      return out;
    },

    lastAssistantText(topic) {
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
      for (const topic of [...seenTopics]) {
        if (keepSet.has(topic)) continue;
        dropTopic(topic);
        seenTopics.delete(topic);
        missing.delete(topic);
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
