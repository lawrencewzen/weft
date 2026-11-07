// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Thread } from './Thread';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore } from '../data/store';
import type { ConversationActions } from '../data/useConversation';
import type { components } from '../../../src/v2/contract.gen';

describe('Thread failure and continue (T105-2)', () => {
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

  function makeActions(overrides: Partial<ConversationActions> = {}): ConversationActions {
    return {
      send: vi.fn(),
      stop: vi.fn(),
      continueRun: vi.fn(),
      loadToolOutput: vi.fn(),
      withdraw: vi.fn(),
      ...overrides,
    };
  }

  function renderThread(
    props: {
      failed?: boolean;
      running?: boolean;
      error?: components['schemas']['RunState']['error'];
      onContinue?: (requestId?: string) => Promise<unknown>;
      lang?: 'zh' | 'en';
      actions?: ConversationActions;
      compaction?: components['schemas']['RunState']['compaction'];
    } = {},
  ) {
    const sessionValue: SessionValue = {
      store: createEntityStore(),
      status: 'connected',
      conversationId: 'c1',
      lang: props.lang || 'zh',
      extraConversationIds: [],
      setExtraConversationIds: vi.fn(),
      retainTopic: vi.fn(),
      releaseTopic: vi.fn(),
      topics: [],
    };

    return (
      <SessionContext.Provider value={sessionValue}>
        <RightPaneProvider conversationId="c1" workspaceId={null} lang={props.lang || 'zh'} onToast={vi.fn()}>
          <Thread
            items={[{ kind: 'user', id: 'u-1', text: '你好', pathRefs: [] }]}
            toolsById={{}}
            lang={props.lang || 'zh'}
            running={props.running ?? false}
            failed={props.failed ?? true}
            error={props.error ?? null}
            actions={props.actions || makeActions()}
            stickNonce={0}
            onContinue={props.onContinue}
            compaction={props.compaction}
          />
        </RightPaneProvider>
      </SessionContext.Provider>
    );
  }

  it('renders error message at end of thread, puts code in title attribute, does not show code in text', async () => {
    await act(async () => {
      root!.render(
        renderThread({
          failed: true,
          error: {
            code: 'interrupted',
            message: '服务中断，这一轮没有完成。',
            canContinue: true,
          },
        }),
      );
    });

    const errorEl = host!.querySelector('[data-testid="next-run-error"]');
    expect(errorEl).not.toBeNull();
    expect(errorEl!.getAttribute('title')).toBe('interrupted');
    expect(errorEl!.textContent).toContain('服务中断，这一轮没有完成。');
    expect(errorEl!.textContent).not.toContain('interrupted');
  });

  it('shows continue button when canContinue is true', async () => {
    await act(async () => {
      root!.render(
        renderThread({
          failed: true,
          error: {
            code: 'model_failed',
            message: '模型请求失败：503',
            canContinue: true,
          },
        }),
      );
    });

    const btn = host!.querySelector('[data-testid="next-run-continue"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('继续');
  });

  it('hides continue button when canContinue is false', async () => {
    await act(async () => {
      root!.render(
        renderThread({
          failed: true,
          error: {
            code: 'no_model',
            message: '未配置可用模型',
            canContinue: false,
          },
        }),
      );
    });

    const btn = host!.querySelector('[data-testid="next-run-continue"]');
    expect(btn).toBeNull();
  });

  it('calls onContinue/actions.continueRun, disables during wait, and shows error if continue fails', async () => {
    let rejectPromise: ((err: Error) => void) | null = null;
    const onContinue = vi.fn().mockImplementation(() => new Promise((_, reject) => {
      rejectPromise = reject;
    }));

    await act(async () => {
      root!.render(
        renderThread({
          failed: true,
          error: {
            code: 'model_failed',
            message: '模型请求失败：503',
            canContinue: true,
          },
          onContinue,
        }),
      );
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

    // Reject continue
    await act(async () => {
      rejectPromise!(new Error('网络请求超时'));
    });

    expect(btn.disabled).toBe(false);
    const errorEl = host!.querySelector('[data-testid="next-run-error"]')!;
    expect(errorEl.textContent).toContain('网络请求超时');
  });

  it('displays continue button in English when lang is en', async () => {
    await act(async () => {
      root!.render(
        renderThread({
          failed: true,
          lang: 'en',
          error: {
            code: 'interrupted',
            message: 'Service interrupted',
            canContinue: true,
          },
        }),
      );
    });

    const btn = host!.querySelector('[data-testid="next-run-continue"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Continue');
  });

  it('does not render error banner when running is true', async () => {
    await act(async () => {
      root!.render(
        renderThread({
          failed: true,
          running: true,
          error: {
            code: 'model_failed',
            message: '模型请求失败',
            canContinue: true,
          },
        }),
      );
    });

    expect(host!.querySelector('[data-testid="next-run-error"]')).toBeNull();
  });

  it('shows the compacting line while a compaction runs, and no error', async () => {
    await act(async () => {
      root!.render(renderThread({ failed: false, compaction: { state: 'running', trigger: 'manual' } }));
    });
    expect(host!.querySelector('[data-testid="next-thread-compacting"]')?.textContent).toBe('正在压缩上下文');
    expect(host!.querySelector('[data-testid="next-compaction-error"]')).toBeNull();
  });

  it('shows the compaction error last, with no continue button', async () => {
    await act(async () => {
      root!.render(renderThread({
        failed: false,
        compaction: { state: 'failed', trigger: 'threshold', error: '压缩失败：超时' },
      }));
    });
    const el = host!.querySelector('[data-testid="next-compaction-error"]')!;
    expect(el.textContent).toBe('压缩失败：超时');
    expect(el.className).toContain('llm-error');
    expect(el.querySelector('button')).toBeNull();
    expect(el.parentElement!.lastElementChild).toBe(el);
  });

  it('shows a blocking compaction failure once when the run error has the same sentence', async () => {
    await act(async () => {
      root!.render(renderThread({
        failed: true,
        error: { code: 'model_error', message: '压缩失败：超时', canContinue: false },
        compaction: { state: 'failed', error: '压缩失败：超时' },
      }));
    });
    expect(host!.querySelector('[data-testid="next-run-error"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-compaction-error"]')).toBeNull();
  });
});
