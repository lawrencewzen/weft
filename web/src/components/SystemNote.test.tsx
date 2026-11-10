// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemNote } from './SystemNote';
import type { components } from '../../../src/v2/contract.gen';

vi.mock('../data/rightPaneContext', () => ({
  useRightActions: () => ({ openFile: vi.fn() }),
}));

type Item = components['schemas']['ThreadItemSystemNote'];

describe('SystemNote (T105-2)', () => {
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

  it('always uses next-item-system-note and does not use next-auto-continue-note', async () => {
    const item: Item = {
      kind: 'system_note',
      id: 'sn-1',
      text: '系统提示说明',
      noteKind: 'note',
    };

    await act(async () => {
      root!.render(<SystemNote item={item} lang="zh" />);
    });

    const el = host!.querySelector('[data-testid="next-item-system-note"]');
    expect(el).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-auto-continue-note"]')).toBeNull();
  });

  it('renders divider line and expands/collapses detail for noteKind handoff', async () => {
    const item: Item = {
      kind: 'system_note',
      id: 'sn-handoff',
      text: '新上下文',
      noteKind: 'handoff',
      detail: '### 交接说明\n\n已完成任务 A。',
    };

    await act(async () => {
      root!.render(<SystemNote item={item} lang="zh" />);
    });

    const note = host!.querySelector('[data-testid="next-item-system-note"]');
    expect(note).not.toBeNull();
    expect(note?.getAttribute('data-kind')).toBe('handoff');

    const divider = host!.querySelector('[data-testid="next-handoff-divider"]');
    expect(divider).not.toBeNull();
    expect(divider?.querySelector('[data-testid="next-handoff-title"]')?.textContent).toBe('新上下文');

    const toggle = host!.querySelector('[data-testid="next-handoff-toggle"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toContain('交接说明');

    // Initially collapsed
    expect(host!.querySelector('[data-testid="next-handoff-detail"]')).toBeNull();

    // Click to expand
    await act(async () => {
      toggle.click();
    });
    const detail = host!.querySelector('[data-testid="next-handoff-detail"]');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain('交接说明');
    expect(detail?.textContent).toContain('已完成任务 A。');

    // Click to collapse
    await act(async () => {
      toggle.click();
    });
    expect(host!.querySelector('[data-testid="next-handoff-detail"]')).toBeNull();
  });

  it('renders English text for noteKind handoff when lang is en', async () => {
    const item: Item = {
      kind: 'system_note',
      id: 'sn-handoff-en',
      text: 'New context',
      noteKind: 'handoff',
      detail: 'Handoff summary',
    };

    await act(async () => {
      root!.render(<SystemNote item={item} lang="en" />);
    });

    expect(host!.querySelector('[data-testid="next-handoff-title"]')?.textContent).toBe('New context');
    expect(host!.querySelector('[data-testid="next-handoff-toggle"]')?.textContent).toContain('Handoff notes');
  });
});
