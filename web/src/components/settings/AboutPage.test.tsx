/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AboutPage } from './AboutPage';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('AboutPage', () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('renders about page with version, repo, and runtime, but no upstream credit or demo model row', async () => {
    await render(
      <AboutPage
        lang="zh"
        service={{ serviceVersion: '0.2.0', protocolVersion: '2.0.0' }}
      />,
    );

    expect(host?.textContent).toContain('Weft');
    expect(host?.textContent).toContain('0.2.0');
    expect(host?.textContent).toContain('2.0.0');
    expect(host?.textContent).toContain('github.com/lawrencewzen/weft');
    expect(host?.textContent).toContain('MIT');
    expect(host?.textContent).toContain('Pi Durable Runtime 已连接');

    // Must not contain upstream project / thanks
    expect(host?.textContent).not.toContain('致谢');
    expect(host?.textContent).not.toContain('上游');

    // Must not contain demo model row
    expect(host?.textContent).not.toContain('演示模型');

    const links = Array.from(host?.querySelectorAll('a') ?? []).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://github.com/lawrencewzen/weft']);
  });

  it('renders in English without upstream credit or demo model row', async () => {
    await render(
      <AboutPage
        lang="en"
        service={{ serviceVersion: '0.2.0', protocolVersion: '2.0.0' }}
      />,
    );

    expect(host?.textContent).toContain('Weft');
    expect(host?.textContent).toContain('Repository');
    expect(host?.textContent).toContain('License');
    expect(host?.textContent).toContain('Pi Durable Runtime connected');

    expect(host?.textContent).not.toContain('Thanks');
    expect(host?.textContent).not.toContain('Upstream');
    expect(host?.textContent).not.toContain('Demo model');

    const links = Array.from(host?.querySelectorAll('a') ?? []).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://github.com/lawrencewzen/weft']);
  });
});
