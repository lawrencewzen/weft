import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
test.describe.configure({ timeout: 120_000 });

function expectedChatWidth(centerCssPx) {
  return Math.min(centerCssPx - 32, Math.max(420, Math.min(centerCssPx * 0.55, 760)));
}

async function measureRoot(page) {
  return page.evaluate(() => {
    const app = document.querySelector('[data-testid="next-app"]');
    const r = app?.getBoundingClientRect();
    const se = document.scrollingElement || document.documentElement;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:100px;pointer-events:none;';
    document.body.appendChild(probe);
    const pr = probe.getBoundingClientRect();
    probe.remove();
    const body = document.querySelector('[data-testid="next-item-assistant"] .msg-body');
    const fs = body ? parseFloat(getComputedStyle(body).fontSize) : NaN;
    return {
      x: r?.x ?? 0,
      y: r?.y ?? 0,
      w: r?.width ?? 0,
      h: r?.height ?? 0,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      scrollW: se.scrollWidth,
      scrollH: se.scrollHeight,
      probeW: pr.width,
      probeH: pr.height,
      fontSize: fs,
      zoom: getComputedStyle(document.documentElement).zoom,
      uiZoom: getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom').trim(),
    };
  });
}

async function measureChatAt(page, centerCssPx) {
  return page.evaluate((w) => {
    const center = document.querySelector('.col-center');
    const inner = document.querySelector('.thread-inner');
    const stack = document.querySelector('.composer-stack');
    if (!center || !inner || !stack) {
      return { center: 0, inner: 0, stack: 0 };
    }
    const prevWidth = center.style.width;
    const prevFlex = center.style.flex;
    center.style.width = `${w}px`;
    center.style.flex = 'none';
    void center.offsetWidth;
    const read = (el) => Number.parseFloat(getComputedStyle(el).width);
    const result = {
      center: center.offsetWidth,
      inner: read(inner),
      stack: read(stack),
    };
    center.style.width = prevWidth;
    center.style.flex = prevFlex;
    return result;
  }, centerCssPx);
}

test('default UI zoom fills the viewport and scales visual size to 0.9', async ({ page }) => {
  const state = await openProto(page);

  for (const vp of [
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(vp);
    const box = await measureRoot(page);
    expect(box.uiZoom, `${vp.width}×${vp.height} --ui-zoom`).toBe('0.9');
    expect(Math.abs(box.w - vp.width), `${vp.width}×${vp.height} width`).toBeLessThanOrEqual(2);
    expect(Math.abs(box.h - vp.height), `${vp.width}×${vp.height} height`).toBeLessThanOrEqual(2);
    expect(Math.abs(box.x), `${vp.width}×${vp.height} x`).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y), `${vp.width}×${vp.height} y`).toBeLessThanOrEqual(2);
    expect(box.scrollW, `${vp.width}×${vp.height} scrollWidth`).toBeLessThanOrEqual(vp.width + 2);
    expect(box.scrollH, `${vp.width}×${vp.height} scrollHeight`).toBeLessThanOrEqual(vp.height + 2);
    expect(box.probeW, `${vp.width}×${vp.height} 100css→visual`).toBeCloseTo(90, 0);
    expect(box.probeH, `${vp.width}×${vp.height} 100css→visual h`).toBeCloseTo(90, 0);
    expect(box.fontSize, `${vp.width}×${vp.height} body font-size`).toBeCloseTo(14.5, 1);
  }

  expectClean(state);
});

test('sidebar click menu and model menu (with submenu) stick to their triggers', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openProto(page);

  const richRow = page.locator('[data-testid=next-conv-row][data-id="c-rich"]');
  await expect(richRow).toBeVisible();
  await richRow.hover();
  const moreBtn = richRow.getByTestId('next-conv-more');
  await expect(moreBtn).toBeVisible();
  await moreBtn.click();
  const ctx = page.getByTestId('next-ctx-menu');
  await expect(ctx).toBeVisible();
  const moreBox = await moreBtn.boundingBox();
  const ctxBox = await ctx.boundingBox();
  expect(moreBox).toBeTruthy();
  expect(ctxBox).toBeTruthy();
  expect(Math.abs(ctxBox.x - moreBox.x), 'ctx menu left vs trigger').toBeLessThanOrEqual(2);
  expect(Math.abs(ctxBox.y - (moreBox.y + moreBox.height + 4)), 'ctx menu top vs trigger bottom').toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect(ctx).toHaveCount(0);

  const chip = page.getByTestId('next-model-chip');
  await chip.click();
  const menu = page.getByTestId('next-model-menu');
  await expect(menu).toBeVisible();
  const chipBox = await chip.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(chipBox).toBeTruthy();
  expect(menuBox).toBeTruthy();
  expect(Math.abs(menuBox.x - chipBox.x), 'model menu left vs chip').toBeLessThanOrEqual(2);
  expect(menuBox.y + menuBox.height, 'model menu sits above chip').toBeLessThanOrEqual(chipBox.y + 2);

  const modelRow = page.getByTestId('next-menu-model');
  await modelRow.hover();
  const sub = page.getByTestId('next-sub-models');
  await expect(sub).toBeVisible();
  const subBox = await sub.boundingBox();
  const menuBox2 = await menu.boundingBox();
  expect(subBox).toBeTruthy();
  expect(menuBox2).toBeTruthy();
  expect(
    Math.abs(subBox.x - (menuBox2.x + menuBox2.width + 8 * 0.9)),
    'submenu left vs primary menu right + 8css',
  ).toBeLessThanOrEqual(2);

  expectClean(state);
});

test('thread and composer width follow 55% of the center pane with 420–760 clamps', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openProto(page);
  await expect(page.locator('.thread-inner')).toBeVisible();
  await expect(page.locator('.composer-stack')).toBeVisible();

  const cases = [
    { center: 1000, chat: 550 },
    { center: 600, chat: 420 },
    { center: 400, chat: 368 },
    { center: 1600, chat: 760 },
  ];
  for (const row of cases) {
    expect(expectedChatWidth(row.center)).toBeCloseTo(row.chat, 5);
    const measured = await measureChatAt(page, row.center);
    expect(measured.inner, `thread-inner at ${row.center}px center`).toBeCloseTo(row.chat, 1);
    expect(measured.stack, `composer-stack at ${row.center}px center`).toBeCloseTo(row.chat, 1);
  }

  await page.getByTestId('next-right-collapse').click();
  await expect(page.locator('.next-shell')).toHaveClass(/right-closed/);
  const live = await page.evaluate(() => {
    const center = document.querySelector('.col-center');
    const inner = document.querySelector('.thread-inner');
    const stack = document.querySelector('.composer-stack');
    const read = (el) => Number.parseFloat(getComputedStyle(el).width);
    return {
      center: center?.offsetWidth ?? 0,
      inner: inner ? read(inner) : 0,
      stack: stack ? read(stack) : 0,
    };
  });
  expect(live.inner).toBeCloseTo(expectedChatWidth(live.center), 1);
  expect(live.stack).toBeCloseTo(live.inner, 1);

  expectClean(state);
});
