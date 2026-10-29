// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePendingSend } from './usePendingSend';

// Tell React we are in a testing environment that supports act()
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('usePendingSend hook', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('adds optimistic item on send and clears when conversation changes', async () => {
    let hookResult!: ReturnType<typeof usePendingSend>;
    let setConvId!: (id: string | null) => void;
    const sendFn = vi.fn().mockResolvedValue(undefined);

    function TestComponent() {
      const [convId, setCid] = useState<string | null>('conv-1');
      setConvId = setCid;
      const res = usePendingSend([], sendFn, null, convId);
      hookResult = res;
      return createElement('div', null, res.pending.length);
    }

    await act(async () => {
      root?.render(createElement(TestComponent));
    });

    expect(hookResult.pending).toEqual([]);

    await act(async () => {
      await hookResult.send('hello world', 'req-1');
    });

    expect(hookResult.pending.length).toBe(1);
    expect(hookResult.pending[0]).toMatchObject({ kind: 'user', text: 'hello world' });

    // Switch conversation resets pending state
    await act(async () => {
      setConvId('conv-2');
    });

    expect(hookResult.pending).toEqual([]);
  });
});
