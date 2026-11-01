/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddProviderDialog } from './AddProviderDialog';
import type { Available, Model, Provider } from '../../data/providerTypes';

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

function vendor(partial: Partial<Available> & Pick<Available, 'id' | 'name'>): Available {
  return {
    authMethods: ['api_key'],
    modelCount: 3,
    popular: false,
    envDetected: false,
    connected: false,
    brand: partial.id,
    ...partial,
  };
}

function models(): Model[] {
  return [
    {
      id: 'grok-4-7',
      name: 'Grok 4.7',
      brand: 'xai',
      enabled: true,
      contextWindow: 256000,
      maxTokens: 8000,
      images: false,
      reasoning: true,
      thinkingLevels: [],
      defaultThinkingLevel: null,
      overridden: {},
    },
    {
      id: 'grok-unknown',
      name: 'Grok Unknown',
      brand: 'xai',
      enabled: true,
      contextWindow: null,
      maxTokens: null,
      images: false,
      reasoning: false,
      thinkingLevels: [],
      defaultThinkingLevel: null,
      overridden: {},
    },
  ];
}

function providerOf(id: string, name: string, list = models()): Provider {
  return {
    id,
    kind: 'builtin',
    brand: id,
    name,
    auth: { type: 'oauth', account: 'lawrence@x.com' },
    status: { state: 'ok' },
    models: list,
  };
}

const grokDetected: Available = vendor({
  id: 'xai',
  name: 'Grok',
  authMethods: ['oauth'],
  localLogin: { detected: true, account: 'lawrence@x.com' },
});

const grokMissing: Available = vendor({
  id: 'xai',
  name: 'Grok',
  authMethods: ['oauth'],
  localLogin: { detected: false },
});

const anthropic: Available = vendor({ id: 'anthropic', name: 'Anthropic' });
const deepseek: Available = vendor({ id: 'deepseek', name: 'DeepSeek', connected: true });

function props(overrides: Record<string, unknown> = {}) {
  return {
    lang: 'zh' as const,
    isOpen: true,
    onClose: vi.fn(),
    available: [grokDetected, anthropic, deepseek],
    loginSession: null,
    onAnswerOAuth: vi.fn(),
    onCancelOAuth: vi.fn(),
    onStartOAuth: vi.fn(),
    onConnect: vi.fn(async () => providerOf('xai', 'Grok')),
    onConnectCustom: vi.fn(),
    onCreate: vi.fn(),
    onRollback: vi.fn(),
    ...overrides,
  };
}

