import { describe, expect, it, vi } from 'vitest';
import { createClientLogger } from './clientLog';

describe('client log', () => {
  it('dedupes the same message and stack within 10 seconds', () => {
    let now = 1000;
    const send = vi.fn();
    const log = createClientLogger({ send, now: () => now });
    const err = new Error('boom');
    log.report('error', err, 'window.onerror');
    log.report('error', err, 'window.onerror');
    now += 9_000;
    log.report('error', err, 'error-boundary');
    expect(send).toHaveBeenCalledTimes(1);
    now += 2_000;
    log.report('error', err, 'window.onerror');
    expect(send).toHaveBeenCalledTimes(2);
    log.report('error', new Error('other'), 'window.onerror');
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toMatchObject({ level: 'error', message: 'boom', source: 'window.onerror' });
  });

  it('does not recurse when sending fails or throws', async () => {
    const send = vi.fn(() => Promise.reject(new Error('net down')));
    const log = createClientLogger({ send });
    log.report('error', new Error('a'), 'console');
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);

    // a sender that reports from inside itself must not trigger another send
    const inner = createClientLogger({
      send: () => {
        inner.report('error', new Error('nested'), 'console');
        throw new Error('sync fail');
      },
    });
    expect(() => inner.report('error', new Error('outer'), 'console')).not.toThrow();
  });

  it('nested report from inside the sender is dropped', () => {
    const calls: string[] = [];
    const log = createClientLogger({
      send: (body) => {
        calls.push(body.message);
        log.report('error', new Error('nested'), 'console');
      },
    });
    log.report('error', new Error('outer'), 'console');
    expect(calls).toEqual(['outer']);
  });

  it('install wires error and unhandledrejection, with failures silent', () => {
    const handlers: Record<string, (ev: Event) => void> = {};
    const target = { addEventListener: (n: string, h: (ev: Event) => void) => { handlers[n] = h; } };
    const send = vi.fn();
    const log = createClientLogger({ send });
    log.install(target as unknown as Window);
    handlers.error({ error: new Error('x'), message: 'x' } as unknown as Event);
    handlers.unhandledrejection({ reason: 'nope' } as unknown as Event);
    expect(send.mock.calls.map((c) => [c[0].message, c[0].source])).toEqual([
      ['x', 'window.onerror'],
      ['nope', 'unhandledrejection'],
    ]);
  });
});
