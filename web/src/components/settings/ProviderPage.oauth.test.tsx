/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderPage } from './ProviderPage';
import type { Available, LoginSession, Provider } from '../../data/providerTypes';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mockUseProviders = vi.fn();
const mockGetAvailableProviders = vi.fn();
const mockConnectProviderOAuth = vi.fn();
const mockGetLoginSession = vi.fn();
const mockCancelLoginSession = vi.fn();

vi.mock('../../data/useProviders', () => ({
  useProviders: () => mockUseProviders(),
}));

vi.mock('../../data/api', () => ({
  addCustomProvider: vi.fn(),
  answerLoginSession: vi.fn(),
  cancelLoginSession: (...args: unknown[]) => mockCancelLoginSession(...args),
  connectProvider: vi.fn(),
  connectProviderOAuth: (...args: unknown[]) => mockConnectProviderOAuth(...args),
  deleteProvider: vi.fn(),
  getAvailableProviders: (...args: unknown[]) => mockGetAvailableProviders(...args),
  getLoginSession: (...args: unknown[]) => mockGetLoginSession(...args),
  patchProvider: vi.fn(),
  putModelContextWindow: vi.fn(),
  testProvider: vi.fn(),
}));

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
    await act(async () => { root!.unmount(); });
    root = null;
  }
  if (host?.parentNode) host.parentNode.removeChild(host);
  host = null;
}

function createFakeWindow() {
  const doc = {
    title: '',
    body: { innerHTML: '' },
  };
  return {
    closed: false,
    opener: 'original' as unknown,
    document: doc,
    location: { href: '' },
    close: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
  };
}

const grokMissing: Available = {
  id: 'xai',
  name: 'Grok',
  authMethods: ['oauth'],
  modelCount: 4,
  popular: false,
  envDetected: false,
  connected: false,
  localLogin: { detected: false },
};

const existingGrok: Provider = {
  id: 'xai',
  kind: 'builtin',
  brand: 'xai',
  name: 'Grok',
  auth: { type: 'oauth', account: 'tester@x.com' },
  status: { state: 'ok' },
  models: [],
};

