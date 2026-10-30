// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '../../../src/v2/contract.gen';
import { StallStrip, stallMinutes } from './StallStrip';

type RunState = components['schemas']['RunState'];

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    status: 'running',
    startedAt: 1000,
    pendingText: null,
    canSend: true,
    canStop: true,
    lockedReason: null,
    error: null,
    lastActivityAt: 2000,
    stalledSince: 2000,
    activeTool: null,
    ...overrides,
  };
}

describe('stallMinutes calculation', () => {
  it('returns at least 1 minute when diff is less than 1 minute', () => {
    expect(stallMinutes(1000, 1000)).toBe(1);
    expect(stallMinutes(1000, 1000 + 30_000)).toBe(1);
    expect(stallMinutes(1000, 1000 + 59_999)).toBe(1);
  });

  it('calculates full minutes accurately', () => {
    expect(stallMinutes(1000, 1000 + 60_000)).toBe(1);
    expect(stallMinutes(1000, 1000 + 119_999)).toBe(1);
    expect(stallMinutes(1000, 1000 + 120_000)).toBe(2);
    expect(stallMinutes(1000, 1000 + 300_000)).toBe(5);
  });

  it('handles clock skew gracefully returning at least 1', () => {
    expect(stallMinutes(2000, 1000)).toBe(1);
  });
});

