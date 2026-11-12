// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserCommandBubble } from './UserCommandBubble';

vi.mock('../data/rightPaneContext', () => ({
  useRightActions: () => ({ openFile: vi.fn() }),
}));

describe('UserCommandBubble', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  });

  it('renders handoff chip and instructions in user bubble', async () => {
    await act(async () => {
      root!.render(<UserCommandBubble kind="handoff" instructions="重点检查单测" lang="zh" id="test-1" />);
    });
    const bubble = host!.querySelector('[data-testid="next-item-user"]');
    expect(bubble).not.toBeNull();
    expect(bubble?.getAttribute('data-role')).toBe('user');
    expect(bubble?.getAttribute('data-command')).toBe('handoff');
    expect(bubble?.getAttribute('data-id')).toBe('test-1');

    const chip = bubble?.querySelector('[data-testid="next-user-chip"]');
    expect(chip?.textContent).toBe('交接');
    expect(chip?.getAttribute('data-kind')).toBe('handoff');
    expect(bubble?.textContent).toContain('重点检查单测');
  });

  it('renders compaction chip without instructions in user bubble', async () => {
    await act(async () => {
      root!.render(<UserCommandBubble kind="compaction" lang="zh" />);
    });
    const bubble = host!.querySelector('[data-testid="next-item-user"]');
    expect(bubble).not.toBeNull();
    expect(bubble?.getAttribute('data-command')).toBe('compaction');

    const chip = bubble?.querySelector('[data-testid="next-user-chip"]');
    expect(chip?.textContent).toBe('压缩');
    expect(chip?.getAttribute('data-kind')).toBe('compaction');
  });

  it('renders English labels when lang is en', async () => {
    await act(async () => {
      root!.render(<UserCommandBubble kind="handoff" instructions="Check migrations" lang="en" />);
    });
    const chip = host!.querySelector('[data-testid="next-user-chip"]');
    expect(chip?.textContent).toBe('Handoff');
  });
});
