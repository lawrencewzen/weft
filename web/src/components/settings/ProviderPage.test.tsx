/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderPage } from './ProviderPage';
import type { Provider } from '../../data/providerTypes';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mockUseProviders = vi.fn();
const mockPatchProvider = vi.fn();

vi.mock('../../data/useProviders', () => ({
  useProviders: () => mockUseProviders(),
}));

vi.mock('../../data/api', () => ({
  addCustomProvider: vi.fn(),
  answerLoginSession: vi.fn(),
  cancelLoginSession: vi.fn(),
  connectProvider: vi.fn(),
  connectProviderOAuth: vi.fn(),
  deleteProvider: vi.fn(),
  getAvailableProviders: vi.fn().mockResolvedValue({ providers: [] }),
  getLoginSession: vi.fn(),
  patchProvider: (...args: unknown[]) => mockPatchProvider(...args),
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
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  if (host?.parentNode) host.parentNode.removeChild(host);
  host = null;
}

describe('ProviderPage default model picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('disables default model picker when no enabled models and clicking does not expand menu', async () => {
    // 0 providers or all models disabled
    const providerWithoutEnabled: Provider = {
      id: 'custom-p1',
      name: 'Custom Provider',
      brand: null,
      kind: 'custom',
      auth: { type: 'api_key' },
      status: { state: 'ok' },
      defaultModel: null,
      models: [
        {
          id: 'm1',
          name: 'Model 1',
          brand: null,
          enabled: false,
          contextWindow: 128000,
          maxTokens: 4096,
          images: false,
          reasoning: false,
          thinkingLevels: [],
          defaultThinkingLevel: null,
          overridden: {},
        },
      ],
    };

    mockUseProviders.mockReturnValue({
      providers: [providerWithoutEnabled],
      defaultModel: null,
      status: 'idle',
      error: null,
    });

    await render(<ProviderPage lang="zh" />);

    const picker = host!.querySelector('[data-testid="next-provider-default-picker"]') as HTMLButtonElement;
    expect(picker).not.toBeNull();
    expect(picker.disabled).toBe(true);

    // Clicking when disabled does not open
    await act(async () => {
      picker.click();
    });

    expect(document.querySelector('.mp-menu')).toBeNull();
    expect(document.querySelector('[data-testid="next-provider-default-item"]')).toBeNull();
  });

  it('enables picker when models are enabled, opens menu on click, and allows selecting', async () => {
    const providerWithEnabled: Provider = {
      id: 'p1',
      name: 'Provider One',
      brand: null,
      kind: 'builtin',
      auth: { type: 'api_key' },
      status: { state: 'ok' },
      defaultModel: 'm1',
      models: [
        {
          id: 'm1',
          name: 'Model 1',
          brand: null,
          enabled: true,
          contextWindow: 128000,
          maxTokens: 4096,
          images: false,
          reasoning: false,
          thinkingLevels: [],
          defaultThinkingLevel: null,
          overridden: {},
        },
      ],
    };

    mockUseProviders.mockReturnValue({
      providers: [providerWithEnabled],
      defaultModel: { providerId: 'p1', modelId: 'm1' },
      status: 'idle',
      error: null,
    });

    await render(<ProviderPage lang="zh" />);

    const picker = host!.querySelector('[data-testid="next-provider-default-picker"]') as HTMLButtonElement;
    expect(picker).not.toBeNull();
    expect(picker.disabled).toBe(false);

    // Click to open
    await act(async () => {
      picker.click();
    });

    const item = document.querySelector('[data-testid="next-provider-default-item"]') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.textContent).toContain('Model 1');

    // Click item to select
    await act(async () => {
      item.click();
    });

    expect(mockPatchProvider).toHaveBeenCalledWith('p1', { defaultModel: 'm1' });
    expect(document.querySelector('.mp-menu')).toBeNull();
  });
});
