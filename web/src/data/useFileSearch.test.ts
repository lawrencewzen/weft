/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { useFileSearch, type UseFileSearchResult } from './useFileSearch';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: UseFileSearchResult | null = null;

function TestComponent({
  workspaceId,
  query,
  limit,
}: {
  workspaceId: string | null;
  query: string;
  limit?: number;
}) {
  latest = useFileSearch(workspaceId, query, { limit, debounceMs: 150 });
  return null;
}

async function renderHook(workspaceId: string | null, query: string, limit?: number) {
  await act(async () => {
    root!.render(
      createElement(TestComponent, {
        workspaceId,
        query,
        limit,
      }),
    );
  });
}

describe('useFileSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    latest = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (host) {
      host.remove();
      host = null;
    }
    latest = null;
  });

  it('does not search when workspaceId is null or query is empty', async () => {
    const searchSpy = vi.spyOn(api, 'searchWorkspaceFiles');
    await renderHook(null, 'test');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(searchSpy).not.toHaveBeenCalled();
    expect(latest?.entries).toEqual([]);
    expect(latest?.loading).toBe(false);

    await renderHook('ws1', '   ');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(searchSpy).not.toHaveBeenCalled();
    expect(latest?.entries).toEqual([]);
  });

  it('debounces calls by 150ms and receives results', async () => {
    const searchSpy = vi.spyOn(api, 'searchWorkspaceFiles').mockResolvedValueOnce({
      entries: [{ path: 'test.ts', score: 10 }],
      truncated: false,
    });

    await renderHook('ws1', 'test');
    expect(searchSpy).not.toHaveBeenCalled();
    expect(latest?.loading).toBe(true);

    // Advance 140ms - should still be waiting
    act(() => {
      vi.advanceTimersByTime(140);
    });
    expect(searchSpy).not.toHaveBeenCalled();

    // Advance past 150ms
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledWith('ws1', 'test', 50, expect.any(AbortSignal));
    expect(latest?.entries).toEqual([{ path: 'test.ts', score: 10 }]);
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
  });

  it('cancels pending debounce when query changes rapidly', async () => {
    const searchSpy = vi.spyOn(api, 'searchWorkspaceFiles').mockResolvedValue({
      entries: [{ path: 'final.ts', score: 20 }],
      truncated: false,
    });

    await renderHook('ws1', 'a');
    act(() => {
      vi.advanceTimersByTime(50);
    });
    await renderHook('ws1', 'ab');
    act(() => {
      vi.advanceTimersByTime(50);
    });
    await renderHook('ws1', 'abc');

    expect(searchSpy).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(160);
    });

    // Only 'abc' should have triggered a call
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledWith('ws1', 'abc', 50, expect.any(AbortSignal));
    expect(latest?.entries).toEqual([{ path: 'final.ts', score: 20 }]);
  });

  it('aborts in-flight request when newer query arrives and does not overwrite newer result', async () => {
    let resolveFirst!: (val: api.FileSearchResult) => void;
    let signalFirst!: AbortSignal;

    const searchSpy = vi.spyOn(api, 'searchWorkspaceFiles').mockImplementation((_ws, q, _limit, signal) => {
      if (q === 'first') {
        signalFirst = signal!;
        return new Promise<api.FileSearchResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        entries: [{ path: 'second.ts', score: 100 }],
        truncated: false,
      });
    });

    // 1. Trigger first request
    await renderHook('ws1', 'first');
    await act(async () => {
      vi.advanceTimersByTime(160);
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(signalFirst.aborted).toBe(false);

    // 2. Trigger second request while first is still pending
    await renderHook('ws1', 'second');
    expect(signalFirst.aborted).toBe(true); // first controller was aborted

    await act(async () => {
      vi.advanceTimersByTime(160);
    });
    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(latest?.entries).toEqual([{ path: 'second.ts', score: 100 }]);

    // 3. Now let first request resolve late
    await act(async () => {
      resolveFirst({
        entries: [{ path: 'stale-first.ts', score: 5 }],
        truncated: false,
      });
    });

    // Entries should still be the result of 'second', never overwritten by 'first'
    expect(latest?.entries).toEqual([{ path: 'second.ts', score: 100 }]);
  });

  it('handles API error without throwing and sets error state', async () => {
    vi.spyOn(api, 'searchWorkspaceFiles').mockRejectedValueOnce(new Error('Network failure'));

    await renderHook('ws1', 'error-test');
    await act(async () => {
      vi.advanceTimersByTime(160);
    });

    expect(latest?.entries).toEqual([]);
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBe('Network failure');
  });

  it('clears results immediately when query is emptied', async () => {
    vi.spyOn(api, 'searchWorkspaceFiles').mockResolvedValueOnce({
      entries: [{ path: 'a.ts' }],
      truncated: false,
    });

    await renderHook('ws1', 'foo');
    await act(async () => {
      vi.advanceTimersByTime(160);
    });
    expect(latest?.entries).toHaveLength(1);

    await renderHook('ws1', '');
    expect(latest?.entries).toEqual([]);
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
  });
});
