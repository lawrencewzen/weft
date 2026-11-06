// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from './AssistantMessage';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore } from '../data/store';
import type { components } from '../../../src/v2/contract.gen';

type Item = components['schemas']['ThreadItemAssistant'];

describe('AssistantMessage truncated prompt (T105-2)', () => {
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

  function makeItem(truncated: boolean, streaming = false): Item {
    return {
      kind: 'assistant',
      id: 'a-1',
      text: '部分回复内容...',
      pathRefs: [],
      model: 'deepseek-flash',
      streaming,
      truncated,
    };
  }

  function renderMessage(item: Item, lang: 'zh' | 'en' = 'zh', running = false) {
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

    return act(async () => {
      root!.render(
        <SessionContext.Provider value={sessionValue}>
          <RightPaneProvider conversationId="c1" workspaceId={null} lang={lang} onToast={vi.fn()}>
            <AssistantMessage item={item} lang={lang} running={running} />
          </RightPaneProvider>
        </SessionContext.Provider>
      );
    });
  }

  it('renders single line gray prompt without buttons when truncated and not running', async () => {
    await renderMessage(makeItem(true), 'zh', false);

    const truncatedEl = host!.querySelector('[data-testid="next-truncated"]');
    expect(truncatedEl).not.toBeNull();
    expect(truncatedEl!.textContent).toBe('回复被截断');
    expect(truncatedEl!.querySelectorAll('button')).toHaveLength(0);
    expect(host!.querySelector('[data-testid="next-continue"]')).toBeNull();
  });

  it('renders in English when lang is en', async () => {
    await renderMessage(makeItem(true), 'en', false);

    const truncatedEl = host!.querySelector('[data-testid="next-truncated"]');
    expect(truncatedEl).not.toBeNull();
    expect(truncatedEl!.textContent).toBe('Response was truncated');
  });

  it('does not display truncated prompt while running', async () => {
    await renderMessage(makeItem(true), 'zh', true);

    expect(host!.querySelector('[data-testid="next-truncated"]')).toBeNull();
  });

  it('does not display truncated prompt when not truncated', async () => {
    await renderMessage(makeItem(false), 'zh', false);

    expect(host!.querySelector('[data-testid="next-truncated"]')).toBeNull();
  });
});
