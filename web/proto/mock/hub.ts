import type { EntityValue, Lang } from './types';

export const PROTOCOL_VERSION = '2.0.0';
export const HEARTBEAT_MS = 15_000;

export type Entity = { entity: string; id: string; value: EntityValue };

export type PublishEvent =
  | { event: 'upsert'; entity: string; id: string; value: EntityValue }
  | { event: 'remove'; entity: string; id: string }
  | { event: 'text.delta'; itemId: string; offset: number; append: string }
  | { event: 'tool.delta'; toolId: string; set: string }
  | { event: 'tool.delta'; toolId: string; offset: number; append: string; trimStart?: number };

export type Sender = (event: string, data: object) => void;

/** `null` marks a topic the mock does not know: it goes into `missing`. */
export type TopicReader = (topic: string, lang: Lang) => Entity[] | null;

type Connection = {
  id: number;
  topics: Set<string>;
  lang: Lang;
  send: Sender;
};

export type MockHub = {
  connect(topics: string[], lang: Lang, send: Sender): number;
  close(id: number): void;
  publish(topic: string, event: PublishEvent): void;
  dispose(): void;
};

function valueFor(value: EntityValue, lang: Lang): object {
  return typeof value === 'function' ? value(lang) : value;
}

export function createHub(read: TopicReader): MockHub {
  const connections = new Map<number, Connection>();
  let nextId = 0;

  function frameFor(event: PublishEvent, topic: string, lang: Lang): { event: string; data: object } | null {
    if (event.event === 'upsert') {
      return {
        event: 'upsert',
        data: { topic, entity: event.entity, id: event.id, value: valueFor(event.value, lang) },
      };
    }
    if (event.event === 'remove') {
      return { event: 'remove', data: { topic, entity: event.entity, id: event.id } };
    }
    if (event.event === 'tool.delta') {
      if ('set' in event) {
        return { event: 'tool.delta', data: { topic, toolId: event.toolId, set: event.set } };
      }
      const data: { topic: string; toolId: string; offset: number; append: string; trimStart?: number } = {
        topic,
        toolId: event.toolId,
        offset: event.offset,
        append: event.append,
      };
      if (event.trimStart) data.trimStart = event.trimStart;
      return { event: 'tool.delta', data };
    }
    return {
      event: 'text.delta',
      data: { topic, itemId: event.itemId, offset: event.offset, append: event.append },
    };
  }

  const heartbeat = window.setInterval(() => {
    for (const conn of connections.values()) conn.send('heartbeat', {});
  }, HEARTBEAT_MS);

  return {
    connect(topics, lang, send) {
      const id = ++nextId;
      const conn: Connection = { id, topics: new Set(topics), lang, send };
      connections.set(id, conn);
      const entities: Array<{ topic: string; entity: string; id: string; value: object }> = [];
      const missing: string[] = [];
      for (const topic of conn.topics) {
        const rows = read(topic, lang);
        if (rows == null) {
          missing.push(topic);
          continue;
        }
        for (const row of rows) {
          entities.push({ topic, entity: row.entity, id: row.id, value: valueFor(row.value, lang) });
        }
      }
      const data: { protocolVersion: string; topics: string[]; entities: typeof entities; missing?: string[] } = {
        protocolVersion: PROTOCOL_VERSION,
        topics: [...conn.topics],
        entities,
      };
      if (missing.length) data.missing = missing;
      send('snapshot', data);
      return id;
    },

    close(id) {
      connections.delete(id);
    },

    publish(topic, event) {
      for (const conn of connections.values()) {
        if (!conn.topics.has(topic)) continue;
        const frame = frameFor(event, topic, conn.lang);
        if (frame) conn.send(frame.event, frame.data);
      }
    },

    dispose() {
      window.clearInterval(heartbeat);
      connections.clear();
    },
  };
}
