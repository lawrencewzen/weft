/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../data/store';
import { WorkspaceChip } from './WorkspaceChip';

const { mockState, workspaces } = vi.hoisted(() => {
  const list: Workspace[] = [
    {
      id: 'w1', name: 'alpha', path: '/Users/alice/code/team/monorepo/apps/desktop/weft', source: 'local',
      gitUrl: null, branch: null, git: null, conversationCount: 0, runningCount: 0,
    },
    {
      id: 'w2', name: 'beta', path: '/tmp/beta', source: 'local',
      gitUrl: null, branch: null, git: null, conversationCount: 1, runningCount: 0,
    },
  ];
  return { workspaces: list, mockState: { list } };
});

vi.mock('../data/useWorkspaces', () => ({
  useWorkspaces: () => ({
    workspaces: mockState.list,
    conversations: [],
    groups: [],
    latest: undefined,
    ready: true,
    status: 'open',
  }),
}));

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
  }
  host?.remove();
  root = null;
  host = null;
}

afterEach(async () => {
  mockState.list = workspaces;
  await cleanup();
});

describe('WorkspaceChip', () => {
  it('lets a draft switch workspaces and keeps the current item checked', async () => {
    const onPick = vi.fn();
    const onNew = vi.fn();
    await render(createElement(WorkspaceChip, {
      lang: 'zh',
      selectedId: 'w1',
      canSwitch: true,
      onPick,
      onNew,
    }));
    expect(host!.querySelector('[data-testid=next-ws-chip]')?.textContent).toContain('alpha');
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid=next-ws-chip]')?.click();
    });
    const menu = host!.querySelector('[data-testid=next-ws-chip-menu]');
    expect(menu).toBeTruthy();
    const options = [...host!.querySelectorAll<HTMLButtonElement>('[data-testid=next-ws-chip-option]')];
    expect(options.map((el) => el.getAttribute('data-id'))).toEqual(['__none__', 'w1', 'w2']);
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(options[1].getAttribute('title')).toBe('/Users/alice/code/team/monorepo/apps/desktop/weft');
    expect(options[1].querySelector('.ws-chip-path')?.textContent).toBe('~/…/weft');
    expect(options[1].querySelector('.ws-chip-path')?.textContent).not.toContain('\n');
    await act(async () => {
      options[2].click();
    });
    expect(onPick).toHaveBeenCalledWith('w2');
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid=next-ws-chip]')?.click();
    });
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid=next-ws-chip-new]')?.click();
    });
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('does not switch on an existing conversation and shows the bound hint', async () => {
    const onPick = vi.fn();
    const onNew = vi.fn();
    await render(createElement(WorkspaceChip, {
      lang: 'zh',
      selectedId: 'w2',
      canSwitch: false,
      onPick,
      onNew,
    }));
    expect(host!.querySelector('[data-testid=next-ws-chip]')?.getAttribute('data-bound')).toBe('true');
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid=next-ws-chip]')?.click();
    });
    expect(host!.querySelector('[data-testid=next-ws-chip-menu]')).toBeNull();
    expect(host!.querySelector('[data-testid=next-ws-chip-bound-hint]')?.textContent).toContain('已绑定');
    expect(onPick).not.toHaveBeenCalled();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('shows 不选项目 when none exist and lists it first in the menu', async () => {
    mockState.list = [];
    const onPick = vi.fn();
    const onNew = vi.fn();
    await render(createElement(WorkspaceChip, {
      lang: 'zh',
      selectedId: null,
      canSwitch: true,
      onPick,
      onNew,
    }));
    expect(host!.querySelector('[data-testid=next-ws-chip]')?.textContent).toContain('不选项目');
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid=next-ws-chip]')?.click();
    });
    const options = [...host!.querySelectorAll<HTMLButtonElement>('[data-testid=next-ws-chip-option]')];
    expect(options.map((el) => el.getAttribute('data-id'))).toEqual(['__none__']);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(onNew).not.toHaveBeenCalled();
  });

  it('puts 不选项目 first and reports null when it is picked', async () => {
    const onPick = vi.fn();
    await render(createElement(WorkspaceChip, {
      lang: 'zh',
      selectedId: 'w1',
      canSwitch: true,
      onPick,
      onNew: vi.fn(),
    }));
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid=next-ws-chip]')?.click();
    });
    const none = host!.querySelector<HTMLButtonElement>('[data-testid=next-ws-chip-option][data-id="__none__"]');
    expect(none?.textContent).toContain('不选项目');
    await act(async () => { none?.click(); });
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('hides chat workspaces from the picker and treats them as 不选项目', async () => {
    mockState.list = [
      ...workspaces,
      {
        id: 'ws-chat', name: '代码咨询', path: 'D:\\data\\chats\\c-consult', source: 'local',
        gitUrl: null, branch: null, git: null, conversationCount: 1, runningCount: 0, kind: 'chat',
      },
    ];
    await render(createElement(WorkspaceChip, {
      lang: 'zh',
      selectedId: 'ws-chat',
      canSwitch: true,
      onPick: vi.fn(),
      onNew: vi.fn(),
    }));
    expect(host!.querySelector('[data-testid=next-ws-chip]')?.textContent).toContain('不选项目');
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid=next-ws-chip]')?.click();
    });
    const options = [...host!.querySelectorAll<HTMLButtonElement>('[data-testid=next-ws-chip-option]')];
    expect(options.map((el) => el.getAttribute('data-id'))).toEqual(['__none__', 'w1', 'w2']);
  });

  it('opens a project menu on right-click with open-in-terminal', async () => {
    const onOpenTerminal = vi.fn();
    const onCopyPath = vi.fn();
    await render(createElement(WorkspaceChip, {
      lang: 'zh',
      selectedId: 'w1',
      canSwitch: false,
      onPick: vi.fn(),
      onNew: vi.fn(),
      onOpenTerminal,
      onCopyPath,
    }));
    const trigger = host!.querySelector<HTMLButtonElement>('[data-testid=next-ws-chip]');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    });
    const menu = host!.querySelector('[data-testid=next-ctx-menu]');
    expect(menu).toBeTruthy();
    const openItem = host!.querySelector<HTMLButtonElement>('[data-action=open-terminal]');
    expect(openItem?.textContent).toContain('在终端中打开');
    await act(async () => { openItem?.click(); });
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
  });

  it('renders the draft hero picker with the same workspace options', async () => {
    const onPick = vi.fn();
    await render(createElement(WorkspaceChip, {
      lang: 'zh',
      selectedId: 'w1',
      canSwitch: true,
      variant: 'hero',
      onPick,
      onNew: vi.fn(),
    }));
    const trigger = host!.querySelector<HTMLButtonElement>('[data-testid=next-draft-hero-ws]');
    expect(trigger?.textContent).toContain('alpha');
    expect(host!.querySelector('[data-testid=next-ws-chip]')).toBeNull();
    await act(async () => { trigger?.click(); });
    expect(host!.querySelector('[data-testid=next-draft-hero-menu]')).toBeTruthy();
    const options = [...host!.querySelectorAll<HTMLButtonElement>('[data-testid=next-ws-chip-option]')];
    expect(options.map((el) => el.getAttribute('data-id'))).toEqual(['__none__', 'w1', 'w2']);
    await act(async () => { options[2].click(); });
    expect(onPick).toHaveBeenCalledWith('w2');
  });
});