describe('ProviderPage OAuth tab management', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockUseProviders.mockReturnValue({
      providers: [],
      defaultModel: null,
    });
    mockGetAvailableProviders.mockResolvedValue({
      providers: [grokMissing],
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('synchronously opens window.open on click and sets placeholder & opener null', async () => {
    const fakeTab = createFakeWindow();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);

    let resolveOAuth: ((val: { session: LoginSession }) => void) | undefined;
    mockConnectProviderOAuth.mockReturnValue(
      new Promise<{ session: LoginSession }>((res) => { resolveOAuth = res; }),
    );

    await render(<ProviderPage lang="zh" />);

    // Open Add dialog
    const addBtn = host!.querySelector('[data-testid="next-provider-add"]') as HTMLButtonElement;
    await act(async () => { addBtn.click(); });

    // Click "登录 Grok"
    const loginBtn = host!.querySelector('[data-testid="next-grok-login"]') as HTMLButtonElement;
    expect(loginBtn).toBeTruthy();

    await act(async () => {
      loginBtn.click();
    });

    // Synchronously called before connectProviderOAuth resolved!
    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    expect(fakeTab.document.title).toBe('正在跳转到授权页面…');
    expect(fakeTab.document.body.innerHTML).toContain('正在跳转到授权页面…');
    expect(fakeTab.opener).toBeNull();
    expect(fakeTab.location.href).toBe('');

    // Clean up pending promise
    await act(async () => {
      resolveOAuth?.({
        session: {
          id: 'sess-1',
          providerId: 'xai',
          state: 'pending',
          events: [],
        },
      });
    });
  });

  it('redirects location to verificationUri when device_code arrives and does not close tab', async () => {
    const fakeTab = createFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);

    const verificationUri = 'https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K';
    mockConnectProviderOAuth.mockResolvedValue({
      session: {
        id: 'sess-1',
        providerId: 'xai',
        state: 'pending',
        events: [
          {
            type: 'device_code',
            userCode: 'WFT-7Q2K',
            verificationUri,
          },
        ],
      },
    });

    await render(<ProviderPage lang="zh" />);
    const addBtn = host!.querySelector('[data-testid="next-provider-add"]') as HTMLButtonElement;
    await act(async () => { addBtn.click(); });

    const loginBtn = host!.querySelector('[data-testid="next-grok-login"]') as HTMLButtonElement;
    await act(async () => { loginBtn.click(); });

    expect(fakeTab.location.href).toBe(verificationUri);
    expect(fakeTab.close).not.toHaveBeenCalled();
  });

  it('redirects location on polling when initial connect had no device_code', async () => {
    const fakeTab = createFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);

    const verificationUri = 'https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K';
    mockConnectProviderOAuth.mockResolvedValue({
      session: {
        id: 'sess-1',
        providerId: 'xai',
        state: 'pending',
        events: [{ type: 'progress', message: '等待授权…' }],
      },
    });

    mockGetLoginSession.mockResolvedValue({
      session: {
        id: 'sess-1',
        providerId: 'xai',
        state: 'pending',
        events: [
          {
            type: 'device_code',
            userCode: 'WFT-7Q2K',
            verificationUri,
          },
        ],
      },
    });

    await render(<ProviderPage lang="zh" />);
    const addBtn = host!.querySelector('[data-testid="next-provider-add"]') as HTMLButtonElement;
    await act(async () => { addBtn.click(); });

    const loginBtn = host!.querySelector('[data-testid="next-grok-login"]') as HTMLButtonElement;
    await act(async () => { loginBtn.click(); });

    expect(fakeTab.location.href).toBe('');

    // Advance 1s for poll
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(fakeTab.location.href).toBe(verificationUri);
    expect(fakeTab.close).not.toHaveBeenCalled();
  });

  it('closes unredirected tab when user cancels in Weft', async () => {
    const fakeTab = createFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);

    mockConnectProviderOAuth.mockResolvedValue({
      session: {
        id: 'sess-1',
        providerId: 'xai',
        state: 'pending',
        events: [{ type: 'progress', message: '等待授权…' }],
      },
    });
    mockCancelLoginSession.mockResolvedValue({});

    await render(<ProviderPage lang="zh" />);
    const addBtn = host!.querySelector('[data-testid="next-provider-add"]') as HTMLButtonElement;
    await act(async () => { addBtn.click(); });

    const loginBtn = host!.querySelector('[data-testid="next-grok-login"]') as HTMLButtonElement;
    await act(async () => { loginBtn.click(); });

    expect(fakeTab.close).not.toHaveBeenCalled();

    // Cancel in Weft LoginSessionView
    const cancelBtn = host!.querySelector('.mp-oauth button.mp-btn') as HTMLButtonElement;
    expect(cancelBtn?.textContent).toContain('取消');

    await act(async () => {
      cancelBtn.click();
    });

    expect(fakeTab.close).toHaveBeenCalled();
  });

  it('closes unredirected tab when connectProviderOAuth throws error', async () => {
    const fakeTab = createFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);

    mockConnectProviderOAuth.mockRejectedValue(new Error('Network error'));

    await render(<ProviderPage lang="zh" />);
    const addBtn = host!.querySelector('[data-testid="next-provider-add"]') as HTMLButtonElement;
    await act(async () => { addBtn.click(); });

    const loginBtn = host!.querySelector('[data-testid="next-grok-login"]') as HTMLButtonElement;
    await act(async () => {
      loginBtn.click();
    });

    expect(fakeTab.close).toHaveBeenCalled();
  });

  it('shows next-oauth-verify-link even when window.open returns null', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);

    const verificationUri = 'https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K';
    mockConnectProviderOAuth.mockResolvedValue({
      session: {
        id: 'sess-1',
        providerId: 'xai',
        state: 'pending',
        events: [
          {
            type: 'device_code',
            userCode: 'WFT-7Q2K',
            verificationUri,
          },
        ],
      },
    });

    await render(<ProviderPage lang="zh" />);
    const addBtn = host!.querySelector('[data-testid="next-provider-add"]') as HTMLButtonElement;
    await act(async () => { addBtn.click(); });

    const loginBtn = host!.querySelector('[data-testid="next-grok-login"]') as HTMLButtonElement;
    await act(async () => { loginBtn.click(); });

    const link = host!.querySelector('[data-testid="next-oauth-verify-link"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.href).toBe(verificationUri);
    expect(link.textContent).toBe(verificationUri);
  });

  it('opens tab on relogin of existing provider', async () => {
    mockUseProviders.mockReturnValue({
      providers: [existingGrok],
      defaultModel: null,
    });
    mockGetAvailableProviders.mockResolvedValue({
      providers: [grokMissing],
    });

    const fakeTab = createFakeWindow();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);

    mockConnectProviderOAuth.mockResolvedValue({
      session: {
        id: 'sess-relogin',
        providerId: 'xai',
        state: 'pending',
        events: [
          {
            type: 'device_code',
            userCode: 'WFT-7Q2K',
            verificationUri: 'https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K',
          },
        ],
      },
    });

    await render(<ProviderPage lang="zh" />);

    // Click "..." menu on existing provider
    const moreBtn = host!.querySelector('[data-testid="next-provider-more"]') as HTMLButtonElement;
    expect(moreBtn).toBeTruthy();
    await act(async () => { moreBtn.click(); });

    // Click "重新登录"
    const reloginBtn = host!.querySelector('[data-testid="next-provider-relogin"]') as HTMLElement;
    expect(reloginBtn).toBeTruthy();
    await act(async () => { reloginBtn.click(); });

    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    expect(fakeTab.location.href).toBe('https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K');
  });
});
