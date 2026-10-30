/** @vitest-environment jsdom */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarSearch } from './SidebarSearch';
import type { WorkspaceGroup } from '../data/sidebarModel';
import type { ConversationSummary, Workspace } from '../data/store';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function ws(id: string, name = id): Workspace {
  return {
    id,
    name,
    path: `/path/${id}`,
    source: 'local',
    gitUrl: null,
    branch: null,
    git: null,
    conversationCount: 0,
    runningCount: 0,
  };
}

function conv(id: string, workspaceId: string, extra?: Partial<ConversationSummary>): ConversationSummary {
  return {
    id,
    workspaceId,
    title: id,
    updatedAt: 1,
    status: 'idle',
    runningAgents: 0,
    subagents: null,
    archived: false,
    ...extra,
  };
}

const mockGroups: WorkspaceGroup[] = [
  {
    workspace: ws('ws-weft', 'weft'),
    conversations: [
      conv('c1', 'ws-weft', { title: '重构会话列表', updatedAt: 3000, status: 'running' }),
      conv('c2', 'ws-weft', { title: 'heartbeat 单测', updatedAt: 2000, status: 'waiting' }),
      conv('c3', 'ws-weft', { title: '归档的会话', updatedAt: 1000, archived: true }),
    ],
  },
  {
    workspace: ws('ws-web', 'website'),
    conversations: [
      conv('c4', 'ws-web', { title: '首页文案改版', updatedAt: 4000, status: 'idle' }),
      conv('c5', 'ws-web', { title: '架构文档', updatedAt: 2500, status: 'idle' }),
    ],
  },
];

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

describe('SidebarSearch', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
  });

  afterEach(async () => {
    await cleanup();
    document.body.innerHTML = '';
  });

  it('renders under document.body and not inside sidebar container', async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();

    await render(
      <div id="mock-sidebar">
        <SidebarSearch
          lang="zh"
          open={true}
          onClose={onClose}
          groups={mockGroups}
          onSelectConversation={onSelect}
        />
      </div>,
    );

    const sidebar = document.getElementById('mock-sidebar');
    const modal = document.querySelector('[data-testid="next-search-modal"]');
    expect(modal).not.toBeNull();
    expect(modal?.parentElement).toBe(document.body);
    expect(sidebar?.contains(modal)).toBe(false);
  });

  it('shows "最近" label when query is empty, and filters results on input', async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();

    await render(
      <SidebarSearch
        lang="zh"
        open={true}
        onClose={onClose}
        groups={mockGroups}
        onSelectConversation={onSelect}
      />,
    );

    const label = document.querySelector('.search-palette-label');
    expect(label?.textContent).toBe('最近');

    const input = document.querySelector<HTMLInputElement>('[data-testid="next-search-input"]')!;
    expect(input).not.toBeNull();

    // Type query to filter
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '单测');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(document.querySelector('.search-palette-label')).toBeNull();
    const results = document.querySelectorAll('[data-testid="next-search-result"]');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('heartbeat 单测');
  });

  it('navigates with ArrowDown / ArrowUp and selects with Enter', async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();

    await render(
      <SidebarSearch
        lang="zh"
        open={true}
        onClose={onClose}
        groups={mockGroups}
        onSelectConversation={onSelect}
      />,
    );

    const dialog = document.querySelector('.search-palette')!;
    const results = document.querySelectorAll('[data-testid="next-search-result"]');
    expect(results.length).toBeGreaterThan(2);

    // Initial item is selected
    expect(results[0].classList.contains('is-selected')).toBe(true);

    // ArrowDown
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(results[1].classList.contains('is-selected')).toBe(true);

    // ArrowUp
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(results[0].classList.contains('is-selected')).toBe(true);

    // Enter
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('ws-web', 'c4'); // c4 is top ranked by updatedAt
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key and on clicking backdrop overlay', async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();

    await render(
      <SidebarSearch
        lang="zh"
        open={true}
        onClose={onClose}
        groups={mockGroups}
        onSelectConversation={onSelect}
      />,
    );

    // Escape
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Mousedown on overlay
    const overlay = document.querySelector<HTMLElement>('.search-palette-overlay')!;
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clicking inside the dialog does not close
    const dialog = document.querySelector<HTMLElement>('.search-palette')!;
    await act(async () => {
      dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('restores focus to previously active element on close', async () => {
    const triggerBtn = document.createElement('button');
    triggerBtn.setAttribute('data-testid', 'trigger-btn');
    document.body.appendChild(triggerBtn);
    triggerBtn.focus();
    expect(document.activeElement).toBe(triggerBtn);

    function TestHarness() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <SidebarSearch
            lang="zh"
            open={open}
            onClose={() => setOpen(false)}
            groups={mockGroups}
            onSelectConversation={vi.fn()}
          />
          <button type="button" onClick={() => setOpen(false)} data-testid="closer">
            close
          </button>
        </div>
      );
    }

    await render(<TestHarness />);

    // While open, focus is on input
    const input = document.querySelector<HTMLInputElement>('[data-testid="next-search-input"]')!;
    expect(document.activeElement).toBe(input);

    // Close modal
    const closer = document.querySelector<HTMLButtonElement>('[data-testid="closer"]')!;
    await act(async () => {
      closer.click();
    });

    // Focus restored to triggerBtn
    expect(document.activeElement).toBe(triggerBtn);
    triggerBtn.remove();
  });

  it('traps Tab navigation within the palette dialog', async () => {
    await render(
      <SidebarSearch
        lang="zh"
        open={true}
        onClose={vi.fn()}
        groups={mockGroups}
        onSelectConversation={vi.fn()}
      />,
    );

    const input = document.querySelector<HTMLInputElement>('[data-testid="next-search-input"]')!;
    const escBtn = document.querySelector<HTMLButtonElement>('.search-palette-esc')!;

    input.focus();
    expect(document.activeElement).toBe(input);

    // Shift+Tab from input wraps to last focusable (escBtn)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
    });
    expect(document.activeElement).toBe(escBtn);

    // Tab from escBtn wraps to first focusable (input)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false }));
    });
    expect(document.activeElement).toBe(input);
  });
});
