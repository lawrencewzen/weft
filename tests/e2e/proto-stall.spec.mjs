import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('c-site-1 shows stall strip with tool summary, clicking stop dismisses strip and readies composer', async ({ page }) => {
  const state = await openProto(page);

  // 1. Visit c-site-1: expand website workspace if needed, then open c-site-1
  const websiteNode = page.locator('[data-testid=next-ws-node][data-id="ws-website"]');
  if (await websiteNode.locator('.sb-conv-list').isHidden()) {
    await websiteNode.getByTestId('next-ws-toggle').click();
  }
  await page.locator('[data-testid=next-conv-row][data-id="c-site-1"]').click();
  await expect(page).toHaveURL(/#\/c\/c-site-1$/);

  const strip = page.getByTestId('next-stall-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('已 4 分钟没有动静');

  const tool = page.getByTestId('next-stall-tool');
  await expect(tool).toBeVisible();
  await expect(tool).toContainText('正在运行');
  await expect(tool.locator('code')).toHaveText('npm run build -- --watch');

  const stopBtn = page.getByTestId('next-stall-stop');
  await expect(stopBtn).toBeVisible();
  await expect(stopBtn).toHaveText('停止');

  // 2. Click stop: strip disappears, composer returns to sendable
  await stopBtn.click();
  await expect(strip).toHaveCount(0);

  const input = page.getByTestId('next-composer-input');
  await expect(input).toBeEnabled();
  await expect(page.getByTestId('next-send')).toBeVisible();

  await expectClean(state);
});

test('c-rich has no stall strip', async ({ page }) => {
  const state = await openProto(page);
  await page.locator('[data-testid=next-conv-row][data-id="c-rich"]').click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);

  // c-rich has subagent strip but NO stall strip
  await expect(page.getByTestId('next-stall-strip')).toHaveCount(0);
  await expect(page.getByTestId('next-agents-strip')).toBeVisible();

  await expectClean(state);
});

test('stall strip and agents strip stack correctly without inner border-radius when both present', async ({ page }) => {
  const state = await openProto(page);
  const websiteNode = page.locator('[data-testid=next-ws-node][data-id="ws-website"]');
  if (await websiteNode.locator('.sb-conv-list').isHidden()) {
    await websiteNode.getByTestId('next-ws-toggle').click();
  }
  await page.locator('[data-testid=next-conv-row][data-id="c-site-1"]').click();
  await expect(page).toHaveURL(/#\/c\/c-site-1$/);

  // c-site-1 seed is stalled and has an unended subagent; no mock flow auto-advances.
  const stallStrip = page.getByTestId('next-stall-strip');
  const agentsStrip = page.getByTestId('next-agents-strip');
  await expect(stallStrip).toBeVisible();
  await expect(agentsStrip).toBeVisible();

  // Check DOM order: stallStrip comes immediately before agentsStrip
  const isImmediatelyBefore = await page.evaluate(() => {
    const stall = document.querySelector('[data-testid="next-stall-strip"]');
    const agents = document.querySelector('[data-testid="next-agents-strip"]');
    return stall && agents && stall.nextElementSibling === agents;
  });
  expect(isImmediatelyBefore).toBe(true);

  // Check border-radius: .stall-strip + .agents-strip has 0 border-radius
  const agentsRadius = await page.evaluate(() => {
    const agents = document.querySelector('[data-testid="next-agents-strip"]');
    if (!agents) return '';
    const style = window.getComputedStyle(agents);
    return `${style.borderTopLeftRadius} ${style.borderTopRightRadius}`;
  });
  expect(agentsRadius).toBe('0px 0px');

  // Stall strip preserves rounded top corners
  const stallRadius = await page.evaluate(() => {
    const stall = document.querySelector('[data-testid="next-stall-strip"]');
    if (!stall) return '';
    const style = window.getComputedStyle(stall);
    return `${style.borderTopLeftRadius} ${style.borderTopRightRadius}`;
  });
  expect(stallRadius).toBe('12px 12px');

  await expectClean(state);
});

test('new activity in stalled conversation dismisses the stall strip', async ({ page }) => {
  const state = await openProto(page);
  const websiteNode = page.locator('[data-testid=next-ws-node][data-id="ws-website"]');
  if (await websiteNode.locator('.sb-conv-list').isHidden()) {
    await websiteNode.getByTestId('next-ws-toggle').click();
  }
  await page.locator('[data-testid=next-conv-row][data-id="c-site-1"]').click();
  await expect(page).toHaveURL(/#\/c\/c-site-1$/);

  const strip = page.getByTestId('next-stall-strip');
  await expect(strip).toBeVisible();

  // Send a message into the stalled conversation
  const input = page.getByTestId('next-composer-input');
  await input.fill('继续更新文案');
  await page.getByTestId('next-send').click();

  // New activity dismisses stall strip
  await expect(strip).toHaveCount(0, { timeout: 10_000 });
  await expectClean(state);
});
