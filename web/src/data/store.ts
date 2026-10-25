import type { components } from '../../../src/v2/contract.gen';

export type ConversationView = components['schemas']['ConversationView'];
export type ThreadItem = components['schemas']['ThreadItem'];
export type ToolCall = components['schemas']['ToolCall'];
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

export type EntityStore = {
  applySnapshot(event: SnapshotEvent): void;
  applyUpsert(event: UpsertEvent): void;
  applyRemove(event: RemoveEvent): void;
  applyTextDelta(event: TextDeltaEvent): void;
  conversation(cid: string): ConversationView | undefined;
  items(cid: string): ThreadItem[];
  tool(toolId: string): ToolCall | undefined;
  toolsById(cid: string): Record<string, ToolCall>;
  isMissing(topic: string): boolean;
  needsFullValue(itemId: string): boolean;
  subscribe(listener: Listener): () => void;
  getVersion(): number;
};

export function createEntityStore(): EntityStore {
  const entities = new Map<string, StoredEntity>();
  const byEntityId = new Map<string, StoredEntity>();
  const missing = new Set<string>();
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
    if (prev) forget(prev);
    entities.set(key, rec);
    byEntityId.set(entityIdKey(rec.entity, rec.id), rec);
    if (rec.entity === 'item') staleItems.delete(rec.id);
  }

  function dropTopic(topic: string): void {
    for (const rec of [...entities.values()]) {
      if (rec.topic === topic) forget(rec);
    }
  }

  function get(topic: string, entity: string, id: string): StoredEntity | undefined {
    return entities.get(entityKey(topic, entity, id));
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
      for (const topic of topics) dropTopic(topic);
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
