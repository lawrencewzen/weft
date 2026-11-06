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

  it('renders a focusable button that keeps its title and calls onOpen', async () => {
    const context: ContextUsage = {
      used: 48_200,
      window: 64_000,
      percent: 75,
      level: 'ok',
    };
    const onOpen = vi.fn();

    await render(<ContextChip lang="zh" context={context} onOpen={onOpen} />);

    const chip = host?.querySelector('[data-testid="next-context-chip"]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.tagName.toLowerCase()).toBe('button');
    expect(chip.type).toBe('button');
    expect(chip.textContent).toContain('75%');
    expect(chip.getAttribute('title')).toContain('48.2k / 64k');
    expect(chip.getAttribute('title')).toContain('已用 75%');
    expect(chip.getAttribute('title')).toContain('剩余 25%');

    await act(async () => {
      chip.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
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
