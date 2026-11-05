import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 60_000 });

function rectsIntersect(a, b) {
  if (!a || !b) return false;
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

test('side toggle buttons have identical dimensions, mirror-symmetric insets, equal edge distance, and green dot', async ({ page }) => {
  const state = await openProto(page);

  const leftBtn = page.locator('.side-toggle-left');
  const rightBtn = page.locator('.side-toggle-right');
  await expect(leftBtn).toBeVisible();
  await expect(rightBtn).toBeVisible();

  // 1. Both buttons boundingBox width and height are equal (30px CSS × 0.9 zoom = 27px visual)
  const leftBox = await leftBtn.boundingBox();
  const rightBox = await rightBtn.boundingBox();
  expect(leftBox).not.toBeNull();
  expect(rightBox).not.toBeNull();
  expect(Math.round(leftBox.width)).toBe(Math.round(rightBox.width));
  expect(Math.round(leftBox.height)).toBe(Math.round(rightBox.height));
  expect(Math.round(leftBox.width)).toBe(Math.round(30 * 0.9));
  expect(Math.round(leftBox.height)).toBe(Math.round(30 * 0.9));

  // Also assert computed CSS dimensions are exactly 30px × 30px
  const leftComputed = await leftBtn.evaluate((el) => {
    const s = getComputedStyle(el);
    return { width: s.width, height: s.height };
  });
  const rightComputed = await rightBtn.evaluate((el) => {
    const s = getComputedStyle(el);
    return { width: s.width, height: s.height };
  });
  expect(leftComputed.width).toBe('30px');
  expect(leftComputed.height).toBe('30px');
  expect(rightComputed.width).toBe('30px');
  expect(rightComputed.height).toBe('30px');

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

  // 4. Equal distance to window edges (12px CSS × 0.9 = 10.8 visual px each side)
  const leftDist = leftBox.x;
  const rightDist = 1440 - (rightBox.x + rightBox.width);
  expect(Math.abs(leftDist - rightDist)).toBeLessThanOrEqual(1);
  expect(Math.abs(leftDist - 12 * 0.9)).toBeLessThanOrEqual(1);

  const leftCssDist = await leftBtn.evaluate((el) => getComputedStyle(el).left);
  const rightCssDist = await rightBtn.evaluate((el) => getComputedStyle(el).right);
  expect(leftCssDist).toBe('12px');
  expect(rightCssDist).toBe('12px');

  // 5. In open state: "Weft" brand and title do not intersect the left toggle button
  const brand = page.locator('.sb-brand');
  await expect(brand).toBeVisible();
  const brandBox = await brand.boundingBox();
  expect(brandBox).not.toBeNull();
  expect(rectsIntersect(brandBox, leftBox)).toBe(false);
  expect(brandBox.x).toBeGreaterThanOrEqual(leftBox.x + leftBox.width);

  const title = page.locator('.top-title');
  if (await title.isVisible()) {
    const titleBox = await title.boundingBox();
    expect(titleBox).not.toBeNull();
    expect(rectsIntersect(titleBox, leftBox)).toBe(false);
    expect(titleBox.x).toBeGreaterThanOrEqual(leftBox.x + leftBox.width);
  }

  expectClean(state);
});

test('left button remains stationary and same DOM element in every frame during collapse and expand without intersecting title', async ({ page }) => {
  const state = await openProto(page);

  const leftBtn = page.locator('.side-toggle-left');
  await expect(leftBtn).toBeVisible();

  // Attach unique marker property to confirm same DOM element
  await page.evaluate(() => {
    const el = document.querySelector('.side-toggle-left');
    if (el) el.__marker = 'left-toggle-singleton';
  });

  const initialBox = await leftBtn.boundingBox();
  expect(initialBox).not.toBeNull();
  expect(Math.abs(initialBox.x - 12 * 0.9)).toBeLessThanOrEqual(1);

  // --- Left toggle: Collapse ---
  const collapseSamples = [];
  const startCollapse = Date.now();
  const collapsePromise = leftBtn.click();

  while (Date.now() - startCollapse < 280) {
    const sample = await page.evaluate(() => {
      const el = document.querySelector('.side-toggle-left');
      const titleEl = document.querySelector('.top-title');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const tr = titleEl ? titleEl.getBoundingClientRect() : null;
      return {
        isSameEl: el.__marker === 'left-toggle-singleton',
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
        title: tr ? { x: tr.left, y: tr.top, width: tr.width, height: tr.height } : null,
      };
    });
    if (sample) collapseSamples.push(sample);
    await page.waitForTimeout(20);
  }
  await collapsePromise;

  expect(collapseSamples.length).toBeGreaterThanOrEqual(3);
  for (const s of collapseSamples) {
    expect(s.isSameEl).toBe(true);
    expect(Math.abs(s.x - initialBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.y - initialBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.width - initialBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.height - initialBox.height)).toBeLessThanOrEqual(1);
    if (s.title && s.title.width > 0) {
      expect(rectsIntersect(s.title, s)).toBe(false);
      expect(s.title.x).toBeGreaterThanOrEqual(s.x + s.width - 1);
    }
  }

  // Settle in collapsed state
  await page.waitForTimeout(100);
  const collapsedBox = await leftBtn.boundingBox();
  expect(collapsedBox).not.toBeNull();
  expect(Math.abs(collapsedBox.x - initialBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(collapsedBox.y - initialBox.y)).toBeLessThanOrEqual(1);

  // In collapsed state, title must not intersect the left button
  const titleAfterCollapse = page.locator('.top-title');
  if (await titleAfterCollapse.isVisible()) {
    const tBox = await titleAfterCollapse.boundingBox();
    expect(tBox).not.toBeNull();
    expect(rectsIntersect(tBox, collapsedBox)).toBe(false);
    expect(tBox.x).toBeGreaterThanOrEqual(collapsedBox.x + collapsedBox.width);
  }

  // --- Left toggle: Expand ---
  const expandSamples = [];
  const startExpand = Date.now();
  const expandPromise = leftBtn.click();

  while (Date.now() - startExpand < 280) {
    const sample = await page.evaluate(() => {
      const el = document.querySelector('.side-toggle-left');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        isSameEl: el.__marker === 'left-toggle-singleton',
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      };
    });
    if (sample) expandSamples.push(sample);
    await page.waitForTimeout(20);
  }
  await expandPromise;

  expect(expandSamples.length).toBeGreaterThanOrEqual(3);
  for (const s of expandSamples) {
    expect(s.isSameEl).toBe(true);
    expect(Math.abs(s.x - initialBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.y - initialBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.width - initialBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.height - initialBox.height)).toBeLessThanOrEqual(1);
  }

  // Settle in expanded state
  await page.waitForTimeout(100);
  const expandedBox = await leftBtn.boundingBox();
  expect(expandedBox).not.toBeNull();
  expect(Math.abs(expandedBox.x - initialBox.x)).toBeLessThanOrEqual(1);

  // Weft brand must not intersect left button
  const brandAfterExpand = page.locator('.sb-brand');
  await expect(brandAfterExpand).toBeVisible();
  const bBox = await brandAfterExpand.boundingBox();
  expect(bBox).not.toBeNull();
  expect(rectsIntersect(bBox, expandedBox)).toBe(false);
  expect(bBox.x).toBeGreaterThanOrEqual(expandedBox.x + expandedBox.width);

  expectClean(state);
});

test('right button remains stationary and same DOM element in every frame during collapse and expand', async ({ page }) => {
  const state = await openProto(page);

  const rightBtn = page.locator('.side-toggle-right');
  await expect(rightBtn).toBeVisible();

  // Attach unique marker property to confirm same DOM element
  await page.evaluate(() => {
    const el = document.querySelector('.side-toggle-right');
    if (el) el.__marker = 'right-toggle-singleton';
  });

  const initialBox = await rightBtn.boundingBox();
  expect(initialBox).not.toBeNull();
  expect(Math.abs(1440 - (initialBox.x + initialBox.width) - 12 * 0.9)).toBeLessThanOrEqual(1);

  // --- Right toggle: Collapse ---
  const collapseSamples = [];
  const startCollapse = Date.now();
  const collapsePromise = rightBtn.click();

  while (Date.now() - startCollapse < 280) {
    const sample = await page.evaluate(() => {
      const el = document.querySelector('.side-toggle-right');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        isSameEl: el.__marker === 'right-toggle-singleton',
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      };
    });
    if (sample) collapseSamples.push(sample);
    await page.waitForTimeout(20);
  }
  await collapsePromise;

  expect(collapseSamples.length).toBeGreaterThanOrEqual(3);
  for (const s of collapseSamples) {
    expect(s.isSameEl).toBe(true);
    expect(Math.abs(s.x - initialBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.y - initialBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.width - initialBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.height - initialBox.height)).toBeLessThanOrEqual(1);
  }

  await page.waitForTimeout(100);

  // --- Right toggle: Expand ---
  const expandSamples = [];
  const startExpand = Date.now();
  const expandPromise = rightBtn.click();

  while (Date.now() - startExpand < 280) {
    const sample = await page.evaluate(() => {
      const el = document.querySelector('.side-toggle-right');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        isSameEl: el.__marker === 'right-toggle-singleton',
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      };
    });
    if (sample) expandSamples.push(sample);
    await page.waitForTimeout(20);
  }
  await expandPromise;

  expect(expandSamples.length).toBeGreaterThanOrEqual(3);
  for (const s of expandSamples) {
    expect(s.isSameEl).toBe(true);
    expect(Math.abs(s.x - initialBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.y - initialBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.width - initialBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.height - initialBox.height)).toBeLessThanOrEqual(1);
  }

  expectClean(state);
});

