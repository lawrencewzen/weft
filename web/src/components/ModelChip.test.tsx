/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelChip } from './ModelChip';
import type { ComposerModelGroup, ComposerModelOption } from '../data/composerModel';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

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
  if (host && host.parentNode) {
    host.parentNode.removeChild(host);
    host = null;
  }
}

const flashOption: ComposerModelOption = {
  providerId: 'deepseek',
  providerName: 'DeepSeek',
  providerBrand: 'deepseek',
  modelId: 'deepseek-flash',
  displayName: 'DeepSeek V4.1 Flash',
  brand: 'deepseek',
  contextWindow: 1000000,
  contextWindowCustom: false,
  isDefault: true,
  images: true,
  thinkingLevels: ['off', 'low', 'high', 'max'],
  defaultThinkingLevel: 'high',
};

const proOption: ComposerModelOption = {
  providerId: 'deepseek',
  providerName: 'DeepSeek',
  providerBrand: 'deepseek',
  modelId: 'deepseek-v4-pro',
  displayName: 'DeepSeek V4 Pro',
  brand: 'deepseek',
  contextWindow: 1000000,
  contextWindowCustom: false,
  isDefault: false,
  images: false,
  thinkingLevels: ['off', 'high', 'max'],
  defaultThinkingLevel: 'high',
};

const qwenOption: ComposerModelOption = {
  providerId: 'custom-9f01',
  providerName: '内网网关',
  providerBrand: null,
  modelId: 'qwen3-coder-480b',
  displayName: 'qwen3-coder-480b',
  brand: 'qwen',
  contextWindow: 262144,
  contextWindowCustom: false,
  isDefault: false,
  images: false,
  thinkingLevels: [],
  defaultThinkingLevel: null,
};

const groups: ComposerModelGroup[] = [
  {
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    providerBrand: 'deepseek',
    mixedBrands: false,
    models: [flashOption, proOption],
  },
  {
    providerId: 'custom-9f01',
    providerName: '内网网关',
    providerBrand: null,
    mixedBrands: false,
    models: [qwenOption],
  },
];

