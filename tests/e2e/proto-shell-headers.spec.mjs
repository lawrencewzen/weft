import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 60_000 });

function overlaps(a, b) {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

async function box(locator) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b;
}

const centerY = (b) => b.y + b.height / 2;

async function setRight(page, open) {
  const toggle = page.getByTestId(open ? 'next-right-collapse' : 'next-right-toggle');
  if (await toggle.count() === 0) {
    await page.locator('.side-toggle-right').click();
  }
  const isOpen = (await page.getByTestId('next-right-collapse').count()) > 0;
  if (isOpen !== open) await page.locator('.side-toggle-right').click();
  await page.waitForTimeout(400);
}

test('schedules page under ?shell=1: new button, toggle, and window buttons do not overlap (with tasks, right open/closed)', async ({ page }) => {
  const state = await openProto(page, '?shell=1');
  await page.getByTestId('next-schedules').click();
  await expect(page).toHaveURL(/#\/schedules$/);

  const controls = page.getByTestId('window-controls');
  await expect(controls).toBeVisible();
  const newBtn = page.getByTestId('next-schedules-new');
  await expect(newBtn).toBeVisible();

  // Desktop width (side-by-side right pane): both open and closed
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const open of [false, true]) {
    await setRight(page, open);
    const cb = await box(controls);
    const nb = await box(newBtn);
    const tb = await box(page.locator('.side-toggle-right'));

    expect(overlaps(cb, nb), `1440w open=${open}: new button vs controls`).toBe(false);
    expect(overlaps(cb, tb), `1440w open=${open}: toggle vs controls`).toBe(false);
    expect(overlaps(tb, nb), `1440w open=${open}: new button vs toggle`).toBe(false);

    if (!open) {
      expect(nb.x + nb.width, '1440w closed: new button left of toggle').toBeLessThanOrEqual(tb.x);
      expect(tb.x + tb.width, '1440w closed: toggle left of controls').toBeLessThanOrEqual(cb.x);
    }
  }

  // Responsive widths (1000px, 700px): right closed reveals schedules header; right open is an overlay drawer
  for (const width of [1000, 700]) {
    await page.setViewportSize({ width, height: 900 });
    for (const open of [false, true]) {
      await setRight(page, open);
      const cb = await box(controls);
      const tb = await box(page.locator('.side-toggle-right'));
      expect(overlaps(cb, tb), `w=${width} open=${open}: toggle vs controls`).toBe(false);

      if (!open) {
        const nb = await box(newBtn);
        expect(overlaps(cb, nb), `w=${width} closed: new button vs controls`).toBe(false);
        expect(overlaps(tb, nb), `w=${width} closed: new button vs toggle`).toBe(false);
        expect(nb.x + nb.width, `w=${width} closed: new button left of toggle`).toBeLessThanOrEqual(tb.x);
        expect(tb.x + tb.width, `w=${width} closed: toggle left of controls`).toBeLessThanOrEqual(cb.x);
      } else {
        for (const btn of await page.locator('.right-tabs-bar button').all()) {
          if (!(await btn.isVisible())) continue;
          expect(overlaps(cb, await box(btn)), `w=${width} open: tab button vs controls`).toBe(false);
        }
      }
    }
  }

  expectClean(state);
});