test('dragging left sidebar width does not move left or right buttons', async ({ page }) => {
  const state = await openProto(page);

  const leftBtn = page.locator('.side-toggle-left');
  const rightBtn = page.locator('.side-toggle-right');
  const leftBoxBefore = await leftBtn.boundingBox();
  const rightBoxBefore = await rightBtn.boundingBox();

  const divider = page.locator('.col-divider[data-side="left"]');
  await expect(divider).toBeVisible();
  const divBox = await divider.boundingBox();
  expect(divBox).not.toBeNull();

  // Drag divider +60px to the right
  await page.mouse.move(divBox.x + divBox.width / 2, divBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(divBox.x + divBox.width / 2 + 60, divBox.y + 100, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(50);

  const leftBoxAfter = await leftBtn.boundingBox();
  const rightBoxAfter = await rightBtn.boundingBox();

  expect(Math.abs(leftBoxAfter.x - leftBoxBefore.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(leftBoxAfter.y - leftBoxBefore.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(rightBoxAfter.x - rightBoxBefore.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(rightBoxAfter.y - rightBoxBefore.y)).toBeLessThanOrEqual(1);

  expectClean(state);
});

test('774px viewport collapses overlay sidebar without horizontal scroll or button overlap', async ({ page }) => {
  const state = await openProto(page);

  await page.setViewportSize({ width: 774, height: 800 });
  await page.waitForTimeout(100);

  const leftBtn = page.locator('.side-toggle-left');
  const rightBtn = page.locator('.side-toggle-right');
  await expect(leftBtn).toBeVisible();
  await expect(rightBtn).toBeVisible();

  // 1. No horizontal scroll
  const scrollInfo = await page.evaluate(() => ({
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.body.clientWidth,
    htmlScroll: document.documentElement.scrollWidth,
    htmlClient: document.documentElement.clientWidth,
  }));
  expect(scrollInfo.scrollWidth).toBeLessThanOrEqual(scrollInfo.clientWidth + 1);
  expect(scrollInfo.htmlScroll).toBeLessThanOrEqual(scrollInfo.htmlClient + 1);

  // 2. Buttons z-index >= 40
  const leftZ = await leftBtn.evaluate((el) => Number.parseInt(getComputedStyle(el).zIndex, 10));
  const rightZ = await rightBtn.evaluate((el) => Number.parseInt(getComputedStyle(el).zIndex, 10));
  expect(leftZ).toBeGreaterThanOrEqual(40);
  expect(rightZ).toBeGreaterThanOrEqual(40);

  // 3. Left button does not overlap top-title in collapsed state
  const leftBox = await leftBtn.boundingBox();
  const title = page.locator('.top-title');
  if (await title.isVisible()) {
    const titleBox = await title.boundingBox();
    expect(rectsIntersect(titleBox, leftBox)).toBe(false);
    expect(titleBox.x).toBeGreaterThanOrEqual(leftBox.x + leftBox.width);
  }

  // 4. Open overlay sidebar: "Weft" does not overlap left button
  await leftBtn.click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('next-sidebar')).toBeVisible();

  const brand = page.locator('.sb-brand');
  await expect(brand).toBeVisible();
  const brandBox = await brand.boundingBox();
  expect(rectsIntersect(brandBox, leftBox)).toBe(false);
  expect(brandBox.x).toBeGreaterThanOrEqual(leftBox.x + leftBox.width);

  // Still no horizontal scroll with overlay open
  const openScroll = await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth + 1);
  expect(openScroll).toBe(true);

  // Close overlay sidebar
  await leftBtn.click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('next-sidebar')).toBeHidden();

  // Open and close right overlay
  await rightBtn.click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('next-right')).toBeVisible();
  await rightBtn.click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('next-right')).toBeHidden();

  expectClean(state);
});

test('respects prefers-reduced-motion: reduce without animation lag', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await openProto(page);

  const leftBtn = page.locator('.side-toggle-left');
  await expect(leftBtn).toBeVisible();

  const boxBefore = await leftBtn.boundingBox();
  await leftBtn.click();
  await page.waitForTimeout(30);

  const boxAfter = await leftBtn.boundingBox();
  expect(Math.abs(boxAfter.x - boxBefore.x)).toBeLessThanOrEqual(1);

  expectClean(state);
});
