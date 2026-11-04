import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 60_000 });

test('side toggle buttons have identical dimensions, mirror-symmetric insets, and green dot', async ({ page }) => {
  const state = await openProto(page);

  const leftBtn = page.locator('.side-toggle-left');
  const rightBtn = page.locator('.side-toggle-right');
  await expect(leftBtn).toBeVisible();
  await expect(rightBtn).toBeVisible();

  // 1. Both buttons boundingBox width and height are equal (30x30 CSS px)
  const leftBox = await leftBtn.boundingBox();
  const rightBox = await rightBtn.boundingBox();
  expect(leftBox).not.toBeNull();
  expect(rightBox).not.toBeNull();
  expect(Math.round(leftBox.width)).toBe(Math.round(rightBox.width));
  expect(Math.round(leftBox.height)).toBe(Math.round(rightBox.height));

  // 2. Icon vertical line inset is mirror-symmetric (3px each side)
  const leftInset = await page.evaluate(() => {
    const ico = document.querySelector('.side-toggle-left .ico-panel-left');
    return ico ? getComputedStyle(ico, '::after').left : null;
  });
  const rightInset = await page.evaluate(() => {
    const ico = document.querySelector('.side-toggle-right .ico-panel-right');
    return ico ? getComputedStyle(ico, '::after').right : null;
  });
  expect(leftInset).toBe('3px');
  expect(rightInset).toBe('3px');
  expect(leftInset).toBe(rightInset);

  // 3. Green dot is present on right toggle button
  const rightDot = rightBtn.locator('[data-testid="next-right-dot"]');
  await expect(rightDot).toBeAttached();

  expectClean(state);
});

test('left sidebar toggle transitions continuously with exactly one button visible, right toggle x stays constant', async ({ page }) => {
  const state = await openProto(page);

  const leftBtn = page.locator('.side-toggle-left');
  const rightBtn = page.locator('.side-toggle-right');
  await expect(leftBtn).toBeVisible();
  await expect(rightBtn).toBeVisible();

  // --- Left toggle: Collapse ---
  const collapseSamples = [];
  const startCollapse = Date.now();
  const collapsePromise = leftBtn.click();

  while (Date.now() - startCollapse < 280) {
    const visibleCount = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('.side-toggle-left, [data-testid="next-left-collapse"], [data-testid="next-left-open"]'),
      );
      return candidates.filter((el) => {
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      }).length;
    });
    const x = await leftBtn.evaluate((el) => el.getBoundingClientRect().left);
    collapseSamples.push({ visibleCount, x });
    await page.waitForTimeout(20);
  }
  await collapsePromise;

  // At every moment, exactly one left toggle button is visible (no crossfade or two buttons)
  for (const s of collapseSamples) {
    expect(s.visibleCount).toBe(1);
  }
  // Sampled >= 3 times
  expect(collapseSamples.length).toBeGreaterThanOrEqual(3);

  // x coordinate continuously decreases during collapse (monotonically non-increasing with 1px float margin)
  for (let i = 1; i < collapseSamples.length; i++) {
    expect(collapseSamples[i].x).toBeLessThanOrEqual(collapseSamples[i - 1].x + 1);
  }

  // Wait for collapse to finish settling at resting position (~10.8 visual px = 12 CSS px)
  await page.waitForTimeout(150);

  // --- Left toggle: Expand ---
  const expandSamples = [];
  const startExpand = Date.now();
  const expandPromise = leftBtn.click();

  while (Date.now() - startExpand < 280) {
    const visibleCount = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('.side-toggle-left, [data-testid="next-left-collapse"], [data-testid="next-left-open"]'),
      );
      return candidates.filter((el) => {
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      }).length;
    });
    const x = await leftBtn.evaluate((el) => el.getBoundingClientRect().left);
    expandSamples.push({ visibleCount, x });
    await page.waitForTimeout(20);
  }
  await expandPromise;

  for (const s of expandSamples) {
    expect(s.visibleCount).toBe(1);
  }
  expect(expandSamples.length).toBeGreaterThanOrEqual(3);

  // x coordinate continuously increases during expand (monotonically non-decreasing with 1px float margin)
  for (let i = 1; i < expandSamples.length; i++) {
    expect(expandSamples[i].x).toBeGreaterThanOrEqual(expandSamples[i - 1].x - 1);
  }

  // --- Right toggle: Stationary during collapse and expand ---
  const rightXInitial = await rightBtn.evaluate((el) => el.getBoundingClientRect().left);

  await rightBtn.click();
  await page.waitForTimeout(300);
  const rightXCollapsed = await rightBtn.evaluate((el) => el.getBoundingClientRect().left);
  expect(Math.abs(rightXCollapsed - rightXInitial)).toBeLessThanOrEqual(1);

  await rightBtn.click();
  await page.waitForTimeout(300);
  const rightXExpanded = await rightBtn.evaluate((el) => el.getBoundingClientRect().left);
  expect(Math.abs(rightXExpanded - rightXInitial)).toBeLessThanOrEqual(1);

  expectClean(state);
});

test('narrow screen overlay mode keeps both buttons visible and functional', async ({ page }) => {
  const state = await openProto(page);

  // Narrow viewport triggers overlay mode
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(100);

  const leftBtn = page.locator('.side-toggle-left');
  const rightBtn = page.locator('.side-toggle-right');

  // Both buttons remain visible and have higher z-index
  await expect(leftBtn).toBeVisible();
  await expect(rightBtn).toBeVisible();

  const leftZ = await leftBtn.evaluate((el) => Number.parseInt(getComputedStyle(el).zIndex, 10));
  const rightZ = await rightBtn.evaluate((el) => Number.parseInt(getComputedStyle(el).zIndex, 10));
  expect(leftZ).toBeGreaterThanOrEqual(40);
  expect(rightZ).toBeGreaterThanOrEqual(40);

  // Can open and close right pane in overlay mode
  await rightBtn.click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('next-right')).toBeVisible();
  await rightBtn.click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('next-right')).toBeHidden();

  // Can open and close left sidebar in overlay mode
  await leftBtn.click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('next-sidebar')).toBeVisible();
  await leftBtn.click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('next-sidebar')).toBeHidden();

  expectClean(state);
});

test('respects prefers-reduced-motion: reduce without animation lag', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await openProto(page);

  const leftBtn = page.locator('.side-toggle-left');
  await expect(leftBtn).toBeVisible();

  // Click collapse under reduced motion; transitionDuration should be 0s
  const duration = await leftBtn.evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(['0s', '0ms', ''].some((v) => duration === v || duration.startsWith('0s'))).toBe(true);

  await leftBtn.click();
  await page.waitForTimeout(30);
  const leftX = await leftBtn.evaluate((el) => el.getBoundingClientRect().left);
  // Reached target ~12px visual position immediately
  expect(leftX).toBeLessThan(50);

  expectClean(state);
});
