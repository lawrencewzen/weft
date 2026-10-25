import { useEffect, useState } from 'react';
import type { components } from '../../src/v2/contract.gen';

type ServiceInfo = components['schemas']['ServiceInfo'];
type SnapshotEvent = components['schemas']['SnapshotEvent'];
type UpsertEvent = components['schemas']['UpsertEvent'];
type RemoveEvent = components['schemas']['RemoveEvent'];
type TextDeltaEvent = components['schemas']['TextDeltaEvent'];
type HeartbeatEvent = components['schemas']['HeartbeatEvent'];
type EntityRef = components['schemas']['EntityRef'];

type StreamStatus = 'connecting' | 'connected' | 'reconnecting';

type StreamEventMap = {
  snapshot: SnapshotEvent;
  upsert: UpsertEvent;
  remove: RemoveEvent;
  'text.delta': TextDeltaEvent;
  heartbeat: HeartbeatEvent;
};

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function protocolFrom(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const rec = data as ServiceInfo & { protocol?: unknown; version?: unknown; error?: unknown };
  return asText(rec.protocol) || asText(rec.protocolVersion) || asText(rec.version);
}

function errorFromBody(status: number, statusText: string, text: string): string {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const json = JSON.parse(trimmed) as { error?: unknown };
      const fromJson = asText(json.error);
      if (fromJson) return fromJson;
    } catch {
      return trimmed;
    }
    return trimmed;
  }
  return `${status} ${statusText}`.trim() || 'request failed';
}

function parseEvent<K extends keyof StreamEventMap>(raw: string): StreamEventMap[K] | null {
  try {
    return JSON.parse(raw) as StreamEventMap[K];
  } catch {
    return null;
  }
}

function serviceFromSnapshot(data: SnapshotEvent): EntityRef | undefined {
  return data.entities.find((item) => item.entity === 'service' && item.id === 'self');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function App() {
  const [protocol, setProtocol] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<StreamStatus | null>(null);
  const [heartbeat, setHeartbeat] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/v2/service', { signal: ac.signal });
        const text = await res.text();
        if (!res.ok) {
          if (res.status === 401) {
            setError('请用 weft open 打开新版网页端');
            return;
          }
          setError(errorFromBody(res.status, res.statusText, text));
          return;
        }
        let data: unknown = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          setError('invalid json');
          return;
        }
        setProtocol(protocolFrom(data) || (text.trim() || 'ok'));
      } catch (err) {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (protocol == null) return;
    setStream('connecting');
    const es = new EventSource('/api/v2/events?topics=service&lang=zh');
    es.onopen = () => setStream('connected');
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) setStream('reconnecting');
    };
    es.addEventListener('snapshot', (ev: MessageEvent<string>) => {
      const data = parseEvent<'snapshot'>(ev.data);
      if (!data || !Array.isArray(data.entities)) return;
      const entity = serviceFromSnapshot(data);
      if (!entity || !isObject(entity.value)) return;
      const next = protocolFrom(entity.value);
      if (next) setProtocol(next);
    });
    es.addEventListener('heartbeat', (ev: MessageEvent<string>) => {
      parseEvent<'heartbeat'>(ev.data);
      setHeartbeat(new Date().toLocaleString());
    });
    return () => es.close();
  }, [protocol == null]);

  return (
    <div data-testid="next-app">
      <h1>Weft（新版，开发中）</h1>
      {protocol != null ? <p data-testid="next-protocol">{protocol}</p> : null}
      {stream != null ? <p data-testid="next-stream">{stream}</p> : null}
      {heartbeat != null ? <p data-testid="next-heartbeat">{heartbeat}</p> : null}
      {error != null ? <p data-testid="next-error">{error}</p> : null}
    </div>
  );
}
