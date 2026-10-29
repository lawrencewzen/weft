/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelChip } from './ModelChip';
import type { ComposerModelGroup, ComposerModelOption } from '../data/composerModel';

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
});
