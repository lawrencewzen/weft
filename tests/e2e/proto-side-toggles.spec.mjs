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

test('collapsed sidebar becomes 54px narrow strip, buttons and icons remain stationary across every frame', async ({ page }) => {
  const state = await openProto(page);

  const sidebar = page.getByTestId('next-sidebar');
  const leftBtn = page.locator('.side-toggle-left');
  await expect(sidebar).toBeVisible();
  await expect(leftBtn).toBeVisible();

  // Attach unique marker properties to confirm exact same DOM elements are reused
  await page.evaluate(() => {
    const lb = document.querySelector('.side-toggle-left');
    const nc = document.querySelector('[data-testid="next-new-chat"]');
    const sc = document.querySelector('[data-testid="next-search"]');
    const st = document.querySelector('[data-testid="next-open-settings"]');
    if (lb) lb.__marker = 'left-toggle-singleton';
    if (nc) nc.__marker = 'new-chat-singleton';
    if (sc) sc.__marker = 'search-singleton';
    if (st) st.__marker = 'settings-singleton';
  });

  const initialLeftBox = await leftBtn.boundingBox();
  expect(initialLeftBox).not.toBeNull();

  // Record initial icon positions
  const initialIconPositions = await page.evaluate(() => {
    const getIconLeft = (sel) => {
      const el = document.querySelector(sel);
      const ico = el ? el.querySelector('.sb-ic') : null;
      return ico ? ico.getBoundingClientRect().left : null;
    };
    return {
      newChat: getIconLeft('[data-testid="next-new-chat"]'),
      search: getIconLeft('[data-testid="next-search"]'),
      settings: getIconLeft('[data-testid="next-open-settings"]'),
    };
  });
  expect(initialIconPositions.newChat).not.toBeNull();
  expect(initialIconPositions.search).not.toBeNull();
  expect(initialIconPositions.settings).not.toBeNull();

  // --- Left toggle: Collapse ---
  const collapseSamples = [];
  const startCollapse = Date.now();
  const collapsePromise = leftBtn.click();

  while (Date.now() - startCollapse < 280) {
    const sample = await page.evaluate(() => {
      const lb = document.querySelector('.side-toggle-left');
      const nc = document.querySelector('[data-testid="next-new-chat"]');
      const sc = document.querySelector('[data-testid="next-search"]');
      const st = document.querySelector('[data-testid="next-open-settings"]');
      const titleEl = document.querySelector('.top-title');
      const sb = document.querySelector('[data-testid="next-sidebar"]');
      if (!lb || !nc || !sc || !st || !sb) return null;

      const getIconLeft = (el) => el.querySelector('.sb-ic')?.getBoundingClientRect().left;
      const r = lb.getBoundingClientRect();
      const tr = titleEl ? titleEl.getBoundingClientRect() : null;
      return {
        isLbSame: lb.__marker === 'left-toggle-singleton',
        isNcSame: nc.__marker === 'new-chat-singleton',
        isScSame: sc.__marker === 'search-singleton',
        isStSame: st.__marker === 'settings-singleton',
        lbX: r.left,
        lbY: r.top,
        lbW: r.width,
        lbH: r.height,
        ncX: getIconLeft(nc),
        scX: getIconLeft(sc),
        stX: getIconLeft(st),
        title: tr ? { x: tr.left, y: tr.top, width: tr.width, height: tr.height } : null,
      };
    });
    if (sample) collapseSamples.push(sample);
    await page.waitForTimeout(20);
  }
  await collapsePromise;

  expect(collapseSamples.length).toBeGreaterThanOrEqual(3);
  for (const s of collapseSamples) {
    expect(s.isLbSame).toBe(true);
    expect(s.isNcSame).toBe(true);
    expect(s.isScSame).toBe(true);
    expect(s.isStSame).toBe(true);
    // Left button stationary
    expect(Math.abs(s.lbX - initialLeftBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.lbY - initialLeftBox.y)).toBeLessThanOrEqual(1);
    // Icons x position constant in every frame
    expect(Math.abs(s.ncX - initialIconPositions.newChat)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.scX - initialIconPositions.search)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.stX - initialIconPositions.settings)).toBeLessThanOrEqual(1);
    // Title never enters left button area
    if (s.title && s.title.width > 0) {
      expect(rectsIntersect(s.title, { x: s.lbX, y: s.lbY, width: s.lbW, height: s.lbH })).toBe(false);
    }
  }

  // Settle in collapsed state
  await page.waitForTimeout(100);

  // 1. Sidebar is visible as a 54px narrow strip (visual width ~48.6px)
  await expect(sidebar).toBeVisible();
  const collapsedSbBox = await sidebar.boundingBox();
  expect(collapsedSbBox).not.toBeNull();
  expect(Math.abs(collapsedSbBox.width - 54 * 0.9)).toBeLessThanOrEqual(1.5);
  const cssWidth = await sidebar.evaluate((el) => getComputedStyle(el).width);
  expect(Math.round(Number.parseFloat(cssWidth))).toBe(54);

  // 2. Buttons and icons remain stationary and centered
  const collapsedLeftBox = await leftBtn.boundingBox();
  expect(Math.abs(collapsedLeftBox.x - initialLeftBox.x)).toBeLessThanOrEqual(1);

  // 3. Projects toggle button is visible in collapsed strip
  const stripProjects = page.getByTestId('next-strip-projects');
  await expect(stripProjects).toBeVisible();

  // --- Left toggle: Expand ---
  const expandSamples = [];
  const startExpand = Date.now();
  const expandPromise = leftBtn.click();

  while (Date.now() - startExpand < 280) {
    const sample = await page.evaluate(() => {
      const lb = document.querySelector('.side-toggle-left');
      const nc = document.querySelector('[data-testid="next-new-chat"]');
      const sc = document.querySelector('[data-testid="next-search"]');
      const st = document.querySelector('[data-testid="next-open-settings"]');
      if (!lb || !nc || !sc || !st) return null;
      const getIconLeft = (el) => el.querySelector('.sb-ic')?.getBoundingClientRect().left;
      return {
        isLbSame: lb.__marker === 'left-toggle-singleton',
        isNcSame: nc.__marker === 'new-chat-singleton',
        isScSame: sc.__marker === 'search-singleton',
        isStSame: st.__marker === 'settings-singleton',
        lbX: lb.getBoundingClientRect().left,
        ncX: getIconLeft(nc),
        scX: getIconLeft(sc),
        stX: getIconLeft(st),
      };
    });
    if (sample) expandSamples.push(sample);
    await page.waitForTimeout(20);
  }
  await expandPromise;

  expect(expandSamples.length).toBeGreaterThanOrEqual(3);
  for (const s of expandSamples) {
    expect(s.isLbSame).toBe(true);
    expect(s.isNcSame).toBe(true);
    expect(s.isScSame).toBe(true);
    expect(s.isStSame).toBe(true);
    expect(Math.abs(s.lbX - initialLeftBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.ncX - initialIconPositions.newChat)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.scX - initialIconPositions.search)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.stX - initialIconPositions.settings)).toBeLessThanOrEqual(1);
  }

  // Settle in expanded state
  await page.waitForTimeout(100);
  const expandedSbBox = await sidebar.boundingBox();
  expect(expandedSbBox.width).toBeGreaterThan(150);

  expectClean(state);
});