describe('StallStrip component', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    host?.remove();
    host = null;
    vi.useRealTimers();
  });

  function render(run: RunState, lang: 'zh' | 'en' = 'zh', onStop: () => Promise<unknown> | unknown = vi.fn()) {
    act(() => {
      root!.render(<StallStrip run={run} lang={lang} onStop={onStop} />);
    });
  }

  describe('rendering conditions', () => {
    it('does not render when run is idle, stopped, or failed even if stalledSince is set', () => {
      render(makeRun({ status: 'idle', stalledSince: 50_000 }));
      expect(host!.querySelector('[data-testid="next-stall-strip"]')).toBeNull();

      render(makeRun({ status: 'stopped', stalledSince: 50_000 }));
      expect(host!.querySelector('[data-testid="next-stall-strip"]')).toBeNull();

      render(makeRun({ status: 'failed', stalledSince: 50_000 }));
      expect(host!.querySelector('[data-testid="next-stall-strip"]')).toBeNull();
    });

    it('does not render when run is running but stalledSince is null', () => {
      render(makeRun({ status: 'running', stalledSince: null }));
      expect(host!.querySelector('[data-testid="next-stall-strip"]')).toBeNull();
    });

    it('renders when run is running and stalledSince is a timestamp', () => {
      render(makeRun({ status: 'running', stalledSince: 50_000 }));
      const strip = host!.querySelector('[data-testid="next-stall-strip"]');
      expect(strip).not.toBeNull();
      expect(strip!.getAttribute('role')).toBe('status');
    });
  });

  describe('text content with and without activeTool', () => {
    it('renders only the first half when activeTool is absent (zh & en)', () => {
      // 100_000 - 40_000 = 60_000 ms = 1 min
      render(makeRun({ stalledSince: 40_000, activeTool: null }), 'zh');
      const strip = host!.querySelector('[data-testid="next-stall-strip"]');
      expect(strip!.textContent).toContain('已 1 分钟没有动静');
      expect(host!.querySelector('[data-testid="next-stall-tool"]')).toBeNull();

      render(makeRun({ stalledSince: 40_000, activeTool: null }), 'en');
      expect(host!.querySelector('[data-testid="next-stall-strip"]')!.textContent).toContain('No activity for 1 min');
      expect(host!.querySelector('[data-testid="next-stall-tool"]')).toBeNull();
    });

    it('renders tool summary and prefix when activeTool has summary', () => {
      // 100_000 - 20_000 = 80_000 ms = 1 min
      render(
        makeRun({
          stalledSince: 20_000,
          activeTool: { name: 'bash', startedAt: 10_000, summary: 'npm run build -- --watch' },
        }),
        'zh'
      );
      const toolEl = host!.querySelector('[data-testid="next-stall-tool"]');
      expect(toolEl).not.toBeNull();
      expect(toolEl!.textContent).toContain('正在运行');
      expect(toolEl!.querySelector('code')!.textContent).toBe('npm run build -- --watch');

      render(
        makeRun({
          stalledSince: 20_000,
          activeTool: { name: 'bash', startedAt: 10_000, summary: 'npm run build -- --watch' },
        }),
        'en'
      );
      const enToolEl = host!.querySelector('[data-testid="next-stall-tool"]');
      expect(enToolEl!.textContent).toContain('running');
      expect(enToolEl!.querySelector('code')!.textContent).toBe('npm run build -- --watch');
    });

    it('falls back to tool name if tool summary is empty', () => {
      render(
        makeRun({
          stalledSince: 20_000,
          activeTool: { name: 'bash', startedAt: 10_000, summary: '' },
        }),
        'zh'
      );
      const toolEl = host!.querySelector('[data-testid="next-stall-tool"]');
      expect(toolEl!.querySelector('code')!.textContent).toBe('bash');
    });
  });

  describe('canStop behavior', () => {
    it('does not render stop button when canStop is false', () => {
      render(makeRun({ canStop: false, stalledSince: 40_000 }));
      expect(host!.querySelector('[data-testid="next-stall-stop"]')).toBeNull();
    });

    it('renders stop button when canStop is true', () => {
      render(makeRun({ canStop: true, stalledSince: 40_000 }));
      const btn = host!.querySelector('[data-testid="next-stall-stop"]') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe('停止');
    });
  });

  describe('stop action, disabling and failure recovery', () => {
    it('calls onStop and disables button while stopping', async () => {
      let resolveStop: () => void = () => {};
      const stopPromise = new Promise<void>((resolve) => {
        resolveStop = resolve;
      });
      const onStop = vi.fn(() => stopPromise);

      render(makeRun({ canStop: true, stalledSince: 40_000 }), 'zh', onStop);
      const btn = host!.querySelector('[data-testid="next-stall-stop"]') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);

      act(() => {
        btn.click();
      });

      expect(onStop).toHaveBeenCalledTimes(1);
      expect(btn.disabled).toBe(true);

      // Resolve onStop
      await act(async () => {
        resolveStop();
      });
      // Button stays disabled until run state changes
      expect(btn.disabled).toBe(true);
    });

    it('re-enables stop button if onStop rejects (failure recovery)', async () => {
      let rejectStop: (err: Error) => void = () => {};
      const stopPromise = new Promise<void>((_, reject) => {
        rejectStop = reject;
      });
      const onStop = vi.fn(() => stopPromise);

      render(makeRun({ canStop: true, stalledSince: 40_000 }), 'zh', onStop);
      const btn = host!.querySelector('[data-testid="next-stall-stop"]') as HTMLButtonElement;

      act(() => {
        btn.click();
      });
      expect(btn.disabled).toBe(true);

      await act(async () => {
        rejectStop(new Error('Stop failed'));
      });

      expect(btn.disabled).toBe(false);
    });

    it('resets disabled state when status changes to stopped or stalledSince clears', () => {
      const onStop = vi.fn().mockResolvedValue(undefined);
      render(makeRun({ canStop: true, stalledSince: 40_000 }), 'zh', onStop);
      const btn = host!.querySelector('[data-testid="next-stall-stop"]') as HTMLButtonElement;

      act(() => {
        btn.click();
      });
      expect(btn.disabled).toBe(true);

      // Status updates to stopped
      render(makeRun({ status: 'stopped', canStop: false, stalledSince: null }), 'zh', onStop);
      expect(host!.querySelector('[data-testid="next-stall-strip"]')).toBeNull();
    });
  });

  describe('timer refresh', () => {
    it('refreshes elapsed minutes every 15 seconds', () => {
      // stalledSince is 50_000 ms ago -> 100_000 - 50_000 = 50s (< 60s, so 1 min)
      render(makeRun({ stalledSince: 50_000 }), 'zh');
      const textEl = host!.querySelector('.stall-strip-text b')!;
      expect(textEl.textContent).toBe('已 1 分钟没有动静');

      // Advance by 15s -> system time is 115_000, diff is 65s -> 1 min
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(textEl.textContent).toBe('已 1 分钟没有动静');

      // Advance by another 60s -> system time is 175_000, diff is 125s -> 2 min!
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(textEl.textContent).toBe('已 2 分钟没有动静');
    });
  });
});
