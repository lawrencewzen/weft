import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, createStream, eventsUrl } from './stream';

class MockEventSource {
  static instances: MockEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readonly url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readonly listeners = new Map<string, Set<(ev: MessageEvent<string>) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: MessageEvent<string>) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }
}

describe('event stream', () => {
  afterEach(() => {
    MockEventSource.instances = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reconnects without lastEventId when topics change', () => {
    vi.stubGlobal('EventSource', MockEventSource);

    const stream = createStream();
    stream.connect(['service'], 'zh');
    expect(MockEventSource.instances).toHaveLength(1);
    const first = MockEventSource.instances[0];
    expect(first.url).toBe(eventsUrl(['service'], 'zh'));
    expect(first.url).not.toMatch(/lastEventId/i);
    expect(first.url).not.toMatch(/Last-Event-ID/i);

    stream.connect(['service', 'conversation:c1'], 'zh');
    expect(first.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    const second = MockEventSource.instances[1];
    expect(second.url).toBe(eventsUrl(['service', 'conversation:c1'], 'zh'));
    expect(second.url).not.toMatch(/lastEventId/i);
    expect(second.url).not.toMatch(/Last-Event-ID/i);
    expect(second.closed).toBe(false);
  });

  it('does not reopen when topics and lang stay the same', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const stream = createStream();
    stream.connect(['service'], 'zh');
    stream.connect(['service'], 'zh');
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].closed).toBe(false);
  });

  it('connect() returns a cancellable subscription', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const sub = connect(['service'], 'en');
    expect(MockEventSource.instances[0].url).toBe(eventsUrl(['service'], 'en'));
    expect(sub.status).toBe('connecting');
    sub.cancel();
    expect(MockEventSource.instances[0].closed).toBe(true);
  });
});
