/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../data/store';
import { WorkspaceChip } from './WorkspaceChip';

const { mockState, workspaces } = vi.hoisted(() => {
  const list: Workspace[] = [
    {
      id: 'w1', name: 'alpha', path: '/tmp/alpha', source: 'local',
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
    expect(options.map((el) => el.getAttribute('data-id'))).toEqual(['w1', 'w2']);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      options[1].click();
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

  it('shows 选择工作区 when none exist and opens the new-workspace flow', async () => {
    mockState.list = [];
    const onNew = vi.fn();
    await render(createElement(WorkspaceChip, {
      lang: 'zh',
      selectedId: null,
      canSwitch: true,
      onPick: vi.fn(),
      onNew,
    }));
    expect(host!.querySelector('[data-testid=next-ws-chip]')?.textContent).toContain('选择工作区');
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid=next-ws-chip]')?.click();
    });
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});
