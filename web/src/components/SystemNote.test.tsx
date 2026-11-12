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

  it('renders the compaction divider with icon, title, meta and an expandable summary', async () => {
    const item: Item = {
      kind: 'system_note',
      id: 'sn-compaction',
      text: '之前 12 条已摘要',
      noteKind: 'compaction',
      detail: '### 对话摘要\n\n已完成任务 B。',
    };

    await act(async () => {
      root!.render(<SystemNote item={item} lang="zh" />);
    });

    const note = host!.querySelector('[data-testid="next-item-system-note"]');
    expect(note?.getAttribute('data-kind')).toBe('compaction');
    expect(note?.classList.contains('handoff-divider-container')).toBe(true);
    const divider = host!.querySelector('[data-testid="next-compaction-divider"]');
    expect(divider).not.toBeNull();
    expect(divider?.querySelector('svg.handoff-divider-icon')).not.toBeNull();
    expect(divider?.querySelector('[data-testid="next-compaction-title"]')?.textContent).toBe('上下文已压缩');
    expect(divider?.querySelector('[data-testid="next-compaction-meta"]')?.textContent).toBe('之前 12 条已摘要');

    const toggle = host!.querySelector('[data-testid="next-compaction-toggle"]') as HTMLButtonElement;
    expect(toggle.textContent).toContain('摘要');
    expect(host!.querySelector('[data-testid="next-compaction-detail"]')).toBeNull();

    await act(async () => {
      toggle.click();
    });
    const detail = host!.querySelector('[data-testid="next-compaction-detail"]');
    expect(detail?.textContent).toContain('对话摘要');
    expect(detail?.textContent).toContain('已完成任务 B。');

    await act(async () => {
      toggle.click();
    });
    expect(host!.querySelector('[data-testid="next-compaction-detail"]')).toBeNull();
  });

  it('renders the compaction divider in English and without a toggle when there is no summary', async () => {
    const item: Item = {
      kind: 'system_note',
      id: 'sn-compaction-en',
      text: 'Previous 3 items summarized',
      noteKind: 'compaction',
    };

    await act(async () => {
      root!.render(<SystemNote item={item} lang="en" />);
    });

    expect(host!.querySelector('[data-testid="next-compaction-title"]')?.textContent).toBe('Context compacted');
    expect(host!.querySelector('[data-testid="next-compaction-meta"]')?.textContent).toBe('Previous 3 items summarized');
    expect(host!.querySelector('[data-testid="next-compaction-toggle"]')).toBeNull();
  });

  it('keeps the handoff divider without icon or meta', async () => {
    const item: Item = {
      kind: 'system_note',
      id: 'sn-handoff-plain',
      text: '新上下文',
      noteKind: 'handoff',
      detail: '交接说明',
    };

    await act(async () => {
      root!.render(<SystemNote item={item} lang="zh" />);
    });

    expect(host!.querySelector('.handoff-divider-icon')).toBeNull();
    expect(host!.querySelector('[data-testid="next-handoff-meta"]')).toBeNull();
    // Model-initiated (no request): no user bubble
    expect(host!.querySelector('[data-testid="next-item-user"]')).toBeNull();
  });

  it('renders a user bubble with handoff chip and instructions when requested by user', async () => {
    const item = {
      kind: 'system_note' as const,
      id: 'sn-user-handoff',
      text: '新上下文',
      noteKind: 'handoff' as const,
      detail: '交接说明全文',
      request: { by: 'user' as const, instructions: '重点测试权限' },
    };

    await act(async () => {
      root!.render(<SystemNote item={item} lang="zh" />);
    });

    const userBubble = host!.querySelector('[data-testid="next-item-user"]');
    expect(userBubble).not.toBeNull();
    expect(userBubble?.getAttribute('data-command')).toBe('handoff');
    const chip = userBubble?.querySelector('[data-testid="next-user-chip"]');
    expect(chip?.textContent).toBe('交接');
    expect(chip?.getAttribute('data-kind')).toBe('handoff');
    expect(userBubble?.textContent).toContain('重点测试权限');

    const divider = host!.querySelector('[data-testid="next-handoff-divider"]');
    expect(divider).not.toBeNull();
  });

  it('renders a user bubble with handoff chip only when requested by user without instructions', async () => {
    const item = {
      kind: 'system_note' as const,
      id: 'sn-user-handoff-no-inst',
      text: '新上下文',
      noteKind: 'handoff' as const,
      detail: '交接说明全文',
      request: { by: 'user' as const },
    };

    await act(async () => {
      root!.render(<SystemNote item={item} lang="zh" />);
    });

    const userBubble = host!.querySelector('[data-testid="next-item-user"]');
    expect(userBubble).not.toBeNull();
    const chip = userBubble?.querySelector('[data-testid="next-user-chip"]');
    expect(chip?.textContent).toBe('交接');

    const divider = host!.querySelector('[data-testid="next-handoff-divider"]');
    expect(divider).not.toBeNull();
  });

  it('renders a user bubble with compaction chip when compaction was requested by user', async () => {
    const item = {
      kind: 'system_note' as const,
      id: 'sn-user-compaction',
      text: '之前 5 条已摘要',
      noteKind: 'compaction' as const,
      detail: '压缩摘要',
      request: { by: 'user' as const },
    };

    await act(async () => {
      root!.render(<SystemNote item={item} lang="zh" />);
    });

    const userBubble = host!.querySelector('[data-testid="next-item-user"]');
    expect(userBubble).not.toBeNull();
    expect(userBubble?.getAttribute('data-command')).toBe('compaction');
    const chip = userBubble?.querySelector('[data-testid="next-user-chip"]');
    expect(chip?.textContent).toBe('压缩');
    expect(chip?.getAttribute('data-kind')).toBe('compaction');

    const divider = host!.querySelector('[data-testid="next-compaction-divider"]');
    expect(divider).not.toBeNull();
  });

  it('does not render a user bubble for model-initiated compaction or handoff', async () => {
    const handoffItem = {
      kind: 'system_note' as const,
      id: 'sn-model-handoff',
      text: '新上下文',
      noteKind: 'handoff' as const,
      request: { by: 'model' as const },
    };

    await act(async () => {
      root!.render(<SystemNote item={handoffItem} lang="zh" />);
    });
    expect(host!.querySelector('[data-testid="next-item-user"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-handoff-divider"]')).not.toBeNull();

    const compactionItem = {
      kind: 'system_note' as const,
      id: 'sn-model-compaction',
      text: '之前 5 条已摘要',
      noteKind: 'compaction' as const,
      request: { by: 'model' as const },
    };

    await act(async () => {
      root!.render(<SystemNote item={compactionItem} lang="zh" />);
    });
    expect(host!.querySelector('[data-testid="next-item-user"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-compaction-divider"]')).not.toBeNull();
  });
});
