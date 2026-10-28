import type { components } from '../../../src/v2/contract.gen';

export type SnapshotEvent = components['schemas']['SnapshotEvent'];
export type UpsertEvent = components['schemas']['UpsertEvent'];
export type RemoveEvent = components['schemas']['RemoveEvent'];
export type TextDeltaEvent = components['schemas']['TextDeltaEvent'];
export type ToolDeltaEvent = components['schemas']['ToolDeltaEvent'];
export type HeartbeatEvent = components['schemas']['HeartbeatEvent'];

export type StreamStatus = 'connecting' | 'connected' | 'reconnecting';

export type StreamListeners = {
  onStatus?: (status: StreamStatus) => void;
  onSnapshot?: (event: SnapshotEvent) => void;
  onUpsert?: (event: UpsertEvent) => void;
  onRemove?: (event: RemoveEvent) => void;
  onTextDelta?: (event: TextDeltaEvent) => void;
  onToolDelta?: (event: ToolDeltaEvent) => void;
  onHeartbeat?: (event: HeartbeatEvent) => void;
};

export type EventStream = {
  readonly status: StreamStatus;
  connect(topics: readonly string[], lang: string): void;
  disconnect(): void;
};

function topicsKey(topics: readonly string[], lang: string): string {
  return `${lang}\0${topics.join('\0')}`;
}

export function eventsUrl(topics: readonly string[], lang: string): string {
  const params = new URLSearchParams();
  params.set('topics', [...topics].join(','));
  params.set('lang', lang);
  return `/api/v2/events?${params.toString()}`;
}

function parseData<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function createStream(listeners: StreamListeners = {}): EventStream {
  let status: StreamStatus = 'connecting';
  let current: EventSource | null = null;
  let key = '';
  let generation = 0;

  function setStatus(next: StreamStatus): void {
    if (status === next) return;
    status = next;
    listeners.onStatus?.(next);
  }

  function closeCurrent(): void {
    generation += 1;
    const es = current;
    current = null;
    if (es) es.close();
  }

  function open(topics: readonly string[], lang: string): void {
    closeCurrent();
    const gen = generation;
    setStatus('connecting');
    const es = new EventSource(eventsUrl(topics, lang));
    current = es;
    es.addEventListener('snapshot', (ev: MessageEvent<string>) => {
      if (gen !== generation) return;
      const data = parseData<SnapshotEvent>(ev.data);
      if (data) listeners.onSnapshot?.(data);
    });
    es.addEventListener('upsert', (ev: MessageEvent<string>) => {
      if (gen !== generation) return;
      const data = parseData<UpsertEvent>(ev.data);
      if (data) listeners.onUpsert?.(data);
    });
    es.addEventListener('remove', (ev: MessageEvent<string>) => {
      if (gen !== generation) return;
      const data = parseData<RemoveEvent>(ev.data);
      if (data) listeners.onRemove?.(data);
    });
    es.addEventListener('text.delta', (ev: MessageEvent<string>) => {
      if (gen !== generation) return;
      const data = parseData<TextDeltaEvent>(ev.data);
      if (data) listeners.onTextDelta?.(data);
    });
    es.addEventListener('tool.delta', (ev: MessageEvent<string>) => {
      if (gen !== generation) return;
      const data = parseData<ToolDeltaEvent>(ev.data);
      if (data) listeners.onToolDelta?.(data);
    });
    es.addEventListener('heartbeat', (ev: MessageEvent<string>) => {
      if (gen !== generation) return;
      const data = parseData<HeartbeatEvent>(ev.data);
      listeners.onHeartbeat?.(data ?? {});
    });
    es.onopen = () => {
      if (gen !== generation) return;
      setStatus('connected');
    };
    es.onerror = () => {
      if (gen !== generation) return;
      if (es.readyState === EventSource.CLOSED) return;
      setStatus('reconnecting');
    };
  }

  return {
    get status() {
      return status;
    },
    connect(topics, lang) {
      const next = topicsKey(topics, lang);
      if (current && next === key) return;
      key = next;
      open(topics, lang);
    },
    disconnect() {
      key = '';
      closeCurrent();
    },
  };
}

/** Open a cancellable SSE subscription. Topic changes should go through `createStream().connect`. */
export function connect(
  topics: readonly string[],
  lang: string,
  listeners?: StreamListeners,
): { cancel(): void; readonly status: StreamStatus } {
  const stream = createStream(listeners);
  stream.connect(topics, lang);
  return {
    get status() {
      return stream.status;
    },
    cancel() {
      stream.disconnect();
    },
  };
}
