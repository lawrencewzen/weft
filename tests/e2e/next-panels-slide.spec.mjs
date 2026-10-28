import { test, expect } from '@playwright/test';
import { api, prepareWorkspaces, startServer } from './helpers/server.mjs';
import { loginNext } from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

async function createWorkspace(srv, name, wsPath) {
  const ws = await api(srv.url, 'POST', '/workspaces', { name, path: wsPath });
  expect(ws.status).toBe(201);
  return ws.body;
}

async function createConversation(srv, wsId, title) {
  const conv = await api(srv.url, 'POST', `/workspaces/${wsId}/conversations`, { title });
  expect(conv.status).toBe(201);
  return conv.body;
}

async function samplePositions(page, leftSelector, titleSelector, durationMs = 400, stepMs = 20) {
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    const data = await page.evaluate(({ lSel, tSel }) => {
      const elL = document.querySelector(lSel);
      const elT = document.querySelector(tSel);
      return {
        lx: elL ? elL.getBoundingClientRect().left : null,
        tx: elT ? elT.getBoundingClientRect().left : null,
      };
    }, { lSel: leftSelector, tSel: titleSelector });
    samples.push({ t: Date.now() - start, ...data });
    await page.waitForTimeout(stepMs);
  }
  return samples;
}

test('panels slide transition and monotonicity for left and right panels', async ({ page }) => {
  const prepared = await prepareWorkspaces(['slide-test']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const ws = await createWorkspace(srv, 'slide-test', prepared.dirs[0]);
    const conv = await createConversation(srv, ws.id, 'test-chat');
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    await expect(page.getByTestId('next-app')).toHaveAttribute('data-panel-ready', '1');
    await expect(page.getByTestId('next-sidebar')).toBeVisible();
    await expect(page.getByTestId('next-left-collapse')).toBeVisible();

    // 1. Collapse left panel
    const collapseLeftPromise = page.getByTestId('next-left-collapse').click();
    const collapseSamples = await samplePositions(
      page,
      '[data-testid="next-left-open"]',
      '.top-title',
      400,
      20,
    );
    await collapseLeftPromise;

    // 断言标题 x 单调不增（从右向左移，允许 1px 抖动）
    for (let i = 1; i < collapseSamples.length; i++) {
      if (collapseSamples[i].tx != null && collapseSamples[i - 1].tx != null) {
        expect(collapseSamples[i].tx).toBeLessThanOrEqual(collapseSamples[i - 1].tx + 1);
      }
    }
    // 最终 next-left-open 的 x 在 12±2
    const finalLeftOpen = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="next-left-open"]');
      return el ? el.getBoundingClientRect().left : null;
    });
    expect(finalLeftOpen).toBeGreaterThanOrEqual(10);
    expect(finalLeftOpen).toBeLessThanOrEqual(14);

    // 2. Expand left panel
    const expandLeftPromise = page.getByTestId('next-left-open').click();
    const expandSamples = await samplePositions(
      page,
      '[data-testid="next-left-open"]',
      '.top-title',
      400,
      20,
    );
    await expandLeftPromise;

    // 断言标题 x 单调不减（从左向右移，允许 1px 抖动）
    for (let i = 1; i < expandSamples.length; i++) {
      if (expandSamples[i].tx != null && expandSamples[i - 1].tx != null) {
        expect(expandSamples[i].tx).toBeGreaterThanOrEqual(expandSamples[i - 1].tx - 1);
      }
    }
    // 结束后 next-left-collapse 可见
    await expect(page.getByTestId('next-left-collapse')).toBeVisible();

    // 3. Right panel collapse & expand
    await expect(page.getByTestId('next-right-collapse')).toBeVisible();
    await page.getByTestId('next-right-collapse').click();
    await expect(page.getByTestId('next-right-toggle')).toBeVisible();

    await page.getByTestId('next-right-toggle').click();
    await expect(page.getByTestId('next-right-collapse')).toBeVisible();
  } finally {
    await srv.kill();
  }
});
