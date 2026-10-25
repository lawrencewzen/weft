import { PROTOCOL_VERSION } from '../version.ts';

export const DEFAULT_BUFFER_SIZE = 1000;
export const DEFAULT_HEARTBEAT_MS = 15_000;

export type Entity = {
  entity: string;
  id: string;
  value: object;
};

export type PublishEvent =
  | { event: 'upsert'; entity: string; id: string; value: object }
  | { event: 'remove'; entity: string; id: string }
  | { event: 'text.delta'; itemId: string; offset: number; append: string };

export type SseFrame = {
  id?: number;
  event: string;
  data: object;
};

export type TopicHandler = {
  snapshot: (lang: string) => Entity[];
};

export type HubConnectOpts = {
  topics: string[];
  lang?: string | null;
  lastEventId?: string | null;
  send: (frame: SseFrame) => void;
};

export type HubSession = {
  close: () => void;
};

type BufferedEvent = {
  seq: number;
  topic: string;
  event: string;
  data: object;
};

type Connection = {
  topics: Set<string>;
  send: (frame: SseFrame) => void;
};

export type EventHub = {
  register(topic: string, handler: TopicHandler): void;
  hasTopic(topic: string): boolean;
  publish(topic: string, event: PublishEvent): number;
  currentSeq(): number;
  connectionCount(): number;
  connect(opts: HubConnectOpts): HubSession;
  heartbeat(): void;
  dispose(): void;
};

export function resolveHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.WEFT_V2_HEARTBEAT_MS || '').trim();
  if (!raw) return DEFAULT_HEARTBEAT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HEARTBEAT_MS;
  return n;
}

export function normalizeLang(lang: string | null | undefined): string {
  const v = String(lang || '').trim().toLowerCase();
  if (v === 'en') return 'en';
  return 'zh';
}

export function parseTopics(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw).split(',')) {
    const topic = part.trim();
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    out.push(topic);
  }
  return out;
}

/** Missing → null (send snapshot). Invalid / unusable → false. A number → resume from that id. */
export function parseLastEventId(raw: string | null | undefined): number | null | false {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return false;
  return n;
}

export function createEventHub(opts: {
  bufferSize?: number;
  heartbeatMs?: number;
  protocolVersion?: string;
} = {}): EventHub {
  const bufferSize = Math.max(1, opts.bufferSize ?? DEFAULT_BUFFER_SIZE);
  const heartbeatMs = opts.heartbeatMs ?? resolveHeartbeatMs();
  const protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION;
  const topics = new Map<string, TopicHandler>();
  const buffer: BufferedEvent[] = [];
  const connections = new Set<Connection>();
  let seq = 0;

  function currentSeq(): number {
    return seq;
  }

  function canReplay(lastId: number): boolean {
    if (lastId > seq) return false;
    if (lastId === seq) return true;
    if (lastId < 0) return false;
    if (buffer.length === 0) return false;
    const oldest = buffer[0]!.seq;
    return lastId >= oldest - 1;
  }

  function snapshotFrame(topicList: string[], lang: string): SseFrame {
    const entities: Array<{ topic: string; entity: string; id: string; value: object }> = [];
    for (const topic of topicList) {
      const handler = topics.get(topic);
      if (!handler) continue;
      for (const entity of handler.snapshot(lang)) {
        entities.push({
          topic,
          entity: entity.entity,
          id: entity.id,
          value: entity.value,
        });
      }
    }
    return {
      id: seq,
      event: 'snapshot',
      data: {
        protocolVersion,
        topics: topicList,
        entities,
      },
    };
  }

  function payload(topic: string, event: PublishEvent): object {
    if (event.event === 'upsert') {
      return { topic, entity: event.entity, id: event.id, value: event.value };
    }
    if (event.event === 'remove') {
      return { topic, entity: event.entity, id: event.id };
    }
    return { topic, itemId: event.itemId, offset: event.offset, append: event.append };
  }

  function heartbeat(): void {
    const frame: SseFrame = { event: 'heartbeat', data: {} };
    for (const conn of connections) conn.send(frame);
  }

  const timer = setInterval(heartbeat, heartbeatMs);
  timer.unref();

  return {
    register(topic, handler) {
      topics.set(topic, handler);
    },
    hasTopic(topic) {
      return topics.has(topic);
    },
    publish(topic, event) {
      seq += 1;
      const data = payload(topic, event);
      const entry: BufferedEvent = { seq, topic, event: event.event, data };
      buffer.push(entry);
      while (buffer.length > bufferSize) buffer.shift();
      const frame: SseFrame = { id: seq, event: event.event, data };
      for (const conn of connections) {
        if (conn.topics.has(topic)) conn.send(frame);
      }
      return seq;
    },
    currentSeq,
    connectionCount() {
      return connections.size;
    },
    connect(opts) {
      const topicList = [...opts.topics];
      const lang = normalizeLang(opts.lang);
      const conn: Connection = {
        topics: new Set(topicList),
        send: opts.send,
      };
      connections.add(conn);

      const parsed = parseLastEventId(opts.lastEventId);
      if (parsed === null || parsed === false || !canReplay(parsed)) {
        conn.send(snapshotFrame(topicList, lang));
      } else {
        for (const entry of buffer) {
          if (entry.seq > parsed && conn.topics.has(entry.topic)) {
            conn.send({ id: entry.seq, event: entry.event, data: entry.data });
          }
        }
      }

      return {
        close() {
          connections.delete(conn);
        },
      };
    },
    heartbeat,
    dispose() {
      clearInterval(timer);
      connections.clear();
      buffer.length = 0;
      topics.clear();
    },
  };
}
