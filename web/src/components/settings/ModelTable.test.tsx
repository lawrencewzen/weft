/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelTable } from './ModelTable';
import type { Model, Provider } from '../../data/providerTypes';

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

function model(partial: Partial<Model> & Pick<Model, 'id' | 'name'>): Model {
  return {
    brand: 'deepseek',
    enabled: true,
    contextWindow: 128000,
    maxTokens: 8000,
    images: false,
    reasoning: false,
    thinkingLevels: [],
    defaultThinkingLevel: null,
    overridden: {},
    ...partial,
  };
}

function providerOf(models: Model[]): Provider {
  return {
    id: 'deepseek',
    kind: 'builtin',
    brand: 'deepseek',
    name: 'DeepSeek',
    auth: { type: 'api_key' },
    status: { state: 'ok' },
    models,
  };
}

describe('ModelTable', () => {
  afterEach(async () => {
    await cleanup();
  });

  it('shows the display name only and keeps the id on the name-cell title', async () => {
    await render(
      <ModelTable
        lang="zh"
        provider={providerOf([
          model({ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }),
        ])}
        onToggleModel={vi.fn(async () => {})}
        onSaveOverride={vi.fn(async () => {})}
      />,
    );
    const row = host!.querySelector('[data-testid="next-model-row"][data-model="deepseek-flash"]') as HTMLElement;
    const nameCell = row.querySelector('.mp-mt-name') as HTMLElement;
    expect(nameCell.textContent).toBe('DeepSeek V4.1 Flash');
    expect(nameCell.getAttribute('title')).toBe('deepseek-flash');
    expect(row.textContent).not.toContain('deepseek-flash');
    expect(row.querySelector('.mp-mt-id')).toBeNull();
  });
});
