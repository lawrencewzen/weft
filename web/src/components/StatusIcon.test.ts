/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArchiveIcon,
  StatusIcon,
  statusIconFor,
  statusTitle,
  statusTone,
  statusToneClass,
} from './StatusIcon';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(node: Parameters<Root['render']>[0]): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  return host;
}

afterEach(async () => {
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
});

describe('statusIconFor mapping', () => {
  it('maps conversation statuses with default conversation kind', () => {
    expect(statusIconFor('running')).toBe('running');
    expect(statusIconFor('waiting')).toBe('waiting');
    expect(statusIconFor('waiting', 'conversation')).toBe('waiting');
    expect(statusIconFor('failed')).toBe('failed');
    expect(statusIconFor('stuck')).toBe('stuck');
    expect(statusIconFor('stopped')).toBe('stopped');
    expect(statusIconFor('queued')).toBe('queued');
    expect(statusIconFor('done')).toBe('done');
  });

  it('maps subagent waiting to queued, preserving other statuses', () => {
    expect(statusIconFor('waiting', 'subagent')).toBe('queued');
    expect(statusIconFor('running', 'subagent')).toBe('running');
    expect(statusIconFor('failed', 'subagent')).toBe('failed');
    expect(statusIconFor('stuck', 'subagent')).toBe('stuck');
    expect(statusIconFor('stopped', 'subagent')).toBe('stopped');
    expect(statusIconFor('queued', 'subagent')).toBe('queued');
    expect(statusIconFor('done', 'subagent')).toBe('done');
  });

  it('maps idle, empty, null, and unknown to null', () => {
    expect(statusIconFor('idle')).toBeNull();
    expect(statusIconFor('')).toBeNull();
    expect(statusIconFor(null)).toBeNull();
    expect(statusIconFor(undefined)).toBeNull();
    expect(statusIconFor('unknown_status')).toBeNull();
  });

  it('handles compatible alias statuses like uploading and error', () => {
    expect(statusIconFor('uploading')).toBe('running');
    expect(statusIconFor('error')).toBe('failed');
    expect(statusIconFor('interrupted')).toBe('stopped');
    expect(statusIconFor('success')).toBe('done');
  });
});

describe('three-tier status tone mapping', () => {
  it('maps hot tier (waiting, failed, stuck) -> 最深 var(--ink)', () => {
    expect(statusTone('waiting')).toBe('hot');
    expect(statusToneClass('waiting')).toBe('is-hot');

    expect(statusTone('failed')).toBe('hot');
    expect(statusToneClass('failed')).toBe('is-hot');

    expect(statusTone('stuck')).toBe('hot');
    expect(statusToneClass('stuck')).toBe('is-hot');
  });

  it('maps mid tier (running) -> 中等 var(--mute)', () => {
    expect(statusTone('running')).toBe('mid');
    expect(statusToneClass('running')).toBe('is-mid');
  });

  it('maps calm tier (stopped, queued, done) -> 最浅 var(--faint)', () => {
    expect(statusTone('stopped')).toBe('calm');
    expect(statusToneClass('stopped')).toBe('is-calm');

    expect(statusTone('queued')).toBe('calm');
    expect(statusToneClass('queued')).toBe('is-calm');

    expect(statusTone('done')).toBe('calm');
    expect(statusToneClass('done')).toBe('is-calm');
  });
});

describe('statusTitle i18n', () => {
  it('provides default titles in Chinese and English', () => {
    expect(statusTitle('running', 'zh')).toBe('运行中');
    expect(statusTitle('running', 'en')).toBe('Running');

    expect(statusTitle('waiting', 'zh')).toBe('等待中');
    expect(statusTitle('waiting', 'en')).toBe('Waiting');

    expect(statusTitle('failed', 'zh')).toBe('失败');
    expect(statusTitle('failed', 'en')).toBe('Failed');

    expect(statusTitle('stuck', 'zh')).toBe('卡住');
    expect(statusTitle('stuck', 'en')).toBe('Stuck');

    expect(statusTitle('stopped', 'zh')).toBe('已停止');
    expect(statusTitle('stopped', 'en')).toBe('Stopped');

    expect(statusTitle('queued', 'zh')).toBe('排队中');
    expect(statusTitle('queued', 'en')).toBe('Queued');

    expect(statusTitle('done', 'zh')).toBe('完成');
    expect(statusTitle('done', 'en')).toBe('Done');
  });
});

describe('<StatusIcon /> component', () => {
  it('renders svg with data-testid="status-icon" and data-status', async () => {
    const el = await mount(createElement(StatusIcon, { status: 'running' }));
    const svg = el.querySelector('svg[data-testid="status-icon"]');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('data-status')).toBe('running');
    expect(svg?.classList.contains('status-icon-running')).toBe(true);
    expect(svg?.classList.contains('is-mid')).toBe(true);
    expect(svg?.classList.contains('mid')).toBe(true);
  });

  it('renders hot tone classes for waiting, failed, stuck', async () => {
    const el1 = await mount(createElement(StatusIcon, { status: 'waiting' }));
    const s1 = el1.querySelector('svg[data-testid="status-icon"]');
    expect(s1?.classList.contains('is-hot')).toBe(true);
    expect(s1?.classList.contains('hot')).toBe(true);

    const el2 = await mount(createElement(StatusIcon, { status: 'failed' }));
    const s2 = el2.querySelector('svg[data-testid="status-icon"]');
    expect(s2?.classList.contains('is-hot')).toBe(true);

    const el3 = await mount(createElement(StatusIcon, { status: 'stuck' }));
    const s3 = el3.querySelector('svg[data-testid="status-icon"]');
    expect(s3?.classList.contains('is-hot')).toBe(true);
  });

  it('renders calm tone classes for stopped, queued, done', async () => {
    const el1 = await mount(createElement(StatusIcon, { status: 'stopped' }));
    expect(el1.querySelector('svg[data-testid="status-icon"]')?.classList.contains('is-calm')).toBe(true);

    const el2 = await mount(createElement(StatusIcon, { status: 'queued' }));
    expect(el2.querySelector('svg[data-testid="status-icon"]')?.classList.contains('is-calm')).toBe(true);

    const el3 = await mount(createElement(StatusIcon, { status: 'done' }));
    expect(el3.querySelector('svg[data-testid="status-icon"]')?.classList.contains('is-calm')).toBe(true);
  });

  it('supports custom size and title', async () => {
    const el = await mount(createElement(StatusIcon, { status: 'done', size: 20, title: '自定义完成' }));
    const svg = el.querySelector('svg[data-testid="status-icon"]');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('height')).toBe('20');
    expect(svg?.querySelector('title')?.textContent).toBe('自定义完成');
  });

  it('returns null if status is null or undefined or falsy', async () => {
    // @ts-expect-error testing null input
    const el = await mount(createElement(StatusIcon, { status: null }));
    expect(el.querySelector('svg[data-testid="status-icon"]')).toBeNull();
  });
});

describe('<ArchiveIcon /> component', () => {
  it('renders svg with data-testid="archive-icon"', async () => {
    const el = await mount(createElement(ArchiveIcon, { size: 16 }));
    const svg = el.querySelector('svg[data-testid="archive-icon"]');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
  });
});
