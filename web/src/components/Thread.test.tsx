// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Thread } from './Thread';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore, type ThreadItem } from '../data/store';
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
      items?: ThreadItem[];
      failed?: boolean;
      running?: boolean;
      error?: components['schemas']['RunState']['error'];
      onContinue?: (requestId?: string) => Promise<unknown>;
      lang?: 'zh' | 'en';
      actions?: ConversationActions;
      compaction?: components['schemas']['RunState']['compaction'];
      handoff?: Parameters<typeof Thread>[0]['handoff'];
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
            items={props.items ?? [{ kind: 'user', id: 'u-1', text: '你好', pathRefs: [] }]}
            toolsById={{}}
            lang={props.lang || 'zh'}
            running={props.running ?? false}
            failed={props.failed ?? true}
            error={props.error ?? null}
            actions={props.actions || makeActions()}
            stickNonce={0}
            onContinue={props.onContinue}
            compaction={props.compaction}
            handoff={props.handoff}
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
    const bubble = host!.querySelector('[data-testid="next-item-user"][data-command="compaction"]');
    expect(bubble).not.toBeNull();
    expect(bubble?.querySelector('[data-testid="next-user-chip"]')?.textContent).toBe('压缩');
    const pending = host!.querySelector('[data-testid="next-thread-compacting"]');
    expect(pending?.textContent).toBe('正在压缩上下文…');
    expect(pending?.classList.contains('thread-pending')).toBe(true);
    expect(pending?.querySelector('.run-spin')).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-compaction-error"]')).toBeNull();
  });

  it('shows user bubble and pending line while handoff runs', async () => {
    await act(async () => {
      root!.render(
        renderThread({
          failed: false,
          handoff: { state: 'running', instructions: '重点看迁移' },
        }),
      );
    });
    const bubble = host!.querySelector('[data-testid="next-item-user"][data-command="handoff"]');
    expect(bubble).not.toBeNull();
    expect(bubble?.querySelector('[data-testid="next-user-chip"]')?.textContent).toBe('交接');
    expect(bubble?.textContent).toContain('重点看迁移');

    const pending = host!.querySelector('[data-testid="next-thread-pending"]');
    expect(pending?.textContent).toBe('正在整理交接…');
    expect(pending?.classList.contains('thread-pending')).toBe(true);
    expect(pending?.querySelector('.run-spin')).not.toBeNull();
  });

  it('does not fold anything before a compaction divider', async () => {
    const items: ThreadItem[] = [
      { kind: 'user', id: 'u1', text: '之前的问题', pathRefs: [] },
      { kind: 'assistant', id: 'a1', text: '之前的回答', pathRefs: [], streaming: false, truncated: false },
      { kind: 'system_note', id: 'n1', noteKind: 'compaction', text: '之前 2 条已摘要', detail: '摘要全文' },
      { kind: 'user', id: 'u2', text: '之后的问题', pathRefs: [] },
    ];
    await act(async () => {
      root!.render(renderThread({ items, failed: false }));
    });
    expect(host!.querySelector('[data-testid="next-thread-earlier-toggle"]')).toBeNull();
    expect(host!.querySelectorAll('[data-testid="next-item-user"]').length).toBe(2);
    expect(host!.querySelector('[data-testid="next-item-assistant"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-compaction-divider"]')).not.toBeNull();
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

describe('Thread earlier context folding (T122-1)', () => {
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

  function renderThreadWithItems(items: ThreadItem[], lang: 'zh' | 'en' = 'zh') {
    const sessionValue: SessionValue = {
      store: createEntityStore(),
      status: 'connected',
      conversationId: 'c1',
      lang,
      extraConversationIds: [],
      setExtraConversationIds: vi.fn(),
      retainTopic: vi.fn(),
      releaseTopic: vi.fn(),
      topics: [],
    };

    return (
      <SessionContext.Provider value={sessionValue}>
        <RightPaneProvider conversationId="c1" workspaceId={null} lang={lang} onToast={vi.fn()}>
          <Thread
            items={items}
            toolsById={{}}
            lang={lang}
            running={false}
            failed={false}
            actions={{
              send: vi.fn(),
              stop: vi.fn(),
              continueRun: vi.fn(),
              loadToolOutput: vi.fn(),
              withdraw: vi.fn(),
            }}
            stickNonce={0}
          />
        </RightPaneProvider>
      </SessionContext.Provider>
    );
  }

  function asst(id: string, text: string): ThreadItem {
    return { kind: 'assistant', id, text, pathRefs: [], streaming: false, truncated: false };
  }

  it('folds earlier items before handoff by default, expands and collapses on click', async () => {
    const items: ThreadItem[] = [
      { kind: 'user', id: 'u1', text: '先跑迁移', pathRefs: [] },
      asst('a1', '好的'),
      {
        kind: 'system_note',
        id: 'n1',
        noteKind: 'handoff',
        text: '新上下文',
        detail: '交接说明内容',
      },
      asst('a2', '新上下文继续'),
    ];

    await act(async () => {
      root!.render(renderThreadWithItems(items, 'zh'));
    });

    const toggle = host!.querySelector<HTMLButtonElement>('[data-testid="next-thread-earlier-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toContain('之前的上下文 · 2 条');
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');

    // Before expansion: u1 and a1 are not rendered
    expect(host!.querySelector('[data-id="u1"]')).toBeNull();
    expect(host!.querySelector('[data-id="a1"]')).toBeNull();
    // n1 and a2 are rendered
    expect(host!.querySelector('[data-id="n1"]')).not.toBeNull();
    expect(host!.querySelector('[data-id="a2"]')).not.toBeNull();

    // Click to expand
    await act(async () => {
      toggle!.click();
    });

    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    expect(host!.querySelector('[data-id="u1"]')).not.toBeNull();
    expect(host!.querySelector('[data-id="a1"]')).not.toBeNull();
    expect(host!.querySelector('[data-id="n1"]')).not.toBeNull();
    expect(host!.querySelector('[data-id="a2"]')).not.toBeNull();

    // Click again to collapse
    await act(async () => {
      toggle!.click();
    });

    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    expect(host!.querySelector('[data-id="u1"]')).toBeNull();
    expect(host!.querySelector('[data-id="a1"]')).toBeNull();
  });

  it('renders a single toggle row for multiple handoffs with count matching all prior items', async () => {
    const items: ThreadItem[] = [
      { kind: 'user', id: 'u1', text: '步骤一', pathRefs: [] },
      asst('a1', '步骤一完成'),
      { kind: 'system_note', id: 'n1', noteKind: 'handoff', text: '新上下文 1' },
      { kind: 'user', id: 'u2', text: '步骤二', pathRefs: [] },
      asst('a2', '步骤二完成'),
      { kind: 'system_note', id: 'n2', noteKind: 'handoff', text: '新上下文 2' },
      asst('a3', '新上下文 2 继续'),
    ];

    await act(async () => {
      root!.render(renderThreadWithItems(items, 'zh'));
    });

    const toggles = host!.querySelectorAll('[data-testid="next-thread-earlier-toggle"]');
    expect(toggles.length).toBe(1);
    expect(toggles[0].textContent).toContain('之前的上下文 · 5 条');

    // When collapsed, only items after last handoff (n2, a3) are shown
    expect(host!.querySelector('[data-id="u1"]')).toBeNull();
    expect(host!.querySelector('[data-id="n1"]')).toBeNull();
    expect(host!.querySelector('[data-id="u2"]')).toBeNull();
    expect(host!.querySelector('[data-id="n2"]')).not.toBeNull();
    expect(host!.querySelector('[data-id="a3"]')).not.toBeNull();
  });

  it('shows English text for earlier context count when lang is en', async () => {
    const items: ThreadItem[] = [
      { kind: 'user', id: 'u1', text: 'Step 1', pathRefs: [] },
      { kind: 'system_note', id: 'n1', noteKind: 'handoff', text: 'New context' },
      asst('a1', 'Continuing'),
    ];

    await act(async () => {
      root!.render(renderThreadWithItems(items, 'en'));
    });

    const toggle = host!.querySelector('[data-testid="next-thread-earlier-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toContain('Previous context · 1 items');
  });
});
