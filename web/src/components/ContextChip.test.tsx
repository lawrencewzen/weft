/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('renders only the ring below 70% with usage in title tooltip, and shows number at 70% and above', async () => {
    const lowContext: ContextUsage = {
      used: 6_800,
      window: 1_000_000,
      percent: 1,
      level: 'ok',
    };
    await render(<ContextChip lang="zh" context={lowContext} />);
    const chipLow = host?.querySelector('[data-testid="next-context-chip"]') as HTMLButtonElement;
    expect(chipLow).not.toBeNull();
    expect(chipLow.querySelector('.context-chip-pct')).toBeNull();
    expect(chipLow.classList.contains('has-num')).toBe(false);
    expect(chipLow.getAttribute('title')).toBe('6.8k / 1M');

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
    expect(chipThresh.getAttribute('title')).toBe('70k / 100k');
  });

  it('does not open any popup menu on click; click is a no-op', async () => {
    const context: ContextUsage = { used: 12_000, window: 500_000, percent: 2, level: 'ok' };
    await render(<ContextChip lang="zh" context={context} />);
    const chip = host?.querySelector('[data-testid="next-context-chip"]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    await act(async () => {
      chip.click();
    });
    expect(host?.querySelector('[data-testid="next-context-pop"]')).toBeNull();
    expect(host?.querySelector('[data-testid="next-menu-compact"]')).toBeNull();
    expect(host?.querySelector('[data-testid="next-menu-handoff"]')).toBeNull();
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
