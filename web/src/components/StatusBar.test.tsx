// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusBar } from './StatusBar';
import type { components } from '../../../src/v2/contract.gen';

type ConversationView = components['schemas']['ConversationView'];

describe('StatusBar', () => {
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

  function makeConv(
    title: string,
    id = 'c-test',
  ): ConversationView {
    return {
      id,
      workspaceId: 'ws-1',
      title,
      updatedAt: 1000,
      status: 'idle',
      model: null,
      context: { used: 0, window: 128000, percent: 0, level: 'ok' },
      itemIds: [],
      run: {
        status: 'idle',
        startedAt: null,
        pendingText: null,
        canSend: true,
        canStop: false,
        lockedReason: null,
        error: null,
        lastActivityAt: null,
        stalledSince: null,
        activeTool: null,
      },
    };
  }

  it('renders conversation title and does not render error banner', async () => {
    const conv = makeConv('测试对话标题');

    await act(async () => {
      root!.render(<StatusBar conversation={conv} lang="zh" />);
    });

    const statusEl = host!.querySelector('[data-testid="next-status"]');
    expect(statusEl).not.toBeNull();
    expect(statusEl!.textContent).toContain('测试对话标题');
    expect(host!.querySelector('[data-testid="next-run-error"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-run-continue"]')).toBeNull();
  });

  it('renders new conversation placeholder when id is empty', async () => {
    const conv = makeConv('新对话', '');

    await act(async () => {
      root!.render(<StatusBar conversation={conv} lang="zh" />);
    });

    const titleEl = host!.querySelector('.top-title');
    expect(titleEl).not.toBeNull();
    expect(titleEl!.textContent).toBe('新对话');
  });
});
