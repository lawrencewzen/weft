import { PROTOCOL_VERSION } from '../version.ts';

export const DEFAULT_BUFFER_SIZE = 1000;
export const DEFAULT_HEARTBEAT_MS = 15_000;

export type Entity = {
  entity: string;
  id: string;
  value: object;
};

export type UpsertValue = object | ((lang: string) => object);

export type PublishEvent =
  | { event: 'upsert'; entity: string; id: string; value: UpsertValue }
  | { event: 'remove'; entity: string; id: string }
  | { event: 'text.delta'; itemId: string; offset: number; append: string };

export type SseFrame = {
  id?: number;
  event: string;
  data: object;
};

export type SnapshotPayload = {
  entities: Entity[];
  missing?: string[];
};

export type SnapshotResult = Entity[] | SnapshotPayload;

export type TopicHandler = {
  snapshot: (lang: string) => SnapshotResult | Promise<SnapshotResult>;
};

export type PatternHandler = {
  snapshot: (topic: string, lang: string) => SnapshotResult | Promise<SnapshotResult>;
  onFirstSubscribe?: (topic: string) => void;
  onLastUnsubscribe?: (topic: string) => void;
};

export type HubConnectOpts = {
  topics: string[];
  lang?: string | null;
  lastEventId?: string | null;
  send: (frame: SseFrame) => void;
};

export type HubSession = {
  close: () => void;
  ready: Promise<void>;
};

type BufferedEvent =
  | {
    seq: number;
    topic: string;
    event: 'upsert';
    entity: string;
    id: string;
    value: UpsertValue;
    langCache: Map<string, object>;
  }
  | {
    seq: number;
    topic: string;
    event: 'remove' | 'text.delta';
    data: object;
  };

type Connection = {
  topics: Set<string>;
  lang: string;
  send: (frame: SseFrame) => void;
  catchingUp: boolean;
  pending: BufferedEvent[];
  closed: boolean;
};

type ResolvedTopic =
  | { kind: 'exact'; handler: TopicHandler }
  | { kind: 'pattern'; prefix: string; handler: PatternHandler };

