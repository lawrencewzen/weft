import { createDb } from './db';
import { createHub, type MockHub } from './hub';
import { mockResponse } from './http';
import { readTopic } from './topics';
import type { Lang } from './types';

function installFetch(db: ReturnType<typeof createDb>, hub: MockHub): void {
  const nativeFetch = window.fetch.bind(window);
  // Real local HTTP has a little latency; zero-latency answers can starve the
  // client's effects and turn "loading" states into a hot loop.
  const latencyMs = 18;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    let path = '';
    try {
      path = new URL(raw, window.location.href).pathname;
    } catch {
      path = '';
    }
    // Everything under /api is answered in memory; nothing else may leave the page.
    if (path.startsWith('/api/')) {
      window.__protoRequests?.push({ method: String(init?.method || 'GET').toUpperCase(), url: raw });
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, latencyMs);
      });
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      return mockResponse(db, hub, raw, init);
    }
    if (raw.startsWith('data:') || raw.startsWith('blob:')) return nativeFetch(input, init);
    return new Response(JSON.stringify({ error: `原型不联网：${raw}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function installEventSource(hub: MockHub): void {
  class ProtoEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    private connection = 0;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      window.setTimeout(() => {
        if (this.readyState === ProtoEventSource.CLOSED) return;
        this.readyState = ProtoEventSource.OPEN;
        const open = new Event('open');
        this.dispatchEvent(open);
        this.onopen?.(open);
        let parsed: URL;
        try {
          parsed = new URL(this.url, window.location.href);
        } catch {
          return;
        }
        const topics = (parsed.searchParams.get('topics') || '')
          .split(',')
          .map((topic) => topic.trim())
          .filter(Boolean);
        const lang: Lang = parsed.searchParams.get('lang') === 'en' ? 'en' : 'zh';
        if (!topics.length) return;
        this.connection = hub.connect(topics, lang, (event, data) => {
          this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
        });
      }, 0);
    }

    close(): void {
      this.readyState = ProtoEventSource.CLOSED;
      if (this.connection) hub.close(this.connection);
      this.connection = 0;
    }
  }
  window.EventSource = ProtoEventSource as unknown as typeof EventSource;
}

function protoButtonStyle(right: string): Record<string, string> {
  return {
    position: 'fixed',
    right,
    bottom: '8px',
    zIndex: '2147483647',
    padding: '3px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(0,0,0,0.14)',
    background: 'rgba(255,255,255,0.82)',
    color: 'rgba(0,0,0,0.45)',
    font: '11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    cursor: 'pointer',
    opacity: '0.7',
  };
}

function installResetButton(): void {
  if (document.querySelector('.proto-reset')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'proto-reset';
  button.dataset.testid = 'proto-reset';
  button.textContent = '重置原型数据';
  button.title = '原型数据只存在内存里：点这里或刷新页面都会回到预置状态';
  Object.assign(button.style, protoButtonStyle('10px'));
  button.addEventListener('mouseenter', () => { button.style.opacity = '1'; });
  button.addEventListener('mouseleave', () => { button.style.opacity = '0.7'; });
  button.addEventListener('click', () => {
    try {
      localStorage.removeItem('weft_conv_last_opened');
    } catch { /* ignore */ }
    const url = new URL(window.location.href);
    url.searchParams.delete('empty');
    url.searchParams.delete('state');
    window.location.replace(url.toString());
  });
  document.body.appendChild(button);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'proto-clear-projects';
  clear.dataset.testid = 'proto-clear-projects';
  clear.textContent = '清空项目';
  clear.title = '去掉所有项目，保留不选项目的对话，中栏进入不选项目的新对话';
  Object.assign(clear.style, protoButtonStyle('108px'));
  clear.addEventListener('mouseenter', () => { clear.style.opacity = '1'; });
  clear.addEventListener('mouseleave', () => { clear.style.opacity = '0.7'; });
  clear.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('empty', '1');
    url.hash = '#/new';
    window.location.replace(url.toString());
  });
  document.body.appendChild(clear);
}

function seedLastOpened(): void {
  try {
    if (!localStorage.getItem('weft_conv_last_opened')) {
      const now = Date.now();
      const MINUTE = 60_000;
      const HOUR = 60 * MINUTE;
      const DAY = 24 * HOUR;
      localStorage.setItem('weft_conv_last_opened', JSON.stringify({
        'c-rich': now,
        'c-tests': now - 10 * MINUTE,
        'c-docs': now - 4 * HOUR,
        'c-scripts': now - 5 * HOUR,
        'c-git': now - DAY,
        'c-site-1': now - 10 * MINUTE,
        'c-site-2': now - DAY,
        'c-consult': now - 2 * HOUR,
        'c-regex': now - 50 * MINUTE,
      }));
    }
  } catch {
    // ignore
  }
}

/**
 * Replace the network with an in-memory service that speaks the same HTTP and
 * SSE shapes as `src/v2`, so the product components run unmodified. Data lives
 * only in this object: a reload (or the reset button) starts from the seed.
 */
declare global {
  interface Window {
    /** Every mocked `/api` call, in order. Read by the prototype e2e tests. */
    __protoRequests?: Array<{ method: string; url: string }>;
  }
}

function blockExternalWindows(): void {
  // The prototype must not leave the page. Grok's device-code screen opens the
  // verification page automatically; in the prototype the URL is only displayed.
  window.open = () => null;
}

export function installMockBackend(): void {
  window.__protoRequests = [];
  blockExternalWindows();
  seedLastOpened();
  const db = createDb();
  const hub = createHub(readTopic(db));
  installFetch(db, hub);
  installEventSource(hub);
  installResetButton();
}
