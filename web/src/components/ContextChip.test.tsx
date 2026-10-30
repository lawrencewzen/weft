/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextBanner, ContextChip } from './ContextChip';
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

  it('renders as a non-interactive span without popup menu attributes', async () => {
    const context: ContextUsage = {
      used: 48_200,
      window: 64_000,
      percent: 75,
      level: 'ok',
    };

    await render(<ContextChip lang="zh" context={context} />);

    const chip = host?.querySelector('[data-testid="next-context-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.tagName.toLowerCase()).toBe('span');
    expect(chip?.getAttribute('aria-haspopup')).toBeNull();
    expect(chip?.textContent).toContain('75%');
    expect(chip?.getAttribute('title')).toContain('48.2k / 64k');
    expect(chip?.getAttribute('title')).toContain('已用 75%');
    expect(chip?.getAttribute('title')).toContain('剩余 25%');

    // Click does not open any menu
    await act(async () => {
      (chip as HTMLElement).click();
    });
    expect(document.querySelector('[data-testid="next-context-menu"]')).toBeNull();
    expect(document.querySelector('.context-menu')).toBeNull();
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

  it('renders ContextBanner only when warn or full', async () => {
    const onNewChat = vi.fn();
    const okContext: ContextUsage = {
      used: 10_000,
      window: 64_000,
      percent: 15,
      level: 'ok',
    };

    await render(<ContextBanner lang="zh" context={okContext} onNewChat={onNewChat} />);
    expect(host?.querySelector('[data-testid="next-context-banner"]')).toBeNull();

    await cleanup();

    const warnContext: ContextUsage = {
      used: 52_000,
      window: 64_000,
      percent: 81,
      level: 'warn',
    };

    await render(<ContextBanner lang="zh" context={warnContext} onNewChat={onNewChat} />);
    const banner = host?.querySelector('[data-testid="next-context-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('81%');

    const newBtn = host?.querySelector('[data-testid="next-context-new"]') as HTMLButtonElement;
    await act(async () => {
      newBtn.click();
    });
    expect(onNewChat).toHaveBeenCalled();
  });
});