describe('ModelChip component', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {};
    const fakeLocalStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, val: string) => { storage[key] = val; },
      removeItem: (key: string) => { delete storage[key]; },
      clear: () => { Object.keys(storage).forEach((k) => delete storage[k]); },
    };
    vi.stubGlobal('localStorage', fakeLocalStorage);
  });

  afterEach(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  it('shows no suffix when thinking level is off', async () => {
    await render(
      <ModelChip
        lang="zh"
        selected={flashOption}
        groups={groups}
        thinkingLevel="off"
        onPick={vi.fn()}
        onManage={vi.fn()}
      />
    );

    const chip = host?.querySelector('[data-testid="next-model-chip"]');
    expect(chip?.textContent).toContain('DeepSeek V4.1 Flash');
    expect(host?.querySelector('[data-testid="next-model-chip-thinking"]')).toBeNull();
  });

  it('shows suffix when thinking level is on', async () => {
    await render(
      <ModelChip
        lang="zh"
        selected={flashOption}
        groups={groups}
        thinkingLevel="high"
        onPick={vi.fn()}
        onManage={vi.fn()}
      />
    );

    const suffix = host?.querySelector('[data-testid="next-model-chip-thinking"]');
    expect(suffix).not.toBeNull();
    expect(suffix?.textContent).toContain('· 高');
  });

  it('shows no suffix when model does not support thinking', async () => {
    await render(
      <ModelChip
        lang="zh"
        selected={qwenOption}
        groups={groups}
        thinkingLevel="high"
        onPick={vi.fn()}
        onManage={vi.fn()}
      />
    );

    const suffix = host?.querySelector('[data-testid="next-model-chip-thinking"]');
    expect(suffix).toBeNull();
  });

  it('clamps level to supported levels for display', async () => {
    // proOption only supports ['off', 'high', 'max']. Level 'low' clamps to 'high'
    await render(
      <ModelChip
        lang="zh"
        selected={proOption}
        groups={groups}
        thinkingLevel="low"
        onPick={vi.fn()}
        onManage={vi.fn()}
      />
    );

    const suffix = host?.querySelector('[data-testid="next-model-chip-thinking"]');
    expect(suffix?.textContent).toContain('· 高');
  });

  it('disables thinking row when model does not support thinking', async () => {
    await render(
      <ModelChip
        lang="zh"
        selected={qwenOption}
        groups={groups}
        thinkingLevel={null}
        onPick={vi.fn()}
        onManage={vi.fn()}
      />
    );

    const chip = host?.querySelector('[data-testid="next-model-chip"]') as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });

    const thinkRow = host?.querySelector('[data-testid="next-menu-thinking"]');
    expect(thinkRow?.classList.contains('dis')).toBe(true);
    expect(thinkRow?.getAttribute('aria-disabled')).toBe('true');
    expect(thinkRow?.textContent).toContain('不支持');
  });

  it('opens thinking submenu and allows picking a level', async () => {
    const onPickThinking = vi.fn();
    await render(
      <ModelChip
        lang="zh"
        selected={flashOption}
        groups={groups}
        thinkingLevel="low"
        onPick={vi.fn()}
        onPickThinkingLevel={onPickThinking}
        onManage={vi.fn()}
      />
    );

    const chip = host?.querySelector('[data-testid="next-model-chip"]') as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });

    const thinkRow = host?.querySelector('[data-testid="next-menu-thinking"]') as HTMLDivElement;
    await act(async () => {
      thinkRow.click();
    });

    const maxOption = host?.querySelector('[data-testid="next-thinking-option"][data-level="max"]') as HTMLButtonElement;
    expect(maxOption).not.toBeNull();
    expect(maxOption.textContent).toContain('最高');
    expect(maxOption.textContent).toContain('最难的问题，最慢最贵');

    await act(async () => {
      maxOption.click();
    });

    expect(onPickThinking).toHaveBeenCalledWith('max');
  });

  it('displays current context window value in the primary menu', async () => {
    await render(
      <ModelChip
        lang="zh"
        selected={flashOption}
        groups={groups}
        contextWindow={1000000}
        onPick={vi.fn()}
        onManage={vi.fn()}
        onSetContextWindow={vi.fn()}
      />
    );

    const chip = host?.querySelector('[data-testid="next-model-chip"]') as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });

    const ctxRow = host?.querySelector('[data-testid="next-menu-context"]');
    expect(ctxRow).not.toBeNull();
    expect(ctxRow?.textContent).toContain('上下文');
    expect(ctxRow?.textContent).toContain('1M · 默认');
    expect(ctxRow?.textContent).not.toContain('自定义');
  });

  it('displays custom mark when context window is not a preset', async () => {
    await render(
      <ModelChip
        lang="zh"
        selected={flashOption}
        groups={groups}
        contextWindow={50000}
        onPick={vi.fn()}
        onManage={vi.fn()}
        onSetContextWindow={vi.fn()}
      />
    );

    const chip = host?.querySelector('[data-testid="next-model-chip"]') as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });

    const ctxRow = host?.querySelector('[data-testid="next-menu-context"]');
    expect(ctxRow?.textContent).toContain('50k · 自定义');
  });

  it('opens context submenu and picks a preset', async () => {
    const onSetContext = vi.fn();
    await render(
      <ModelChip
        lang="zh"
        selected={flashOption}
        groups={groups}
        contextWindow={1000000}
        onPick={vi.fn()}
        onManage={vi.fn()}
        onSetContextWindow={onSetContext}
      />
    );

    const chip = host?.querySelector('[data-testid="next-model-chip"]') as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });

    const ctxRow = host?.querySelector('[data-testid="next-menu-context"]') as HTMLDivElement;
    await act(async () => {
      ctxRow.click();
    });

    const sub = host?.querySelector('[data-testid="next-sub-context"]');
    expect(sub).not.toBeNull();
    expect(sub?.textContent).toContain('上下文上限');
    expect(sub?.textContent).not.toContain('DeepSeek V4.1 Flash 的上下文上限');

    const opt128 = host?.querySelector('[data-testid="next-context-option"][data-tokens="128000"]') as HTMLButtonElement;
    expect(opt128).not.toBeNull();

    await act(async () => {
      opt128.click();
    });

    expect(onSetContext).toHaveBeenCalledWith(128000);
  });

  it('validates custom input and submits parsed token count', async () => {
    const onSetContext = vi.fn();
    await render(
      <ModelChip
        lang="zh"
        selected={flashOption}
        groups={groups}
        contextWindow={1000000}
        onPick={vi.fn()}
        onManage={vi.fn()}
        onSetContextWindow={onSetContext}
      />
    );

    const chip = host?.querySelector('[data-testid="next-model-chip"]') as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });

    const ctxRow = host?.querySelector('[data-testid="next-menu-context"]') as HTMLDivElement;
    await act(async () => {
      ctxRow.click();
    });

    const input = host?.querySelector('[data-testid="next-context-custom"]') as HTMLInputElement;
    const form = host?.querySelector('form.context-custom') as HTMLFormElement;

    // Invalid input: below range
    await act(async () => {
      setInputValue(input, '100');
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(host?.querySelector('.context-custom-error')?.textContent).toContain('范围');
    expect(onSetContext).not.toHaveBeenCalled();

    // Valid input: 65536
    await act(async () => {
      setInputValue(input, '65536');
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSetContext).toHaveBeenCalledWith(65536);
  });

  it('restores default context window with null', async () => {
    const onSetContext = vi.fn();
    await render(
      <ModelChip
        lang="zh"
        selected={flashOption}
        groups={groups}
        contextWindow={65536}
        onPick={vi.fn()}
        onManage={vi.fn()}
        onSetContextWindow={onSetContext}
      />
    );

    const chip = host?.querySelector('[data-testid="next-model-chip"]') as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });

    const ctxRow = host?.querySelector('[data-testid="next-menu-context"]') as HTMLDivElement;
    await act(async () => {
      ctxRow.click();
    });

    const restoreBtn = host?.querySelector('[data-testid="next-context-restore"]') as HTMLButtonElement;
    expect(restoreBtn).not.toBeNull();
    expect(restoreBtn.textContent).toContain('恢复默认');

    await act(async () => {
      restoreBtn.click();
    });

    expect(onSetContext).toHaveBeenCalledWith(null);
  });

  it('disables context row when no model is selected', async () => {
    await render(
      <ModelChip
        lang="zh"
        selected={null}
        groups={groups}
        onPick={vi.fn()}
        onManage={vi.fn()}
        onSetContextWindow={vi.fn()}
      />
    );

    const chip = host?.querySelector('[data-testid="next-model-chip"]') as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });

    const ctxRow = host?.querySelector('[data-testid="next-menu-context"]');
    expect(ctxRow?.classList.contains('dis')).toBe(true);
    expect(ctxRow?.getAttribute('aria-disabled')).toBe('true');
  });

  it('separates default and custom for a model with 1048576 context window', async () => {
    const v4Option: ComposerModelOption = {
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      providerBrand: 'deepseek',
      modelId: 'deepseek-v4-flash',
      displayName: 'DeepSeek-V4.1-Flash',
      brand: 'deepseek',
      contextWindow: 1048576,
      contextWindowCustom: false,
      defaultContextWindow: 1048576,
      isDefault: false,
      images: false,
      thinkingLevels: [],
      defaultThinkingLevel: null,
    };

    // 1. Default state: 1048576 not overridden
    await render(
      <ModelChip
        lang="zh"
        selected={v4Option}
        groups={groups}
        contextWindow={1048576}
        onPick={vi.fn()}
        onSetContextWindow={vi.fn()}
      />
    );

    const chip = host?.querySelector('[data-testid="next-model-chip"]') as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });

    // Main menu context row shows 1,048,576 · 默认
    const ctxRow = host?.querySelector('[data-testid="next-menu-context"]') as HTMLDivElement;
    expect(ctxRow?.textContent).toContain('1,048,576 · 默认');
    // Footer with "只对这个对话生效 · 管理模型" must be gone
    expect(host?.querySelector('[data-testid="next-model-manage"]')).toBeNull();
    expect(host?.textContent).not.toContain('只对这个对话生效');

    // Open context submenu
    await act(async () => {
      ctxRow.click();
    });

    const sub = host?.querySelector('[data-testid="next-sub-context"]');
    expect(sub).not.toBeNull();
    expect(sub?.textContent).toContain('上下文上限');
    // Should NOT show "按模型保存"
    expect(sub?.textContent).not.toContain('按模型保存');
    // Value is default, so "恢复默认" must NOT be rendered
    expect(host?.querySelector('[data-testid="next-context-restore"]')).toBeNull();

    // Context options list:
    // Only one '1M' (the 1,000,000 preset)
    const opt1M = host?.querySelector('[data-testid="next-context-option"][data-tokens="1000000"]');
    expect(opt1M?.textContent).toContain('1M');
    expect(opt1M?.textContent).not.toContain('默认');
    expect(opt1M?.textContent).not.toContain('自定义');

    // Exactly one '1,048,576' line marked 默认
    const opt1048576 = host?.querySelector('[data-testid="next-context-option"][data-tokens="1048576"]');
    expect(opt1048576?.textContent).toContain('1,048,576');
    expect(opt1048576?.textContent).toContain('默认');
    expect(opt1048576?.getAttribute('aria-selected')).toBe('true');

    await cleanup();

    // 2. Overridden to 128k
    const overriddenOption: ComposerModelOption = {
      ...v4Option,
      contextWindow: 128000,
      contextWindowCustom: true,
      defaultContextWindow: 1048576,
    };

    await render(
      <ModelChip
        lang="zh"
        selected={overriddenOption}
        groups={groups}
        contextWindow={128000}
        onPick={vi.fn()}
        onSetContextWindow={vi.fn()}
      />
    );

    const chip2 = host?.querySelector('[data-testid="next-model-chip"]') as HTMLButtonElement;
    await act(async () => {
      chip2.click();
    });

    // Main menu shows 128k · 自定义
    const ctxRow2 = host?.querySelector('[data-testid="next-menu-context"]') as HTMLDivElement;
    expect(ctxRow2?.textContent).toContain('128k · 自定义');

    await act(async () => {
      ctxRow2.click();
    });

    // In submenu, 128k is marked 自定义
    const opt128 = host?.querySelector('[data-testid="next-context-option"][data-tokens="128000"]');
    expect(opt128?.textContent).toContain('128k');
    expect(opt128?.textContent).toContain('自定义');
    expect(opt128?.getAttribute('aria-selected')).toBe('true');

    // 1,048,576 is still listed and marked 默认
    const optDefault = host?.querySelector('[data-testid="next-context-option"][data-tokens="1048576"]');
    expect(optDefault?.textContent).toContain('1,048,576');
    expect(optDefault?.textContent).toContain('默认');
    expect(optDefault?.getAttribute('aria-selected')).toBe('false');

    // "恢复默认" IS available
    const restoreBtn = host?.querySelector('[data-testid="next-context-restore"]');
    expect(restoreBtn).not.toBeNull();
    expect(restoreBtn?.textContent).toContain('恢复默认');
  });
});