test('right button remains stationary and same DOM element in every frame during collapse and expand', async ({ page }) => {
  const state = await openProto(page);

  const rightBtn = page.locator('.side-toggle-right');
  await expect(rightBtn).toBeVisible();

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

test('narrow strip icon actions: search expands and focuses input, new chat creates, project icon expands', async ({ page }) => {
  const state = await openProto(page);

  const leftBtn = page.locator('.side-toggle-left');
  const sidebar = page.getByTestId('next-sidebar');

  // Collapse sidebar to narrow strip
  await leftBtn.click();
  await page.waitForTimeout(300);
  const sbBox = await sidebar.boundingBox();
  expect(Math.abs(sbBox.width - 54 * 0.9)).toBeLessThanOrEqual(1.5);

  // 1. Clicking search in narrow strip expands left bar and focuses search input
  await page.getByTestId('next-search').click();
  const searchModal = page.getByTestId('next-search-modal');
  await expect(searchModal).toBeVisible();
  const searchInput = page.getByTestId('next-search-input');
  await expect(searchInput).toBeFocused();

  // Close search modal
  await page.keyboard.press('Escape');
  await expect(searchModal).toBeHidden();

  // Sidebar expanded after clicking search
  await expect(page.locator('.next-shell')).not.toHaveClass(/left-closed/);
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeGreaterThan(150);

  // 2. Collapse again and click new chat
  await page.getByTestId('next-left-collapse').click();
  await page.waitForTimeout(300);
  await page.getByTestId('next-new-chat').click();
  // Navigates to draft/new chat
  await expect(page).toHaveURL(/(\/w\/[^/]+\/new|\/new)$/);

  // 3. While still collapsed in narrow strip, click projects toggle
  const stripProjects = page.getByTestId('next-strip-projects');
  await expect(stripProjects).toBeVisible();
  await stripProjects.click();
  await page.waitForTimeout(300);

  // Sidebar expanded after clicking project icon
  await expect(page.locator('.next-shell')).not.toHaveClass(/left-closed/);
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeGreaterThan(150);

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

test('774px viewport collapses to 54px narrow strip without horizontal scroll', async ({ page }) => {
  const state = await openProto(page);

  await page.setViewportSize({ width: 774, height: 800 });
  await page.waitForTimeout(100);

  const leftBtn = page.locator('.side-toggle-left');
  const rightBtn = page.locator('.side-toggle-right');
  const sidebar = page.getByTestId('next-sidebar');
  await expect(leftBtn).toBeVisible();
  await expect(rightBtn).toBeVisible();
  await expect(sidebar).toBeVisible();

  // 1. Auto-collapsed to 54px strip (~48.6 visual px)
  const sbBox = await sidebar.boundingBox();
  expect(Math.abs(sbBox.width - 54 * 0.9)).toBeLessThanOrEqual(1.5);

  // 2. No horizontal scroll
  const scrollInfo = await page.evaluate(() => ({
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.body.clientWidth,
    htmlScroll: document.documentElement.scrollWidth,
    htmlClient: document.documentElement.clientWidth,
  }));
  expect(scrollInfo.scrollWidth).toBeLessThanOrEqual(scrollInfo.clientWidth + 1);
  expect(scrollInfo.htmlScroll).toBeLessThanOrEqual(scrollInfo.htmlClient + 1);

  // 3. Buttons z-index >= 40
  const leftZ = await leftBtn.evaluate((el) => Number.parseInt(getComputedStyle(el).zIndex, 10));
  const rightZ = await rightBtn.evaluate((el) => Number.parseInt(getComputedStyle(el).zIndex, 10));
  expect(leftZ).toBeGreaterThanOrEqual(40);
  expect(rightZ).toBeGreaterThanOrEqual(40);

  // 4. Open overlay sidebar: expands over CenterPane
  await leftBtn.click();
  await page.waitForTimeout(300);
  const openBox = await sidebar.boundingBox();
  expect(openBox.width).toBeGreaterThan(150);

  // Still no horizontal scroll with overlay open
  const openScroll = await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth + 1);
  expect(openScroll).toBe(true);

  // Close back to narrow strip
  await leftBtn.click();
  await page.waitForTimeout(300);
  const closedBox = await sidebar.boundingBox();
  expect(Math.abs(closedBox.width - 54 * 0.9)).toBeLessThanOrEqual(1.5);

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

  const sidebar = page.getByTestId('next-sidebar');
  const sbBox = await sidebar.boundingBox();
  expect(Math.abs(sbBox.width - 54 * 0.9)).toBeLessThanOrEqual(1.5);

  expectClean(state);
});