export type EventHub = {
  register(topic: string, handler: TopicHandler): void;
  registerPattern(prefix: string, handler: PatternHandler): void;
  hasTopic(topic: string): boolean;
  publish(topic: string, event: PublishEvent): number;
  currentSeq(): number;
  connectionCount(): number;
  topicSubscriberCount(topic: string): number;
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

function isThenable(value: unknown): value is Promise<unknown> {
  return value != null && typeof (value as { then?: unknown }).then === 'function';
}

function resolveUpsertValue(entry: Extract<BufferedEvent, { event: 'upsert' }>, lang: string): object {
  const cached = entry.langCache.get(lang);
  if (cached) return cached;
  const value = typeof entry.value === 'function' ? entry.value(lang) : entry.value;
  entry.langCache.set(lang, value);
  return value;
}

function frameFor(entry: BufferedEvent, lang: string): SseFrame {
  if (entry.event === 'upsert') {
    return {
      id: entry.seq,
      event: 'upsert',
      data: {
        topic: entry.topic,
        entity: entry.entity,
        id: entry.id,
        value: resolveUpsertValue(entry, lang),
      },
    };
  }
  return { id: entry.seq, event: entry.event, data: entry.data };
}

function normalizeSnapshotResult(
  topic: string,
  result: SnapshotResult | null | undefined,
  isPattern: boolean,
): { entities: Entity[]; missing: string[] } {
  if (Array.isArray(result)) {
    return {
      entities: result,
      missing: isPattern && result.length === 0 ? [topic] : [],
    };
  }
  if (result && typeof result === 'object' && Array.isArray(result.entities)) {
    const missing = Array.isArray(result.missing) ? result.missing.filter((item) => typeof item === 'string') : [];
    return { entities: result.entities, missing };
  }
  return { entities: [], missing: isPattern ? [topic] : [] };
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
  const patterns: Array<{ prefix: string; handler: PatternHandler }> = [];
  const buffer: BufferedEvent[] = [];
  const connections = new Set<Connection>();
  const subscribers = new Map<string, number>();
  let seq = 0;
  let disposed = false;

  function currentSeq(): number {
    return seq;
  }

  function resolveTopic(topic: string): ResolvedTopic | null {
    const exact = topics.get(topic);
    if (exact) return { kind: 'exact', handler: exact };
    for (const entry of patterns) {
      if (topic.startsWith(entry.prefix)) return { kind: 'pattern', prefix: entry.prefix, handler: entry.handler };
    }
    return null;
  }

  function canReplay(lastId: number): boolean {
    if (lastId > seq) return false;
    if (lastId === seq) return true;
    if (lastId < 0) return false;
    if (buffer.length === 0) return false;
    const oldest = buffer[0]!.seq;
    return lastId >= oldest - 1;
  }

  function snapshotData(
    topicList: string[],
    parts: Array<{ topic: string; entities: Entity[]; missing: string[] }>,
  ): { protocolVersion: string; topics: string[]; entities: Array<{ topic: string; entity: string; id: string; value: object }>; missing?: string[] } {
    const entities: Array<{ topic: string; entity: string; id: string; value: object }> = [];
    const missing: string[] = [];
    for (const part of parts) {
      for (const entity of part.entities) {
        entities.push({
          topic: part.topic,
          entity: entity.entity,
          id: entity.id,
          value: entity.value,
        });
      }
      missing.push(...part.missing);
    }
    const data: {
      protocolVersion: string;
      topics: string[];
      entities: Array<{ topic: string; entity: string; id: string; value: object }>;
      missing?: string[];
    } = {
      protocolVersion,
      topics: topicList,
      entities,
    };
    if (missing.length) data.missing = missing;
    return data;
  }

  function snapshotOne(topic: string, lang: string): SnapshotResult | Promise<SnapshotResult> {
    const resolved = resolveTopic(topic);
    if (!resolved) return [];
    if (resolved.kind === 'pattern') return resolved.handler.snapshot(topic, lang);
    return resolved.handler.snapshot(lang);
  }

  function collectSnapshots(topicList: string[], lang: string): {
    sync: boolean;
    value: Array<{ topic: string; entities: Entity[]; missing: string[] }> | Promise<Array<{ topic: string; entities: Entity[]; missing: string[] }>>;
  } {
    const raw = topicList.map((topic) => ({
      topic,
      isPattern: resolveTopic(topic)?.kind === 'pattern',
      result: snapshotOne(topic, lang),
    }));
    if (raw.some((item) => isThenable(item.result))) {
      return {
        sync: false,
        value: Promise.all(raw.map(async (item) => {
          try {
            const result = await item.result;
            return { topic: item.topic, ...normalizeSnapshotResult(item.topic, result, Boolean(item.isPattern)) };
          } catch (err) {
            console.error(`WEFT_V2_SNAPSHOT ${item.topic}`, err);
            return {
              topic: item.topic,
              entities: [],
              missing: item.isPattern ? [item.topic] : [],
            };
          }
        })),
      };
    }
    return {
      sync: true,
      value: raw.map((item) => ({
        topic: item.topic,
        ...normalizeSnapshotResult(item.topic, item.result as SnapshotResult, Boolean(item.isPattern)),
      })),
    };
  }

  function toBuffered(topic: string, event: PublishEvent, nextSeq: number): BufferedEvent {
    if (event.event === 'upsert') {
      return {
        seq: nextSeq,
        topic,
        event: 'upsert',
        entity: event.entity,
        id: event.id,
        value: event.value,
        langCache: new Map(),
      };
    }
    if (event.event === 'remove') {
      return {
        seq: nextSeq,
        topic,
        event: 'remove',
        data: { topic, entity: event.entity, id: event.id },
      };
    }
    return {
      seq: nextSeq,
      topic,
      event: 'text.delta',
      data: { topic, itemId: event.itemId, offset: event.offset, append: event.append },
    };
  }

  function heartbeat(): void {
    const frame: SseFrame = { event: 'heartbeat', data: {} };
    for (const conn of connections) {
      if (conn.closed) continue;
      conn.send(frame);
    }
  }

  function addSubscriber(topic: string): void {
    const n = (subscribers.get(topic) || 0) + 1;
    subscribers.set(topic, n);
    if (n !== 1) return;
    const resolved = resolveTopic(topic);
    if (resolved?.kind !== 'pattern') return;
    try {
      resolved.handler.onFirstSubscribe?.(topic);
    } catch (err) {
      console.error(`WEFT_V2_TOPIC_SUB ${topic}`, err);
    }
  }

  function removeSubscriber(topic: string): void {
    const n = (subscribers.get(topic) || 0) - 1;
    if (n > 0) {
      subscribers.set(topic, n);
      return;
    }
    subscribers.delete(topic);
    const resolved = resolveTopic(topic);
    if (resolved?.kind !== 'pattern') return;
    try {
      resolved.handler.onLastUnsubscribe?.(topic);
    } catch (err) {
      console.error(`WEFT_V2_TOPIC_UNSUB ${topic}`, err);
    }
  }

  function closeConn(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    connections.delete(conn);
    for (const topic of conn.topics) removeSubscriber(topic);
  }

  function sendSnapshot(
    conn: Connection,
    topicList: string[],
    parts: Array<{ topic: string; entities: Entity[]; missing: string[] }>,
  ): void {
    if (conn.closed) return;
    const snapSeq = seq;
    conn.send({
      id: snapSeq,
      event: 'snapshot',
      data: snapshotData(topicList, parts),
    });
    for (;;) {
      const queued = conn.pending;
      conn.pending = [];
      if (!queued.length) break;
      for (const entry of queued) {
        if (conn.closed) return;
        if (entry.seq > snapSeq && conn.topics.has(entry.topic)) {
          conn.send(frameFor(entry, conn.lang));
        }
      }
    }
    conn.catchingUp = false;
  }

  const timer = setInterval(heartbeat, heartbeatMs);
  timer.unref();

  return {
    register(topic, handler) {
      topics.set(topic, handler);
    },
    registerPattern(prefix, handler) {
      const existing = patterns.findIndex((entry) => entry.prefix === prefix);
      if (existing >= 0) patterns.splice(existing, 1);
      patterns.push({ prefix, handler });
    },
    hasTopic(topic) {
      return resolveTopic(topic) != null;
    },
    publish(topic, event) {
      seq += 1;
      const entry = toBuffered(topic, event, seq);
      buffer.push(entry);
      while (buffer.length > bufferSize) buffer.shift();
      for (const conn of connections) {
        if (conn.closed || !conn.topics.has(topic)) continue;
        if (conn.catchingUp) {
          conn.pending.push(entry);
          continue;
        }
        conn.send(frameFor(entry, conn.lang));
      }
      return seq;
    },
    currentSeq,
    connectionCount() {
      return connections.size;
    },
    topicSubscriberCount(topic) {
      return subscribers.get(topic) || 0;
    },
    connect(opts) {
      const topicList = [...opts.topics];
      const lang = normalizeLang(opts.lang);
      const conn: Connection = {
        topics: new Set(topicList),
        lang,
        send: opts.send,
        catchingUp: false,
        pending: [],
        closed: false,
      };
      connections.add(conn);
      for (const topic of topicList) addSubscriber(topic);

      let settleReady: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        settleReady = resolve;
      });

      const finish = () => {
        settleReady();
      };

      if (disposed || conn.closed) {
        finish();
        return {
          close() {
            closeConn(conn);
            finish();
          },
          ready,
        };
      }

      const parsed = parseLastEventId(opts.lastEventId);
      if (parsed !== null && parsed !== false && canReplay(parsed)) {
        for (const entry of buffer) {
          if (entry.seq > parsed && conn.topics.has(entry.topic)) {
            conn.send(frameFor(entry, lang));
          }
        }
        finish();
      } else {
        const collected = collectSnapshots(topicList, lang);
        if (collected.sync) {
          sendSnapshot(conn, topicList, collected.value as Array<{ topic: string; entities: Entity[]; missing: string[] }>);
          finish();
        } else {
          conn.catchingUp = true;
          void Promise.resolve(collected.value).then((parts) => {
            sendSnapshot(conn, topicList, parts);
            finish();
          }).catch((err) => {
            console.error('WEFT_V2_SNAPSHOT', err);
            if (!conn.closed) {
              conn.catchingUp = false;
              conn.send({
                id: seq,
                event: 'snapshot',
                data: snapshotData(topicList, topicList.map((topic) => ({
                  topic,
                  entities: [],
                  missing: resolveTopic(topic)?.kind === 'pattern' ? [topic] : [],
                }))),
              });
            }
            finish();
          });
        }
      }

      return {
        close() {
          closeConn(conn);
          finish();
        },
        ready,
      };
    },
    heartbeat,
    dispose() {
      disposed = true;
      clearInterval(timer);
      for (const conn of [...connections]) closeConn(conn);
      buffer.length = 0;
      topics.clear();
      patterns.length = 0;
      subscribers.clear();
    },
  };
}
