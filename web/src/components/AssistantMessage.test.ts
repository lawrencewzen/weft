// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStreamingThrottle } from './AssistantMessage';

describe('useStreamingThrottle (T55-2b)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    if (host && host.parentNode) {
      host.parentNode.removeChild(host);
      host = null;
    }
    vi.useRealTimers();
  });

  let onValueCallback: (val: string) => void = () => {};

  function Consumer({ text, streaming, intervalMs = 100 }: { text: string; streaming: boolean; intervalMs?: number }) {
    const throttled = useStreamingThrottle(text, streaming, intervalMs);
    onValueCallback(throttled);
    return createElement('span', null, throttled);
  }

  function renderHookHelper(props: { text: string; streaming: boolean; intervalMs?: number }, onValue: (val: string) => void) {
    onValueCallback = onValue;
    return act(async () => {
      root!.render(createElement(Consumer, props));
    });
  }

  it('immediately updates when streaming is false (non-streaming message)', async () => {
    let latest = '';
    await renderHookHelper({ text: 'Hello', streaming: false }, (v) => { latest = v; });
    expect(latest).toBe('Hello');

    await renderHookHelper({ text: 'Hello world', streaming: false }, (v) => { latest = v; });
    expect(latest).toBe('Hello world');
  });

  it('throttles updates to at most once per 100ms when streaming is true', async () => {
    let latest = '';
    await renderHookHelper({ text: 'chunk 1', streaming: true }, (v) => { latest = v; });
    expect(latest).toBe('chunk 1');

    // Rapid deltas within 100ms window
    await renderHookHelper({ text: 'chunk 1 + 2', streaming: true }, (v) => { latest = v; });
    expect(latest).toBe('chunk 1');

    await renderHookHelper({ text: 'chunk 1 + 2 + 3', streaming: true }, (v) => { latest = v; });
    expect(latest).toBe('chunk 1');

    // Advance 50ms - still throttled
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(latest).toBe('chunk 1');

    // Advance remaining 50ms
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(latest).toBe('chunk 1 + 2 + 3');
  });

  it('immediately outputs final text when streaming becomes false', async () => {
    let latest = '';
    await renderHookHelper({ text: 'start', streaming: true }, (v) => { latest = v; });
    expect(latest).toBe('start');

    // In-flight delta before 100ms expires
    await renderHookHelper({ text: 'in-flight text', streaming: true }, (v) => { latest = v; });
    expect(latest).toBe('start');

    // Stream finished
    await renderHookHelper({ text: 'final text', streaming: false }, (v) => { latest = v; });
    expect(latest).toBe('final text');
  });
});