test('schedules page under ?shell=1: buttons do not overlap when schedules list is empty (right open/closed)', async ({ page }) => {
  const state = await openProto(page, '?shell=1');
  await page.getByTestId('next-schedules').click();
  await expect(page).toHaveURL(/#\/schedules$/);

  // Clear all schedules in mock db
  await page.evaluate(async () => {
    const res = await fetch('/api/v2/schedules');
    const { schedules } = await res.json();
    for (const s of schedules) {
      await fetch(`/api/v2/schedules/${s.id}`, { method: 'DELETE' });
    }
  });

  await expect(page.getByTestId('next-schedules-empty')).toBeVisible();

  const controls = page.getByTestId('window-controls');
  const newBtn = page.getByTestId('next-schedules-new');
  await expect(newBtn).toBeVisible();

  for (const open of [false, true]) {
    await setRight(page, open);
    const cb = await box(controls);
    const nb = await box(newBtn);
    const tb = await box(page.locator('.side-toggle-right'));

    expect(overlaps(cb, nb), `empty list: new button vs controls (right open=${open})`).toBe(false);
    expect(overlaps(cb, tb), `empty list: toggle vs controls (right open=${open})`).toBe(false);
    expect(overlaps(tb, nb), `empty list: new button vs toggle (right open=${open})`).toBe(false);

    if (!open) {
      expect(nb.x + nb.width, 'empty list closed: new button left of toggle').toBeLessThanOrEqual(tb.x);
      expect(tb.x + tb.width, 'empty list closed: toggle left of controls').toBeLessThanOrEqual(cb.x);
    }
  }

  expectClean(state);
});

test('schedules-header has drag region, text is not selectable, and button is no-drag under ?shell=1', async ({ page }) => {
  const state = await openProto(page, '?shell=1');
  await page.getByTestId('next-schedules').click();
  await expect(page).toHaveURL(/#\/schedules$/);

  const headerInfo = await page.evaluate(() => {
    const header = document.querySelector('.schedules-header');
    const btn = document.querySelector('.schedules-new-btn');
    const headerStyle = getComputedStyle(header);
    const btnStyle = getComputedStyle(btn);

    const getRegion = (s) => (s.getPropertyValue('app-region') || s.getPropertyValue('-webkit-app-region')).trim();
    const getUserSelect = (s) => (s.getPropertyValue('user-select') || s.getPropertyValue('-webkit-user-select')).trim();

    return {
      headerRegion: getRegion(headerStyle),
      headerUserSelect: getUserSelect(headerStyle),
      btnRegion: getRegion(btnStyle),
    };
  });

  expect(headerInfo.headerRegion).toBe('drag');
  expect(headerInfo.headerUserSelect).toBe('none');
  expect(headerInfo.btnRegion).toBe('no-drag');

  expectClean(state);
});

test('title alignment under ?shell=1: .top-title and .schedules-title left offset matches .sb-hd first element, vertical centers align with .wc-btns within 1px', async ({ page }) => {
  const state = await openProto(page, '?shell=1');
  await page.locator('.col-center').waitFor();

  const sbBox = await box(page.locator('.col-left'));
  const sbFirstBox = await box(page.locator('.sb-hd').locator(':scope > *').first());
  const centerBox = await box(page.locator('.col-center'));
  const topTitleBox = await box(page.locator('.top-title'));
  const wcBox = await box(page.getByTestId('window-controls'));

  // 1. Conversation page title alignment
  const sbLeft = sbFirstBox.x - sbBox.x;
  const titleLeft = topTitleBox.x - centerBox.x;
  expect(Math.abs(titleLeft - sbLeft), 'conversation title left vs sb-hd first element left').toBeLessThanOrEqual(1);

  expect(Math.abs(centerY(topTitleBox) - centerY(sbFirstBox)), 'top-title centerY vs sb-hd title centerY').toBeLessThanOrEqual(1);
  expect(Math.abs(centerY(topTitleBox) - centerY(wcBox)), 'top-title centerY vs wc-btns centerY').toBeLessThanOrEqual(1);
  expect(Math.abs(centerY(sbFirstBox) - centerY(wcBox)), 'sb-hd title centerY vs wc-btns centerY').toBeLessThanOrEqual(1);

  // 2. Schedules page title alignment
  await page.getByTestId('next-schedules').click();
  await page.locator('.schedules-title').waitFor();
  const schedCenterBox = await box(page.locator('.col-center'));
  const schedTitleBox = await box(page.locator('.schedules-title'));

  const schedLeft = schedTitleBox.x - schedCenterBox.x;
  expect(Math.abs(schedLeft - sbLeft), 'schedules title left vs sb-hd first element left').toBeLessThanOrEqual(1);
  expect(Math.abs(schedLeft - titleLeft), 'schedules title left vs conversation title left (no jump on switch)').toBeLessThanOrEqual(1);

  expect(Math.abs(centerY(schedTitleBox) - centerY(sbFirstBox)), 'schedules title centerY vs sb-hd title centerY').toBeLessThanOrEqual(1);
  expect(Math.abs(centerY(schedTitleBox) - centerY(wcBox)), 'schedules title centerY vs wc-btns centerY').toBeLessThanOrEqual(1);

  expectClean(state);
});

test('without ?shell=1, schedules-header padding matches pre-change behavior and has no window controls', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-schedules').click();
  await expect(page).toHaveURL(/#\/schedules$/);

  await expect(page.getByTestId('window-controls')).toHaveCount(0);

  const headerInfo = await page.evaluate(() => {
    const header = document.querySelector('.schedules-header');
    const style = getComputedStyle(header);
    const getRegion = (s) => (s.getPropertyValue('app-region') || s.getPropertyValue('-webkit-app-region')).trim();
    const getUserSelect = (s) => (s.getPropertyValue('user-select') || s.getPropertyValue('-webkit-user-select')).trim();

    return {
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      region: getRegion(style),
      userSelect: getUserSelect(style),
    };
  });

  expect(headerInfo.paddingLeft).toBe('28px');
  expect(headerInfo.paddingRight).toBe('52px');
  expect(headerInfo.region).not.toBe('drag');
  expect(headerInfo.userSelect).not.toBe('none');

  // Verify conversation status padding-left without ?shell=1 is also untouched (12px)
  await page.getByTestId('next-sidebar').locator('.sb-top-row').first().click();
  await page.locator('.next-status').waitFor();
  const statusPaddingLeft = await page.evaluate(() => getComputedStyle(document.querySelector('.next-status')).paddingLeft);
  expect(statusPaddingLeft).toBe('12px');

  expectClean(state);
});

test('other pages and overlays under ?shell=1 do not overlap window controls', async ({ page }) => {
  const state = await openProto(page, '?shell=1');
  const controls = page.getByTestId('window-controls');
  await expect(controls).toBeVisible();
  const cb = await box(controls);

  // 1. Conversation page (right closed & open)
  for (const open of [false, true]) {
    await setRight(page, open);
    if (!open) {
      const titleBox = await page.getByTestId('next-status').locator('.top-title').boundingBox();
      if (titleBox) {
        expect(overlaps(cb, titleBox), 'conversation title vs window controls').toBe(false);
      }
    } else {
      for (const btn of await page.locator('.right-tabs-bar button').all()) {
        if (!(await btn.isVisible())) continue;
        expect(overlaps(cb, await box(btn)), 'right tab bar button vs window controls').toBe(false);
      }
    }
  }

  // 2. Schedule Dialog modal
  await page.getByTestId('next-schedules').click();
  await expect(page).toHaveURL(/#\/schedules$/);
  await page.getByTestId('next-schedules-new').click();
  const dialog = page.getByTestId('next-schedule-dialog');
  await expect(dialog).toBeVisible();
  const db = await box(dialog);
  expect(overlaps(cb, db), 'schedule dialog vs window controls').toBe(false);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // 3. Search palette
  await page.getByTestId('next-search').click();
  const palette = page.locator('.search-palette');
  await expect(palette).toBeVisible();
  const pb = await box(palette);
  expect(overlaps(cb, pb), 'search palette vs window controls').toBe(false);
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);

  // 4. Settings overlay
  await page.goto(page.url().replace(/#.*$/, '') + '#/settings');
  const settings = page.locator('.next-settings');
  await expect(settings).toBeVisible();
  const sb = await box(settings);
  expect(overlaps(cb, sb), 'settings dialog vs window controls').toBe(false);

  expectClean(state);
});
