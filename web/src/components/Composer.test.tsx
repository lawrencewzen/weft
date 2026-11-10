/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { conversationTopic, createEntityStore } from '../data/store';

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

async function renderComposer(
  lang: 'zh' | 'en' = 'zh',
  run: Parameters<typeof Composer>[0]['run'] = idleRun,
  store: ReturnType<typeof createEntityStore> = createEntityStore(),
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

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
            run={run}
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

  describe('stack DOM ordering and adjacency', () => {
    it('renders where-bar before stall-strip, and stall-strip adjacent to composer-box', async () => {
      const stalledRun: Parameters<typeof Composer>[0]['run'] = {
        status: 'running',
        startedAt: Date.now() - 600_000,
        pendingText: null,
        canSend: true,
        canStop: true,
        lockedReason: null,
        error: null,
        lastActivityAt: Date.now() - 300_000,
        stalledSince: Date.now() - 300_000,
        activeTool: { name: 'bash', startedAt: Date.now() - 360_000, summary: 'npm test' },
      };
      await renderComposer('zh', stalledRun);

      const whereBar = host?.querySelector<HTMLDivElement>('[data-testid="next-composer-where"]');
      const stallStrip = host?.querySelector<HTMLDivElement>('[data-testid="next-stall-strip"]');
      const composerBox = host?.querySelector<HTMLDivElement>('[data-testid="next-composer"]');

      expect(whereBar).not.toBeNull();
      expect(stallStrip).not.toBeNull();
      expect(composerBox).not.toBeNull();

      expect(whereBar?.nextElementSibling).toBe(stallStrip);
      expect(stallStrip?.nextElementSibling).toBe(composerBox);
    });

    it('renders where-bar before stall-strip, stall-strip adjacent to agents-strip, and agents-strip adjacent to composer-box', async () => {
      const stalledRun: Parameters<typeof Composer>[0]['run'] = {
        status: 'running',
        startedAt: Date.now() - 600_000,
        pendingText: null,
        canSend: true,
        canStop: true,
        lockedReason: null,
        error: null,
        lastActivityAt: Date.now() - 300_000,
        stalledSince: Date.now() - 300_000,
        activeTool: { name: 'bash', startedAt: Date.now() - 360_000, summary: 'npm test' },
      };
      const store = createEntityStore();
      const convTop = conversationTopic('c1');
      store.applySnapshot({
        protocolVersion: '2.0.0',
        topics: [convTop],
        entities: [{
          topic: convTop,
          entity: 'subagent',
          id: 'sa-1',
          value: {
            id: 'c1:sub:sa-1',
            parentConversationId: 'c1',
            title: 'Subagent 1',
            name: 'sa-1',
            mode: 'background',
            status: 'running',
            startedAt: Date.now() - 60_000,
            lastActivityAt: Date.now() - 10_000,
            endedAt: null,
            currentAction: 'Running task',
            progress: null,
            toolCallId: null,
          },
        }],
      });
      await renderComposer('zh', stalledRun, store);

      const whereBar = host?.querySelector<HTMLDivElement>('[data-testid="next-composer-where"]');
      const stallStrip = host?.querySelector<HTMLDivElement>('[data-testid="next-stall-strip"]');
      const agentsStrip = host?.querySelector<HTMLDivElement>('[data-testid="next-agents-strip"]');
      const composerBox = host?.querySelector<HTMLDivElement>('[data-testid="next-composer"]');

      expect(whereBar).not.toBeNull();
      expect(stallStrip).not.toBeNull();
      expect(agentsStrip).not.toBeNull();
      expect(composerBox).not.toBeNull();

      expect(whereBar?.nextElementSibling).toBe(stallStrip);
      expect(stallStrip?.nextElementSibling).toBe(agentsStrip);
      expect(agentsStrip?.nextElementSibling).toBe(composerBox);
    });

    it('renders where-bar directly above composer-box when no strips are active', async () => {
      await renderComposer('zh', idleRun);

      const whereBar = host?.querySelector<HTMLDivElement>('[data-testid="next-composer-where"]');
      const composerBox = host?.querySelector<HTMLDivElement>('[data-testid="next-composer"]');

      expect(whereBar).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(whereBar?.nextElementSibling).toBe(composerBox);
    });
  });
});
