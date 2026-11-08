/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore } from '../data/store';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const idleRun: Parameters<typeof Composer>[0]['run'] = {
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
};

async function renderComposer(lang: 'zh' | 'en' = 'zh') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  const store = createEntityStore();
  const sessionValue: SessionValue = {
    store,
    status: 'connected',
    conversationId: 'c1',
    lang,
    extraConversationIds: [],
    setExtraConversationIds: vi.fn(),
    retainTopic: vi.fn(),
    releaseTopic: vi.fn(),
    topics: [],
  };

  await act(async () => {
    root!.render(
      <SessionContext.Provider value={sessionValue}>
        <RightPaneProvider conversationId="c1" workspaceId={null} lang={lang} onToast={vi.fn()}>
          <Composer
            lang={lang}
            run={idleRun}
            conversationId="c1"
            onSend={vi.fn()}
            onStop={vi.fn()}
          />
        </RightPaneProvider>
      </SessionContext.Provider>,
    );
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

describe('Composer send button title', () => {
  const originalUserAgent = navigator.userAgent;

  afterEach(async () => {
    await cleanup();
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    });
  });

  it('shows Cmd in send button title on Mac (zh and en)', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });

    await renderComposer('zh');
    const sendBtnZh = host?.querySelector<HTMLButtonElement>('[data-testid="next-send"]');
    expect(sendBtnZh?.getAttribute('title')).toBe('发送指令 (Cmd+Enter)');

    await cleanup();

    await renderComposer('en');
    const sendBtnEn = host?.querySelector<HTMLButtonElement>('[data-testid="next-send"]');
    expect(sendBtnEn?.getAttribute('title')).toBe('Send (Cmd+Enter)');
  });

  it('shows Ctrl in send button title on non-Mac (Windows/Linux) (zh and en)', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });

    await renderComposer('zh');
    const sendBtnZh = host?.querySelector<HTMLButtonElement>('[data-testid="next-send"]');
    expect(sendBtnZh?.getAttribute('title')).toBe('发送指令 (Ctrl+Enter)');

    await cleanup();

    await renderComposer('en');
    const sendBtnEn = host?.querySelector<HTMLButtonElement>('[data-testid="next-send"]');
    expect(sendBtnEn?.getAttribute('title')).toBe('Send (Ctrl+Enter)');
  });

  it('places workspace chip in where-bar above composer-box, not inside composer-bar bottom row', async () => {
    await renderComposer('zh');
    const whereBar = host?.querySelector<HTMLDivElement>('[data-testid="next-composer-where"]');
    expect(whereBar).not.toBeNull();
    const wsChip = whereBar?.querySelector('[data-testid="next-ws-chip"]');
    expect(wsChip).not.toBeNull();

    const composerBox = host?.querySelector<HTMLDivElement>('[data-testid="next-composer"]');
    expect(composerBox).not.toBeNull();
    const insideWsChip = composerBox?.querySelector('.composer-bar [data-testid="next-ws-chip"]');
    expect(insideWsChip).toBeNull();
  });
});
