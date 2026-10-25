import { useEffect, useState } from 'react';

type ServiceInfo = {
  protocol?: unknown;
  protocolVersion?: unknown;
  version?: unknown;
  error?: unknown;
};

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function protocolFrom(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const rec = data as ServiceInfo;
  return asText(rec.protocol) || asText(rec.protocolVersion) || asText(rec.version);
}

function errorFromBody(status: number, statusText: string, text: string): string {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const json = JSON.parse(trimmed) as ServiceInfo;
      const fromJson = asText(json.error);
      if (fromJson) return fromJson;
    } catch {
      return trimmed;
    }
    return trimmed;
  }
  return `${status} ${statusText}`.trim() || 'request failed';
}

export function App() {
  const [protocol, setProtocol] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div data-testid="next-app">
      <h1>Weft（新版，开发中）</h1>
      {protocol != null ? <p data-testid="next-protocol">{protocol}</p> : null}
      {error != null ? <p data-testid="next-error">{error}</p> : null}
    </div>
  );
}
