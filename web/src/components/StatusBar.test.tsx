// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';
import type { components } from '../../../src/v2/contract.gen';

type ConversationView = components['schemas']['ConversationView'];

describe('StatusBar (T105-2)', () => {
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
    error: components['schemas']['RunState']['error'],
    status: ConversationView['status'] = 'failed',
  ): ConversationView {
    return {
      id: 'c-test',
      workspaceId: 'ws-1',
      title: '测试对话',
      updatedAt: 1000,
      status,
      model: null,
      context: { used: 0, window: 128000, percent: 0, level: 'ok' },
      itemIds: [],
      run: {
        status,
        startedAt: null,
        pendingText: null,
        canSend: true,
        canStop: false,
        lockedReason: null,
        error,
        lastActivityAt: null,
        stalledSince: null,
        activeTool: null,
      },
    };
  }

  it('renders message, puts code in title attribute, and does not show code in text', async () => {
    const conv = makeConv({
      code: 'interrupted',
      message: '服务中断，这一轮没有完成。',
      canContinue: true,
    });

    await act(async () => {
      root!.render(<StatusBar conversation={conv} lang="zh" />);
    });

    const errorEl = host!.querySelector('[data-testid="next-run-error"]');
    expect(errorEl).not.toBeNull();
    expect(errorEl!.getAttribute('title')).toBe('interrupted');
    expect(errorEl!.textContent).toContain('服务中断，这一轮没有完成。');
    expect(errorEl!.textContent).not.toContain('interrupted');
  });

  it('shows continue button when canContinue is true', async () => {
    const conv = makeConv({
      code: 'model_failed',
      message: '模型请求失败：503',
      canContinue: true,
    });

    await act(async () => {
      root!.render(<StatusBar conversation={conv} lang="zh" />);
    });

    const btn = host!.querySelector('[data-testid="next-run-continue"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('继续');
  });

  it('hides continue button when canContinue is false', async () => {
    const conv = makeConv({
      code: 'no_model',
      message: '未配置可用模型',
      canContinue: false,
    });

    await act(async () => {
      root!.render(<StatusBar conversation={conv} lang="zh" />);
    });

    const btn = host!.querySelector('[data-testid="next-run-continue"]');
    expect(btn).toBeNull();
  });

  it('calls onContinue when clicked, disables while waiting, and displays error if continue fails', async () => {
    let rejectPromise: ((err: Error) => void) | null = null;
    const onContinue = vi.fn().mockImplementation(() => new Promise((_, reject) => {
      rejectPromise = reject;
    }));

    const conv = makeConv({
      code: 'model_failed',
      message: '模型请求失败：503',
      canContinue: true,
    });

    await act(async () => {
      root!.render(<StatusBar conversation={conv} lang="zh" onContinue={onContinue} />);
    });

    const btn = host!.querySelector<HTMLButtonElement>('[data-testid="next-run-continue"]')!;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);

    // Click continue
    await act(async () => {
      btn.click();
    });

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);

    // Reject the continue call
    await act(async () => {
      rejectPromise!(new Error('网络请求超时'));
    });

    expect(btn.disabled).toBe(false);
    const errorEl = host!.querySelector('[data-testid="next-run-error"]')!;
    expect(errorEl.textContent).toContain('网络请求超时');
  });

  it('displays in English when lang is en', async () => {
    const conv = makeConv({
      code: 'interrupted',
      message: 'Service interrupted',
      canContinue: true,
    });

    await act(async () => {
      root!.render(<StatusBar conversation={conv} lang="en" />);
    });

    const btn = host!.querySelector('[data-testid="next-run-continue"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Continue');
  });
});
