/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideToggles } from './RightToggle';

const hoisted = vi.hoisted(() => ({
  leftOpen: false,
  toggleLeft: vi.fn(),
  rightOpen: false,
  toggleRight: vi.fn(),
  hasChanges: false,
}));

vi.mock('../data/leftPanelContext', () => ({
  useLeftPanel: () => ({
    leftOpen: hoisted.leftOpen,
    toggleLeft: hoisted.toggleLeft,
  }),
}));

vi.mock('../data/rightPaneContext', () => ({
  useRightLayout: () => ({
    open: hoisted.rightOpen,
    toggleRight: hoisted.toggleRight,
  }),
  useRightChanges: () => ({
    hasChanges: hoisted.hasChanges,
  }),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function renderToggles(lang: 'zh' | 'en' = 'zh') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<SideToggles lang={lang} />);
  });
}

async function cleanup() {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  if (host?.parentNode) {
    host.parentNode.removeChild(host);
    host = null;
  }
}

describe('SideToggles component', () => {
  beforeEach(() => {
    hoisted.leftOpen = false;
    hoisted.rightOpen = false;
    hoisted.hasChanges = false;
    hoisted.toggleLeft.mockReset();
    hoisted.toggleRight.mockReset();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('renders side-toggle-right with dot off when hasChanges is false', async () => {
    await renderToggles('zh');
    const rightBtn = host?.querySelector<HTMLButtonElement>('.side-toggle-right');
    expect(rightBtn).not.toBeNull();
    expect(rightBtn?.getAttribute('data-testid')).toBe('next-right-toggle');
    expect(rightBtn?.getAttribute('aria-expanded')).toBe('false');

    const dot = rightBtn?.querySelector('[data-testid="next-right-dot"]');
    expect(dot).not.toBeNull();
    expect(dot?.classList.contains('is-on')).toBe(false);

    await act(async () => {
      rightBtn?.click();
    });
    expect(hoisted.toggleRight).toHaveBeenCalledTimes(1);
  });

  it('shows green dot (is-on) when hasChanges is true and toggle collapses when open', async () => {
    hoisted.hasChanges = true;
    hoisted.rightOpen = true;
    await renderToggles('zh');

    const rightBtn = host?.querySelector<HTMLButtonElement>('.side-toggle-right');
    expect(rightBtn).not.toBeNull();
    expect(rightBtn?.getAttribute('data-testid')).toBe('next-right-collapse');
    expect(rightBtn?.getAttribute('aria-expanded')).toBe('true');

    const dot = rightBtn?.querySelector('[data-testid="next-right-dot"]');
    expect(dot).not.toBeNull();
    expect(dot?.classList.contains('is-on')).toBe(true);
  });
});