describe('AddProviderDialog', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(async () => {
    await cleanup();
  });

  it('groups left list, ticks the selected item, and greys connected without model counts', async () => {
    await render(<AddProviderDialog {...props()} />);
    const text = host!.textContent || '';
    expect(text).toContain('内置 Agent');
    expect(text).toContain('API Key');
    expect(text).toContain('ACP');
    expect(text).toContain('Grok');
    expect(text).toContain('Anthropic');
    expect(text).toContain('自定义接口');
    expect(text).toContain('Claude Code');
    expect(text).toContain('Antigravity');
    expect(text).toContain('已接入');
    expect(text).not.toContain('只保存在本机');
    expect(text).not.toContain('显示在 Provider 列表');
    expect(text).not.toMatch(/\d+\s*个模型/);
    expect(host!.querySelector('[data-vendor="xai"]')?.textContent).toContain('✓');
    expect(host!.querySelector('[data-vendor="deepseek"]')?.className).toContain('dis');
  });

  it('keeps auto-connect result when available is replaced with a new array', async () => {
    let resolveConnect: ((provider: Provider) => void) | undefined;
    const pending = new Promise<Provider>((resolve) => { resolveConnect = resolve; });
    const onConnect = vi.fn(() => pending);
    const initial = props({ onConnect });
    await render(<AddProviderDialog {...initial} />);
    await act(async () => { await Promise.resolve(); });
    expect(onConnect).toHaveBeenCalled();
    await act(async () => {
      root!.render(<AddProviderDialog {...props({
        onConnect,
        available: initial.available.map((item) => ({ ...item })),
      })} />);
    });
    await act(async () => { resolveConnect?.(providerOf('xai', 'Grok')); });
    const dd = host!.querySelector('[data-testid="next-add-model-dropdown"]') as HTMLButtonElement;
    expect(dd.disabled).toBe(false);
    expect(dd.textContent).toContain('Grok 4.7');
  });

  it('shows Grok detected account and auto-connects with local_login', async () => {
    const onConnect = vi.fn(async () => providerOf('xai', 'Grok'));
    await render(<AddProviderDialog {...props({ onConnect })} />);
    await act(async () => { await Promise.resolve(); });
    expect(onConnect).toHaveBeenCalledWith('xai', { method: 'local_login' });
    const detected = host!.querySelector('[data-testid="next-grok-detected"]') as HTMLInputElement;
    expect(detected?.value).toContain('已检测到本机 Grok 登录 · lawrence@x.com');
    expect(host!.querySelector('[data-testid="next-detected-check"]')).toBeTruthy();
    const dd = host!.querySelector('[data-testid="next-add-model-dropdown"]') as HTMLButtonElement;
    expect(dd.disabled).toBe(false);
    expect(dd.textContent).toContain('Grok 4.7');
    expect(dd.textContent).not.toContain('grok-4-7');
  });

  it('shows Sign in to Grok when local login is missing', async () => {
    await render(<AddProviderDialog {...props({ available: [grokMissing, anthropic] })} />);
    await act(async () => { await Promise.resolve(); });
    expect(host!.querySelector('[data-testid="next-grok-login"]')?.textContent).toContain('登录 Grok');
    expect(host!.textContent).not.toContain('已检测到本机 Grok 登录');
    const dd = host!.querySelector('[data-testid="next-add-model-dropdown"]') as HTMLButtonElement;
    expect(dd.disabled).toBe(true);
    expect(dd.textContent).toContain('连接后自动获取');
  });

  it('custom dropdown lists display names, hides ids, and omits null contextWindow', async () => {
    const onConnect = vi.fn(async () => providerOf('xai', 'Grok'));
    await render(<AddProviderDialog {...props({ onConnect })} />);
    await act(async () => { await Promise.resolve(); });
    const dd = host!.querySelector('[data-testid="next-add-model-dropdown"]') as HTMLButtonElement;
    await act(async () => { dd.click(); });
    const options = [...host!.querySelectorAll('[data-testid="next-add-model-option"]')];
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain('Grok 4.7');
    expect(options[0].textContent).toContain('256K');
    expect(options[0].textContent).not.toContain('grok-4-7');
    expect(options[1].textContent).toContain('Grok Unknown');
    expect(options[1].textContent).not.toContain('128K');
    expect(options[1].textContent).not.toContain('grok-unknown');
  });

  it('enables Antigravity ACP when available and auto-connects local login', async () => {
    const agy: Available = vendor({
      id: 'antigravity-acp',
      name: 'Google Antigravity (ACP)',
      authMethods: ['oauth'],
      localLogin: { detected: true },
    });
    const onConnect = vi.fn(async () => providerOf('antigravity-acp', 'Antigravity', [{
      id: 'gemini-3.8-flash',
      name: 'Gemini 3.8 Flash',
      brand: 'google',
      enabled: true,
      contextWindow: 1000000,
      maxTokens: 65536,
      images: true,
      reasoning: true,
      thinkingLevels: ['low', 'medium', 'high'],
      defaultThinkingLevel: 'medium',
      overridden: {},
    }]));
    await render(<AddProviderDialog {...props({
      available: [grokMissing, agy],
      onConnect,
    })} />);
    await act(async () => {
      (host!.querySelector('[data-vendor="antigravity-acp"]') as HTMLElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    expect(onConnect).toHaveBeenCalledWith('antigravity-acp', { method: 'local_login' });
    expect(host!.querySelector('[data-testid="next-agy-detected"]')).toBeTruthy();
    expect(host!.querySelector('[data-testid="next-acp-coming"]')).toBeNull();
    const finish = host!.querySelector('[data-testid="next-provider-finish"]') as HTMLButtonElement;
    expect(finish.disabled).toBe(false);
    expect(finish.textContent).toContain('创建');
  });

  it('disables ACP fields and the coming-soon button', async () => {
    await render(<AddProviderDialog {...props()} />);
    await act(async () => {
      (host!.querySelector('[data-vendor="claude-code"]') as HTMLElement).click();
    });
    expect(host!.querySelector('[data-testid="next-acp-coming"]')?.hasAttribute('disabled')).toBe(true);
    expect(host!.textContent).toContain('即将支持');
    const path = host!.querySelector('.mp-add-form input.mono') as HTMLInputElement;
    expect(path.disabled).toBe(true);
    expect(path.placeholder).toBe('/path/to/claude');
    expect(host!.querySelector('[data-testid="next-add-model-dropdown"]')).toBeNull();
  });

  it('rolls back a connect that finishes after cancel', async () => {
    let resolveConnect: ((provider: Provider) => void) | undefined;
    const pending = new Promise<Provider>((resolve) => { resolveConnect = resolve; });
    const onConnect = vi.fn(() => pending);
    const onRollback = vi.fn(async () => {});
    const onClose = vi.fn();
    await render(<AddProviderDialog {...props({ onConnect, onRollback, onClose })} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      (host!.querySelector('[data-testid="next-add-cancel"]') as HTMLButtonElement).click();
    });
    expect(onClose).toHaveBeenCalled();
    await act(async () => { resolveConnect?.(providerOf('xai', 'Grok')); });
    expect(onRollback).toHaveBeenCalledWith(['xai']);
  });

  it('rolls back leftover providers on cancel', async () => {
    const onRollback = vi.fn(async () => {});
    const onClose = vi.fn();
    const onConnect = vi.fn(async () => providerOf('xai', 'Grok'));
    await render(<AddProviderDialog {...props({ onConnect, onRollback, onClose })} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      (host!.querySelector('[data-testid="next-add-cancel"]') as HTMLButtonElement).click();
    });
    expect(onRollback).toHaveBeenCalledWith(['xai']);
    expect(onClose).toHaveBeenCalled();
  });

  it('creates with PATCH name, all models enabled, and default model', async () => {
    const onCreate = vi.fn(async () => {});
    const onConnect = vi.fn(async () => providerOf('xai', 'Grok'));
    const onClose = vi.fn();
    await render(<AddProviderDialog {...props({ onConnect, onCreate, onClose })} />);
    await act(async () => { await Promise.resolve(); });
    const name = host!.querySelector('[data-testid="next-config-name"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(name, 'My Grok');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (host!.querySelector('[data-testid="next-provider-finish"]') as HTMLButtonElement).click();
    });
    expect(onCreate).toHaveBeenCalledWith('xai', {
      name: 'My Grok',
      enabled: ['grok-4-7', 'grok-unknown'],
      defaultModel: 'grok-4-7',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('resets config name and API key when switching left-column selection A to B', async () => {
    await render(<AddProviderDialog {...props({ available: [grokMissing, anthropic] })} />);
    await act(async () => {
      (host!.querySelector('[data-vendor="anthropic"]') as HTMLElement).click();
    });
    const nameA = host!.querySelector('[data-testid="next-config-name"]') as HTMLInputElement;
    expect(nameA.value).toBe('Anthropic');
    const keyA = host!.querySelector('[data-testid="next-key-input"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(keyA, 'sk-ant');
      keyA.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(keyA.value).toBe('sk-ant');

    await act(async () => {
      (host!.querySelector('[data-vendor="claude-code"]') as HTMLElement).click();
    });
    const nameB = host!.querySelector('[data-testid="next-config-name"]') as HTMLInputElement;
    expect(nameB.value).toBe('Claude Code');
    expect(host!.querySelector('[data-testid="next-key-input"]')).toBeNull();

    await act(async () => {
      (host!.querySelector('[data-vendor="anthropic"]') as HTMLElement).click();
    });
    const nameBack = host!.querySelector('[data-testid="next-config-name"]') as HTMLInputElement;
    const keyBack = host!.querySelector('[data-testid="next-key-input"]') as HTMLInputElement;
    expect(nameBack.value).toBe('Anthropic');
    expect(keyBack.value).toBe('');
    const dd = host!.querySelector('[data-testid="next-add-model-dropdown"]') as HTMLButtonElement;
    expect(dd.disabled).toBe(true);
    expect(dd.textContent).toContain('连接后自动获取');
  });

  it('connects API Key vendors via Test', async () => {
    const onConnect = vi.fn(async (id: string) => providerOf(id, 'Anthropic', models()));
    await render(<AddProviderDialog {...props({ onConnect })} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      (host!.querySelector('[data-vendor="anthropic"]') as HTMLElement).click();
    });
    const key = host!.querySelector('[data-testid="next-key-input"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(key, 'sk-ant');
      key.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (host!.querySelector('[data-testid="next-add-test"]') as HTMLButtonElement).click();
    });
    expect(onConnect).toHaveBeenCalledWith('anthropic', { method: 'api_key', apiKey: 'sk-ant' });
  });

  it('does not pull back selected provider when receiving polling updates for the same session', async () => {
    const session1 = {
      id: 'sess-1',
      providerId: 'xai',
      state: 'pending' as const,
      events: [{ type: 'progress' as const, message: 'waiting...' }],
    };
    const initialProps = props({
      available: [grokMissing, anthropic],
      loginSession: session1,
    });
    await render(<AddProviderDialog {...initialProps} />);
    await act(async () => { await Promise.resolve(); });

    // Initial session sets selectedId to xai
    expect(host!.querySelector('[data-vendor="xai"]')?.textContent).toContain('✓');

    // User switches to Anthropic during OAuth
    await act(async () => {
      (host!.querySelector('[data-vendor="anthropic"]') as HTMLElement).click();
    });
    expect(host!.querySelector('[data-vendor="anthropic"]')?.textContent).toContain('✓');

    // A polling update arrives with a new session object reference (same session id)
    const session2 = {
      id: 'sess-1',
      providerId: 'xai',
      state: 'pending' as const,
      events: [{ type: 'progress' as const, message: 'still waiting...' }],
    };
    await act(async () => {
      root!.render(<AddProviderDialog {...initialProps} loginSession={session2} />);
    });

    // The selection should NOT be pulled back to xai
    expect(host!.querySelector('[data-vendor="anthropic"]')?.textContent).toContain('✓');
    expect(host!.querySelector('[data-vendor="xai"]')?.textContent).not.toContain('✓');
  });

  it('shows "测试中…" for at least 500ms even if onConnect immediately resolves, turns to "✓ 已连通", and restores "测试" after 1500ms', async () => {
    vi.useFakeTimers();
    try {
      const onConnect = vi.fn(async () => providerOf('xai', 'Grok'));
      await render(<AddProviderDialog {...props({ onConnect })} />);
      await act(async () => { await Promise.resolve(); });

      const testBtn = host!.querySelector('[data-testid="next-add-test"]') as HTMLButtonElement;
      expect(testBtn.textContent).toBe('测试');
      expect(testBtn.disabled).toBe(false);

      await act(async () => {
        testBtn.click();
      });

      expect(testBtn.textContent).toBe('测试中…');
      expect(testBtn.disabled).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(499);
      });
      expect(testBtn.textContent).toBe('测试中…');
      expect(testBtn.disabled).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(testBtn.textContent).toBe('✓ 已连通');
      expect(testBtn.disabled).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(1499);
      });
      expect(testBtn.textContent).toBe('✓ 已连通');
      expect(testBtn.disabled).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(testBtn.textContent).toBe('测试');
      expect(testBtn.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps create button enabled (disabled state unchanged) during testing when ready', async () => {
    vi.useFakeTimers();
    try {
      const onConnect = vi.fn(async () => providerOf('xai', 'Grok'));
      await render(<AddProviderDialog {...props({ onConnect })} />);
      await act(async () => { await Promise.resolve(); });

      const createBtn = host!.querySelector('[data-testid="next-provider-finish"]') as HTMLButtonElement;
      const testBtn = host!.querySelector('[data-testid="next-add-test"]') as HTMLButtonElement;
      expect(createBtn.disabled).toBe(false);

      await act(async () => {
        testBtn.click();
      });

      expect(createBtn.disabled).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(createBtn.disabled).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(createBtn.disabled).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(createBtn.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows error, restores button to "测试", and does not show "✓ 已连通" on connect reject', async () => {
    vi.useFakeTimers();
    try {
      let fail = false;
      const onConnect = vi.fn(async () => {
        if (fail) throw new Error('API Key invalid');
        return providerOf('xai', 'Grok');
      });
      await render(<AddProviderDialog {...props({ onConnect })} />);
      await act(async () => { await Promise.resolve(); });

      const testBtn = host!.querySelector('[data-testid="next-add-test"]') as HTMLButtonElement;
      const createBtn = host!.querySelector('[data-testid="next-provider-finish"]') as HTMLButtonElement;
      expect(createBtn.disabled).toBe(false);

      fail = true;
      await act(async () => {
        testBtn.click();
      });

      expect(testBtn.textContent).toBe('测试中…');
      await act(async () => {
        vi.advanceTimersByTime(499);
      });
      expect(testBtn.textContent).toBe('测试中…');

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(host!.querySelector('[data-testid="next-test-result"]')?.textContent).toContain('API Key invalid');
      expect(testBtn.textContent).toBe('测试');
      expect(testBtn.disabled).toBe(false);
      expect(testBtn.textContent).not.toContain('已连通');
      expect(createBtn.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls onRollback with the new provider id when switching vendors within 500ms of clicking test', async () => {
    vi.useFakeTimers();
    try {
      const onConnect = vi.fn(async () => providerOf('xai-temp', 'Grok Temp'));
      const onRollback = vi.fn(async () => {});
      await render(<AddProviderDialog {...props({ onConnect, onRollback })} />);
      await act(async () => { await Promise.resolve(); });

      const testBtn = host!.querySelector('[data-testid="next-add-test"]') as HTMLButtonElement;
      await act(async () => {
        testBtn.click();
      });
      expect(testBtn.textContent).toBe('测试中…');

      // Switch to Anthropic within 500ms (at 200ms)
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      await act(async () => {
        (host!.querySelector('[data-vendor="anthropic"]') as HTMLElement).click();
      });

      // Advance past 500ms so minDelayPromise resolves and allSettled completes
      await act(async () => {
        vi.advanceTimersByTime(350);
      });

      // onRollback must be called with ['xai-temp']
      expect(onRollback).toHaveBeenCalledWith(['xai-temp']);

      // The new active vendor's test button is in normal '测试' state
      const anthropicTestBtn = host!.querySelector('[data-testid="next-add-test"]') as HTMLButtonElement;
      expect(anthropicTestBtn.textContent).toBe('测试');
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles synchronous throw in onConnect without sticking in testing state', async () => {
    let fail = false;
    const onConnect = vi.fn(() => {
      if (fail) throw new Error('Sync fail');
      return Promise.resolve(providerOf('xai', 'Grok'));
    });
    await render(<AddProviderDialog {...props({ onConnect })} />);
    await act(async () => { await Promise.resolve(); });

    const testBtn = host!.querySelector('[data-testid="next-add-test"]') as HTMLButtonElement;
    expect(testBtn.textContent).toBe('测试');

    fail = true;
    await act(async () => {
      testBtn.click();
    });

    expect(host!.querySelector('[data-testid="next-test-result"]')?.textContent).toContain('Sync fail');
    expect(testBtn.textContent).toBe('测试');
    expect(testBtn.disabled).toBe(false);
  });

  it('does not trigger blur connect when blurring to the test button', async () => {
    const onConnect = vi.fn(async () => providerOf('anthropic', 'Anthropic'));
    await render(<AddProviderDialog {...props({ onConnect })} />);
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      (host!.querySelector('[data-vendor="anthropic"]') as HTMLElement).click();
    });

    const keyInput = host!.querySelector('[data-testid="next-key-input"]') as HTMLInputElement;
    const testBtn = host!.querySelector('[data-testid="next-add-test"]') as HTMLButtonElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(keyInput, 'sk-test');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    onConnect.mockClear();

    await act(async () => {
      const blurEvt = new FocusEvent('blur', { bubbles: true, relatedTarget: testBtn });
      keyInput.dispatchEvent(blurEvt);
    });

    expect(onConnect).not.toHaveBeenCalled();
  });
});
