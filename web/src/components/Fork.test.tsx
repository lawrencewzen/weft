// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from './AssistantMessage';
import { UserMessage } from './UserMessage';
import { Composer } from './Composer';
import { Thread } from './Thread';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore } from '../data/store';
import { setConversationPrefill, clearConversationPrefills } from '../data/composerPrefill';
import * as nav from '../data/nav';
import * as api from '../data/api';
import { CenterPane } from './CenterPane';
import { conversationTopic } from '../data/store';
import { t } from '../i18n';
import type { components } from '../../../src/v2/contract.gen';

type ThreadItemUser = components['schemas']['ThreadItemUser'];
type ThreadItemAssistant = components['schemas']['ThreadItemAssistant'];

describe('Fork button appearance conditions and prefill (T123-1)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    clearConversationPrefills();
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
    clearConversationPrefills();
  });

  function renderWithProviders(
    element: React.ReactElement,
    lang: 'zh' | 'en' = 'zh',
    customStore?: ReturnType<typeof createEntityStore>,
  ) {
    const sessionValue: SessionValue = {
      store: customStore || createEntityStore(),
      status: 'connected',
      conversationId: 'c1',
      lang,
      extraConversationIds: [],
      setExtraConversationIds: vi.fn(),
      retainTopic: vi.fn(),
      releaseTopic: vi.fn(),
      topics: [],
    };

    return act(async () => {
      root!.render(
        <SessionContext.Provider value={sessionValue}>
          <RightPaneProvider conversationId="c1" workspaceId={null} lang={lang} onToast={vi.fn()}>
            {element}
          </RightPaneProvider>
        </SessionContext.Provider>
      );
    });
  }

  describe('UserMessage fork button', () => {
    it('shows fork button when entryId is present', async () => {
      const onFork = vi.fn();
      const item: ThreadItemUser = {
        kind: 'user',
        id: 'u-1',
        entryId: 'entry-u-1',
        text: '用户提问内容',
        pathRefs: [],
      };

      await renderWithProviders(<UserMessage item={item} lang="zh" onFork={onFork} />);

      const forkBtn = host!.querySelector('[data-testid="next-msg-fork"]');
      expect(forkBtn).not.toBeNull();
      expect(forkBtn!.getAttribute('title')).toBe('从这里分叉');

      act(() => {
        (forkBtn as HTMLButtonElement).click();
      });
      expect(onFork).toHaveBeenCalledWith('entry-u-1');
    });

    it('shows fork button in English when lang is en', async () => {
      const item: ThreadItemUser = {
        kind: 'user',
        id: 'u-1',
        entryId: 'entry-u-1',
        text: 'User question',
        pathRefs: [],
      };

      await renderWithProviders(<UserMessage item={item} lang="en" onFork={vi.fn()} />, 'en');

      const forkBtn = host!.querySelector('[data-testid="next-msg-fork"]');
      expect(forkBtn).not.toBeNull();
      expect(forkBtn!.getAttribute('title')).toBe('Fork from here');
    });

    it('does not show fork button when entryId is null', async () => {
      const item: ThreadItemUser = {
        kind: 'user',
        id: 'u-1',
        entryId: null,
        text: '未完成或无法分叉的用户消息',
        pathRefs: [],
      };

      await renderWithProviders(<UserMessage item={item} lang="zh" onFork={vi.fn()} />);

      const forkBtn = host!.querySelector('[data-testid="next-msg-fork"]');
      expect(forkBtn).toBeNull();
    });
  });

  describe('AssistantMessage fork button', () => {
    it('shows fork button when entryId is present and streaming is false', async () => {
      const onFork = vi.fn();
      const item: ThreadItemAssistant = {
        kind: 'assistant',
        id: 'a-1',
        entryId: 'entry-a-1',
        text: '助手回答内容',
        pathRefs: [],
        streaming: false,
        truncated: false,
      };

      await renderWithProviders(<AssistantMessage item={item} lang="zh" onFork={onFork} />);

      const forkBtn = host!.querySelector('[data-testid="next-msg-fork"]');
      expect(forkBtn).not.toBeNull();
      expect(forkBtn!.getAttribute('title')).toBe('从这里分叉');

      act(() => {
        (forkBtn as HTMLButtonElement).click();
      });
      expect(onFork).toHaveBeenCalledWith('entry-a-1');
    });

    it('does not show fork button while streaming', async () => {
      const item: ThreadItemAssistant = {
        kind: 'assistant',
        id: 'a-1',
        entryId: 'entry-a-1',
        text: '正在流式输出...',
        pathRefs: [],
        streaming: true,
        truncated: false,
      };

      await renderWithProviders(<AssistantMessage item={item} lang="zh" onFork={vi.fn()} />);

      const forkBtn = host!.querySelector('[data-testid="next-msg-fork"]');
      expect(forkBtn).toBeNull();
    });

    it('does not show fork button when entryId is null', async () => {
      const item: ThreadItemAssistant = {
        kind: 'assistant',
        id: 'a-1',
        entryId: null,
        text: '已完成但无法分叉的消息',
        pathRefs: [],
        streaming: false,
        truncated: false,
      };

      await renderWithProviders(<AssistantMessage item={item} lang="zh" onFork={vi.fn()} />);

      const forkBtn = host!.querySelector('[data-testid="next-msg-fork"]');
      expect(forkBtn).toBeNull();
    });
  });

  describe('Composer prefill', () => {
    const idleRun = {
      status: 'idle' as const,
      startedAt: null,
      pendingText: null,
      canSend: true,
      canStop: false,
      lockedReason: null,
      error: null,
      lastActivityAt: null,
      stalledSince: null,
      activeTool: null,
    };

    it('populates draft when prefill is stored for conversation', async () => {
      setConversationPrefill('conv-fork-1', '重构会话列表的代码');

      await renderWithProviders(
        <Composer
          lang="zh"
          run={idleRun}
          conversationId="conv-fork-1"
          onSend={vi.fn()}
          onStop={vi.fn()}
        />
      );

      const textarea = host!.querySelector('textarea');
      expect(textarea).not.toBeNull();
      expect(textarea!.value).toBe('重构会话列表的代码');
    });

    it('formats fork_failed i18n message with reason', () => {
      expect(t('zh', 'fork_failed', { reason: '对话历史已损坏' })).toBe('分叉失败：对话历史已损坏');
      expect(t('en', 'fork_failed', { reason: 'Conversation history corrupted' })).toBe('Fork failed: Conversation history corrupted');
    });

    it('defaults to empty draft when no prefill is provided', async () => {
      await renderWithProviders(
        <Composer
          lang="zh"
          run={idleRun}
          conversationId="conv-normal"
          onSend={vi.fn()}
          onStop={vi.fn()}
        />
      );

      const textarea = host!.querySelector('textarea');
      expect(textarea).not.toBeNull();
      expect(textarea!.value).toBe('');
    });
  });

  describe('Thread forkedFrom banner', () => {
    const mockActions = {
      send: vi.fn(),
      stop: vi.fn(),
      continueRun: vi.fn(),
      loadToolOutput: vi.fn(),
      withdraw: vi.fn(),
    };

    it('renders forkedFrom banner at top of thread and navigates when clicked', async () => {
      const navigateSpy = vi.spyOn(nav, 'navigate').mockImplementation(() => {});

      const forkedFrom = {
        conversationId: 'c-orig-123',
        title: '原始对话标题',
      };

      await renderWithProviders(
        <Thread
          items={[]}
          toolsById={{}}
          lang="zh"
          running={false}
          actions={mockActions}
          stickNonce={0}
          forkedFrom={forkedFrom}
        />
      );

      const banner = host!.querySelector('[data-testid="next-forked-from"]');
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain('分叉自');
      expect(banner!.textContent).toContain('与原对话共用工作区文件');

      const link = host!.querySelector('[data-testid="next-forked-link"]') as HTMLButtonElement;
      expect(link).not.toBeNull();
      expect(link.textContent).toBe('原始对话标题');

      act(() => {
        link.click();
      });

      expect(navigateSpy).toHaveBeenCalledWith('/c/c-orig-123');
      navigateSpy.mockRestore();
    });

    it('does not render banner when forkedFrom is not provided', async () => {
      await renderWithProviders(
        <Thread
          items={[]}
          toolsById={{}}
          lang="zh"
          running={false}
          actions={mockActions}
          stickNonce={0}
          forkedFrom={null}
        />
      );

      const banner = host!.querySelector('[data-testid="next-forked-from"]');
      expect(banner).toBeNull();
    });
  });

  describe('CenterPane fork failure handling', () => {
    it('notifies onToast when fork fails', async () => {
      const store = createEntityStore();
      store.applySnapshot({
        protocolVersion: '1',
        topics: [conversationTopic('c1')],
        entities: [
          {
            topic: conversationTopic('c1'),
            entity: 'conversation',
            id: 'c1',
            value: {
              id: 'c1',
              title: '测试对话',
              updatedAt: Date.now(),
              status: 'idle',
              model: null,
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
              context: { used: 0, window: 128000, percent: 0, level: 'ok' },
              itemIds: ['u1'],
              sends: [],
            },
          },
          {
            topic: conversationTopic('c1'),
            entity: 'item',
            id: 'u1',
            value: {
              kind: 'user',
              id: 'u1',
              entryId: 'entry-u1',
              text: '用户消息',
              pathRefs: [],
            },
          },
        ],
      });

      const onToast = vi.fn();
      const forkSpy = vi.spyOn(api, 'forkConversation').mockRejectedValueOnce(new Error('对话历史已损坏'));

      await renderWithProviders(
        <CenterPane
          cid="c1"
          lang="zh"
          onToast={onToast}
        />,
        'zh',
        store,
      );

      const forkBtn = host!.querySelector('[data-testid="next-msg-fork"]') as HTMLButtonElement;
      expect(forkBtn).not.toBeNull();

      await act(async () => {
        forkBtn.click();
      });

      expect(forkSpy).toHaveBeenCalledWith('c1', 'entry-u1');
      expect(onToast).toHaveBeenCalledWith('分叉失败：对话历史已损坏');

      forkSpy.mockRestore();
    });
  });
});
