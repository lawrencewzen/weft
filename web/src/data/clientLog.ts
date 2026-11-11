// Report page errors to the server log (POST /api/v2/client-log). Reports never carry
// conversation text or composer content: only the error message, its stack and the page path.
import type { components } from '../../../src/v2/contract.gen';

export type ClientLogRequest = components['schemas']['ClientLogRequest'];
export type ClientLogSource = NonNullable<ClientLogRequest['source']>;

export const DEDUPE_MS = 10_000;
const MAX_MESSAGE = 2048;
const MAX_STACK = 8192;

export type ClientLogSender = (body: ClientLogRequest) => Promise<unknown> | unknown;

export type ClientLogger = {
  report(level: 'error' | 'warn', err: unknown, source: ClientLogSource): void;
  install(target?: Pick<Window, 'addEventListener'>): () => void;
};

function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message || err.name || 'Error', stack: err.stack || undefined };
  }
  if (typeof err === 'string') return { message: err };
  try {
    return { message: JSON.stringify(err) ?? String(err) };
  } catch {
    return { message: String(err) };
  }
}

function currentPath(): string | undefined {
  try {
    return `${location.pathname}${location.hash.split('?')[0]}`;
  } catch {
    return undefined;
  }
}

function defaultSend(body: ClientLogRequest): Promise<unknown> {
  return fetch('/api/v2/client-log', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  });
}

export function createClientLogger(opts: {
  send?: ClientLogSender;
  now?: () => number;
} = {}): ClientLogger {
  const send = opts.send ?? defaultSend;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number>();
  // While a report is being built or sent, anything that fails is not reported again.
  let reporting = false;

  function report(level: 'error' | 'warn', err: unknown, source: ClientLogSource): void {
    if (reporting) return;
    reporting = true;
    try {
      const { message, stack } = describe(err);
      if (/ResizeObserver loop/.test(message)) return;
      const key = `${message}\n${stack ?? ''}`;
      const t = now();
      for (const [k, at] of seen) if (t - at >= DEDUPE_MS) seen.delete(k);
      const last = seen.get(key);
      if (last !== undefined && t - last < DEDUPE_MS) return;
      seen.set(key, t);
      const body: ClientLogRequest = {
        level,
        message: message.slice(0, MAX_MESSAGE),
        source,
        url: currentPath(),
        userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
      };
      if (stack) body.stack = stack.slice(0, MAX_STACK);
      const out = send(body);
      if (out && typeof (out as Promise<unknown>).catch === 'function') {
        (out as Promise<unknown>).catch(() => {});
      }
    } catch {
      // silent: reporting must never break the page
    } finally {
      reporting = false;
    }
  }

  return {
    report,
    install(target: Pick<Window, 'addEventListener'> = window) {
      const onError = (ev: Event) => {
        const e = ev as ErrorEvent;
        report('error', e.error ?? e.message ?? 'Script error', 'window.onerror');
      };
      const onRejection = (ev: Event) => {
        report('error', (ev as PromiseRejectionEvent).reason ?? 'Unhandled rejection', 'unhandledrejection');
      };
      target.addEventListener('error', onError);
      target.addEventListener('unhandledrejection', onRejection);
      return () => {
        const t = target as Window;
        t.removeEventListener?.('error', onError);
        t.removeEventListener?.('unhandledrejection', onRejection);
      };
    },
  };
}

const shared = createClientLogger();

export function installClientLog(): void {
  shared.install();
}

export function reportClientError(err: unknown, source: ClientLogSource): void {
  shared.report('error', err, source);
}
