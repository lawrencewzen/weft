// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeneralPage, parseTriggerPercent, type CompactionEffective } from './GeneralPage';

const getSettings = vi.fn();
vi.mock('../../data/api', () => ({
  getSettings: () => getSettings(),
  putCompactionTrigger: vi.fn(),
}));

const model = (name: string, percent: number): CompactionEffective => ({
  providerId: 'p', modelId: name, name, percent,
});

describe('GeneralPage compaction hint', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
    getSettings.mockReset();
  });

  async function render(lang: 'zh' | 'en', effective: CompactionEffective[]) {
    getSettings.mockResolvedValue({ compaction: { triggerPercent: 80, effective } });
    await act(async () => {
      root!.render(<GeneralPage lang={lang} />);
    });
    await act(async () => { await Promise.resolve(); });
    return host!.querySelector('[data-testid=next-pref-compact-effective]');
  }

  it('lists the earlier models and all of them in the title', async () => {
    const el = await render('zh', [model('glm-4.6', 70), model('deepseek-chat', 75)]);
    expect(el?.textContent).toBe('部分模型会更早开始：glm-4.6 70%、deepseek-chat 75%');
    expect(el?.getAttribute('title')).toBe('glm-4.6 70%\ndeepseek-chat 75%');
  });

  it('uses the English wording', async () => {
    const el = await render('en', [model('glm-4.6', 70), model('deepseek-chat', 75)]);
    expect(el?.textContent).toBe('Some models start earlier: glm-4.6 70%, deepseek-chat 75%');
  });

  it('shows nothing when effective is empty', async () => {
    expect(await render('zh', [])).toBeNull();
  });

  it('caps the line at three models and counts the rest', async () => {
    const list = [model('a', 70), model('b', 71), model('c', 72), model('d', 73), model('e', 74)];
    const zh = await render('zh', list);
    expect(zh?.textContent).toBe('部分模型会更早开始：a 70%、b 71%、c 72% 等 2 个');
    expect(zh?.getAttribute('title')?.split('\n')).toHaveLength(5);
    await act(async () => { root!.unmount(); });
    root = createRoot(host!);
    const en = await render('en', list);
    expect(en?.textContent).toBe('Some models start earlier: a 70%, b 71%, c 72% and 2 more');
  });
});

describe('parseTriggerPercent', () => {
  it('accepts whole numbers from 60 to 90', () => {
    expect(parseTriggerPercent('60')).toBe(60);
    expect(parseTriggerPercent(' 80 ')).toBe(80);
    expect(parseTriggerPercent('90')).toBe(90);
  });

  it('rejects out-of-range, fractional and non-numeric input', () => {
    for (const bad of ['59', '91', '1.5', '75.0', '', 'abc', '-70', '1e2', '080x']) {
      expect(parseTriggerPercent(bad), bad).toBeNull();
    }
  });
});
