/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextChip } from './ContextChip';
import type { ContextUsage } from '../data/composerModel';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(node: Parameters<Root['render']>[0]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

async function cleanup() {
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
}

describe('ContextChip component', () => {
  beforeEach(() => {});

  afterEach(async () => {
    await cleanup();
  });

  it('renders only the ring below 70% with percent in title tooltip, and shows number at 70% and above', async () => {
    const lowContext: ContextUsage = {
      used: 12_000,
      window: 100_000,
      percent: 12,
      level: 'ok',
    };
    await render(<ContextChip lang="zh" context={lowContext} />);
    const chipLow = host?.querySelector('[data-testid="next-context-chip"]') as HTMLButtonElement;
    expect(chipLow).not.toBeNull();
    expect(chipLow.querySelector('.context-chip-pct')).toBeNull();
    expect(chipLow.classList.contains('has-num')).toBe(false);
    expect(chipLow.getAttribute('title')).toContain('已用 12%');

    await cleanup();

    const threshContext: ContextUsage = {
      used: 70_000,
      window: 100_000,
      percent: 70,
      level: 'warn',
    };
    await render(<ContextChip lang="zh" context={threshContext} />);
    const chipThresh = host?.querySelector('[data-testid="next-context-chip"]') as HTMLButtonElement;
    expect(chipThresh).not.toBeNull();
    expect(chipThresh.querySelector('.context-chip-pct')).not.toBeNull();
    expect(chipThresh.textContent).toContain('70%');
    expect(chipThresh.classList.contains('has-num')).toBe(true);
  });

  async function openPanel(compact?: Parameters<typeof ContextChip>[0]['compact']) {
    const context: ContextUsage = { used: 12_000, window: 500_000, percent: 2, level: 'ok' };
    await render(<ContextChip lang="zh" context={context} compact={compact} />);
    const chip = host?.querySelector('[data-testid="next-context-chip"]') as HTMLButtonElement;
    await act(async () => { chip.click(); });
    return chip;
  }

  it('opens a panel with used / window and compact, focusing the action', async () => {
    const onCompact = vi.fn();
    const chip = await openPanel({ state: 'idle', onCompact });
    const pop = host?.querySelector('[data-testid="next-context-pop"]') as HTMLElement;
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.getAttribute('aria-controls')).toBe(pop.id);
    expect(host?.querySelector('[data-testid="next-context-pop-usage"]')?.textContent).toBe('12k / 500k');
    const act1 = host?.querySelector('[data-testid="next-menu-compact"]') as HTMLButtonElement;
    expect(act1.textContent).toBe('立即压缩');
    expect(document.activeElement).toBe(act1);
    await act(async () => { act1.click(); });
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it('disables compact while running and when unavailable', async () => {
    await openPanel({ state: 'running', onCompact: vi.fn() });
    const btn = host?.querySelector('[data-testid="next-menu-compact"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(host?.querySelector('[data-testid="next-compact-spin"]')).not.toBeNull();
    await cleanup();
    await openPanel(undefined);
    const none = host?.querySelector('[data-testid="next-menu-compact"]') as HTMLButtonElement;
    expect(none.disabled).toBe(true);
  });

  it('shows the failure message on the action', async () => {
    await openPanel({ state: 'failed', error: '压缩失败', onCompact: vi.fn() });
    expect(host?.querySelector('[data-testid="next-menu-compact"]')?.textContent).toContain('压缩失败');
  });

  it('closes on Escape (focus back to the chip) and on outside mousedown', async () => {
    const chip = await openPanel({ state: 'idle', onCompact: vi.fn() });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host?.querySelector('[data-testid="next-context-pop"]')).toBeNull();
    expect(document.activeElement).toBe(chip);
    await act(async () => { chip.click(); });
    expect(host?.querySelector('[data-testid="next-context-pop"]')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(host?.querySelector('[data-testid="next-context-pop"]')).toBeNull();
  });

  it('toggles closed when the chip is clicked again', async () => {
    const chip = await openPanel({ state: 'idle', onCompact: vi.fn() });
    await act(async () => { chip.click(); });
    expect(host?.querySelector('[data-testid="next-context-pop"]')).toBeNull();
  });

  it('adds is-warn class when context level is warn or full', async () => {
    const context: ContextUsage = {
      used: 52_000,
      window: 64_000,
      percent: 81,
      level: 'warn',
    };

    await render(<ContextChip lang="zh" context={context} />);

    const chip = host?.querySelector('[data-testid="next-context-chip"]');
    expect(chip?.classList.contains('is-warn')).toBe(true);
  });
});
