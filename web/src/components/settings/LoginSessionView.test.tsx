/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginSessionView } from './LoginSessionView';
import type { LoginSession } from '../../data/providerTypes';

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
    await act(async () => { root!.unmount(); });
    root = null;
  }
  if (host?.parentNode) host.parentNode.removeChild(host);
  host = null;
}

describe('LoginSessionView', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('renders next-oauth-verify-link with href equal to verificationUri when device_code exists', async () => {
    const session: LoginSession = {
      id: 'sess-1',
      providerId: 'xai',
      state: 'pending',
      events: [
        {
          type: 'device_code',
          userCode: 'WFT-7Q2K',
          verificationUri: 'https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K',
        },
      ],
    };

    await render(
      <LoginSessionView
        session={session}
        lang="zh"
        onAnswer={vi.fn(async () => {})}
        onCancel={vi.fn(async () => {})}
      />,
    );

    const code = host!.querySelector('.mp-oauth-code');
    expect(code?.textContent).toBe('WFT-7Q2K');

    const link = host!.querySelector('[data-testid="next-oauth-verify-link"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.href).toBe('https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K');
    expect(link.textContent).toBe('https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');

    expect(host!.textContent).toContain('授权页面已在新标签页打开；没看到的话点这里');
  });

  it('renders English tip text when lang is en', async () => {
    const session: LoginSession = {
      id: 'sess-1',
      providerId: 'xai',
      state: 'pending',
      events: [
        {
          type: 'device_code',
          userCode: 'WFT-7Q2K',
          verificationUri: 'https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K',
        },
      ],
    };

    await render(
      <LoginSessionView
        session={session}
        lang="en"
        onAnswer={vi.fn(async () => {})}
        onCancel={vi.fn(async () => {})}
      />,
    );

    expect(host!.textContent).toContain("The sign-in page opened in a new tab. Didn't see it? Open it here");
  });

  it('renders next-oauth-open button when auth_url exists without device_code', async () => {
    const session: LoginSession = {
      id: 'sess-2',
      providerId: 'anthropic',
      state: 'pending',
      events: [
        {
          type: 'auth_url',
          url: 'https://auth.anthropic.com/authorize',
        },
      ],
    };

    await render(
      <LoginSessionView
        session={session}
        lang="zh"
        onAnswer={vi.fn(async () => {})}
        onCancel={vi.fn(async () => {})}
      />,
    );

    const btn = host!.querySelector('[data-testid="next-oauth-open"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(host!.querySelector('[data-testid="next-oauth-verify-link"]')).toBeNull();
  });
});
