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

async function setRight(page, open) {
  const isOpen = async () => (await page.getByTestId('next-right-collapse').count()) > 0;
  if ((await isOpen()) !== open) await page.locator('.side-toggle-right').click();
  await page.waitForTimeout(500);
}

async function expectAligned(page, open, label) {
  const barSel = open ? '.right-tabs-bar' : '.next-status';
  const bar = await box(page.locator(barSel).first());
  const controls = await box(page.getByTestId('window-controls'));
  expect(Math.abs(controls.height - bar.height), `${label}: controls height vs bar`).toBeLessThanOrEqual(1);
  expect(Math.abs(controls.y - bar.y), `${label}: controls top vs bar`).toBeLessThanOrEqual(1);
  const centerY = (b) => b.y + b.height / 2;
  const ids = ['window-minimize', 'window-toggle-maximize', 'window-close'];
  const btns = [];
  for (const id of ids) btns.push(await box(page.getByTestId(id)));
  const toggle = await box(page.locator('.side-toggle-right'));
  const row = [toggle, ...btns];
  for (const b of btns) {
    expect(Math.abs(centerY(b) - centerY(toggle)), `${label}: button vs right toggle center`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.width - toggle.width), `${label}: equal width`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(centerY(toggle) - (bar.y + bar.height / 2)), `${label}: toggle vs bar center`).toBeLessThanOrEqual(1);
  const gaps = [];
  for (let i = 1; i < row.length; i++) gaps.push(row[i].x - (row[i - 1].x + row[i - 1].width));
  for (const g of gaps) expect(Math.abs(g - gaps[0]), `${label}: gaps ${gaps}`).toBeLessThanOrEqual(1);
  if (open) {
    for (const el of await page.locator('.right-tabs-bar button').all()) {
      if (!(await el.isVisible())) continue;
      const b = await box(el);
      expect(Math.abs(centerY(b) - centerY(btns[0])), `${label}: tab center`).toBeLessThanOrEqual(1);
    }
  } else {
    const title = await page.getByTestId('next-status').locator('.top-title').boundingBox();
    if (title) expect(Math.abs(centerY(title) - centerY(btns[0])), `${label}: title center`).toBeLessThanOrEqual(1);
  }
}

for (const scheme of ['light', 'dark']) {
  test(`window buttons align with the top bar (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const state = await openProto(page, '?shell=1');
    if (scheme === 'dark') await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'white-dark'));
    for (const open of [true, false]) {
      await setRight(page, open);
      await expectAligned(page, open, `${scheme}, right open=${open}`);
      await page.evaluate(() => document.documentElement.setAttribute('data-window-maximized', '1'));
      await expectAligned(page, open, `${scheme}, maximized, right open=${open}`);
      await page.evaluate(() => document.documentElement.removeAttribute('data-window-maximized'));
    }
    expectClean(state);
  });
}
