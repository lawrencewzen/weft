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

test('without the shell attribute there are no window buttons or drag regions', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.getByTestId('window-controls')).toHaveCount(0);
  const regions = await page.evaluate(() => [...document.querySelectorAll('*')]
    .filter((el) => {
      const s = getComputedStyle(el);
      const v = (s.getPropertyValue('app-region') || s.getPropertyValue('-webkit-app-region')).trim();
      return v === 'drag' || v === 'no-drag';
    }).length);
  expect(regions).toBe(0);
  expectClean(state);
});

test('with ?shell=1 the buttons show and never overlap the top controls, right pane open or closed', async ({ page }) => {
  const state = await openProto(page, '?shell=1');
  const controls = page.getByTestId('window-controls');
  await expect(controls).toBeVisible();
  await expect(page.getByTestId('window-minimize')).toBeVisible();
  await expect(page.getByTestId('window-toggle-maximize')).toBeVisible();
  await expect(page.getByTestId('window-close')).toBeVisible();
  // Buttons are clickable and do nothing in the prototype.
  await page.getByTestId('window-minimize').click();
  await expect(page.getByTestId('next-app')).toBeVisible();

  const drag = await page.evaluate(() => {
    const v = (sel) => {
      const el = document.querySelector(sel);
      const s = getComputedStyle(el);
      return (s.getPropertyValue('app-region') || s.getPropertyValue('-webkit-app-region')).trim();
    };
    return { status: v('.next-status'), left: v('.sb-hd'), toggle: v('.side-toggle-left') };
  });
  expect(drag).toEqual({ status: 'drag', left: 'drag', toggle: 'no-drag' });

  for (const width of [1440, 1000, 700]) {
    await page.setViewportSize({ width, height: 900 });
    for (const open of [false, true]) {
      const toggle = page.getByTestId(open ? 'next-right-collapse' : 'next-right-toggle');
      if (await toggle.count() === 0) {
        await page.locator('.side-toggle-right').click();
      }
      const isOpen = await page.getByTestId('next-right-collapse').count() > 0;
      if (isOpen !== open) await page.locator('.side-toggle-right').click();
      await page.waitForTimeout(400);
      const cb = await box(controls);
      const targets = ['.side-toggle-right', '.side-toggle-left'];
      for (const sel of targets) {
        const b = await box(page.locator(sel));
        expect(overlaps(cb, b), `${sel} vs window buttons (w=${width}, right open=${open})`).toBe(false);
      }
      if (open) {
        for (const el of await page.locator('.right-tabs-bar button').all()) {
          if (!(await el.isVisible())) continue;
          expect(overlaps(cb, await box(el)), `right tab bar button (w=${width})`).toBe(false);
        }
      } else {
        const status = await page.getByTestId('next-status').locator('.top-title').boundingBox();
        if (status) expect(overlaps(cb, status)).toBe(false);
      }
    }
  }
  expectClean(state);
});

test('window buttons stay on top of the settings overlay', async ({ page }) => {
  const state = await openProto(page, '?shell=1');
  await page.keyboard.press('Control+,');
  const overlay = page.locator('.next-settings-ov');
  if (await overlay.count() === 0) {
    await page.goto(page.url().replace(/#.*$/, '') + '#/settings');
  }
  await expect(page.locator('.next-settings-ov')).toBeVisible();
  const top = await page.evaluate(() => {
    const b = document.querySelector('[data-testid=window-close]').getBoundingClientRect();
    const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return el?.closest('[data-testid=window-close]') !== null;
  });
  expect(top).toBe(true);
  const dialog = await box(page.locator('.next-settings'));
  expect(overlaps(await box(page.getByTestId('window-controls')), dialog)).toBe(false);
  expectClean(state);
});
