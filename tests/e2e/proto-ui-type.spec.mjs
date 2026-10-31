import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

const ICON_EXCLUDE = [
  '.btn-icon-xs',
  '.confirm-close',
  '.model-chip-caret',
  '.next-settings-close',
  '.mp-more',
  '.mp-x',
  '.composer-queue-x',
  '.composer-tag-x',
  '.dr .chev',
  '.mp-add-ck',
  '.msg-body h1',
].join(', ');

const MD_ALLOWED = [11.5, 12.5, 13.5, 14, 14.5, 15, 17, 28, 14.5 * 0.86];

function near(px, targets, eps = 0.06) {
  return targets.some((t) => Math.abs(px - t) < eps);
}

async function fontSizeOf(locator) {
  return locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

async function setFontSize(page, size) {
  if (await page.getByTestId('next-settings').count() === 0) {
    await page.getByTestId('next-open-settings').click();
    await expect(page.getByTestId('next-settings')).toBeVisible();
  }
  await page.getByTestId('next-settings-nav-general').click();
  await page.locator(`[data-testid=next-pref-font] button[data-size="${size}"]`).click();
  await expect(page.locator('html')).toHaveAttribute('data-font-size', size);
}

async function closeSettings(page) {
  if (await page.getByTestId('next-settings').count() === 0) return;
  await page.locator('.next-settings-close').click();
  await expect(page.getByTestId('next-settings')).toHaveCount(0);
}

async function measureMenuItem(page) {
  await closeSettings(page);
  const row = page.locator('[data-testid=next-conv-row]').first();
  await row.hover();
  const moreBtn = row.getByTestId('next-conv-more');
  await expect(moreBtn).toBeVisible();
  await moreBtn.click();
  const item = page.locator('.ctx-menu-item').first();
  await expect(item).toBeVisible();
  const px = await fontSizeOf(item);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-ctx-menu')).toHaveCount(0);
  return px;
}

async function measureFormInput(page) {
  if (await page.getByTestId('next-settings').count() === 0) {
    await page.getByTestId('next-open-settings').click();
    await expect(page.getByTestId('next-settings')).toBeVisible();
  }
  await page.getByTestId('next-settings-nav-plugins').click();
  const input = page.getByTestId('next-plugin-path');
  await expect(input).toBeVisible();
  return fontSizeOf(input);
}

async function collectTextFontSizes(page) {
  return page.evaluate((iconSel) => {
    /** @type {{ sel: string, text: string, px: number }[]} */
    const out = [];
    const icons = document.querySelectorAll(iconSel);
    const skip = new Set(icons);
    for (const el of icons) {
      el.querySelectorAll('*').forEach((child) => skip.add(child));
    }
    const all = document.body.querySelectorAll('*');
    for (const el of all) {
      if (skip.has(el)) continue;
      if (el.closest('svg')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim().length > 0,
      );
      if (!hasText) continue;
      const px = parseFloat(style.fontSize);
      const cls = typeof el.className === 'string' ? el.className.trim() : '';
      const sel = `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : ''}${cls ? '.' + cls.split(/\s+/).slice(0, 3).join('.') : ''}`;
      out.push({ sel, text: (el.textContent || '').trim().slice(0, 40), px });
    }
    return out;
  }, ICON_EXCLUDE);
}

test('font-size roles follow sm/md/lg across chrome, settings, draft title and body', async ({ page }) => {
  const state = await openProto(page);

  const convRow = page.locator('[data-testid=next-conv-row]').first();
  const convTitle = convRow.locator('.sb-conv-title, .conv-node-title').first();
  const convTime = convRow.locator('.sb-conv-meta, .conv-node-meta').first();
  const groupLabel = page.locator('.sb-sec, .sec').first();
  const msgBody = page.locator('[data-testid=next-item-assistant] .msg-body').first();

  await expect(convRow).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'md');

  expect(await fontSizeOf(convTitle)).toBeCloseTo(13.5, 1);
  expect(await fontSizeOf(convTime)).toBeCloseTo(12.5, 1);
  expect(await fontSizeOf(groupLabel)).toBeCloseTo(11.5, 1);
  expect(await fontSizeOf(msgBody)).toBeCloseTo(14.5, 1);
  expect(await measureMenuItem(page)).toBeCloseTo(13.5, 1);

  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings')).toBeVisible();
  const settingsTitle = page.locator('.next-settings-head h2');
  const navItem = page.getByTestId('next-settings-nav-general');
  const segBtn = page.locator('[data-testid=next-pref-font] button').first();
  await expect(settingsTitle).toBeVisible();
  expect(await fontSizeOf(settingsTitle)).toBeCloseTo(17, 1);
  expect(await fontSizeOf(navItem)).toBeCloseTo(13.5, 1);
  expect(await fontSizeOf(segBtn)).toBeCloseTo(13.5, 1);
  expect(await measureFormInput(page)).toBeCloseTo(13.5, 1);

  await setFontSize(page, 'lg');
  expect(await fontSizeOf(convTitle)).toBeCloseTo(14.5, 1);
  expect(await fontSizeOf(convTime)).toBeCloseTo(13.5, 1);
  expect(await fontSizeOf(groupLabel)).toBeCloseTo(12.5, 1);
  expect(await fontSizeOf(settingsTitle)).toBeCloseTo(18, 1);
  expect(await fontSizeOf(navItem)).toBeCloseTo(14.5, 1);
  expect(await fontSizeOf(segBtn)).toBeCloseTo(14.5, 1);
  expect(await fontSizeOf(msgBody)).toBeCloseTo(15.5, 1);
  expect(await measureFormInput(page)).toBeCloseTo(14.5, 1);
  expect(await measureMenuItem(page)).toBeCloseTo(14.5, 1);

  await setFontSize(page, 'sm');
  expect(await fontSizeOf(convTitle)).toBeCloseTo(12.5, 1);
  expect(await fontSizeOf(convTime)).toBeCloseTo(11.5, 1);
  expect(await fontSizeOf(groupLabel)).toBeCloseTo(10.5, 1);
  expect(await fontSizeOf(settingsTitle)).toBeCloseTo(16, 1);
  expect(await fontSizeOf(navItem)).toBeCloseTo(12.5, 1);
  expect(await fontSizeOf(segBtn)).toBeCloseTo(12.5, 1);
  expect(await fontSizeOf(msgBody)).toBeCloseTo(13.5, 1);
  expect(await measureFormInput(page)).toBeCloseTo(12.5, 1);
  expect(await measureMenuItem(page)).toBeCloseTo(12.5, 1);

  await setFontSize(page, 'md');
  await closeSettings(page);

  await page.getByTestId('next-new-chat').click();
  const hero = page.getByTestId('next-draft-hero-ws');
  await expect(hero).toBeVisible();
  expect(await fontSizeOf(hero)).toBeCloseTo(28, 1);

  await setFontSize(page, 'lg');
  expect(await fontSizeOf(hero)).toBeCloseTo(28, 1);
  await setFontSize(page, 'sm');
  expect(await fontSizeOf(hero)).toBeCloseTo(28, 1);
  await setFontSize(page, 'md');
  await closeSettings(page);

  expectClean(state);
});

test('computed font-size of text on home, chat, settings and model menu stays in the role set', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'md');

  const assertAllowed = async (label) => {
    const rows = await collectTextFontSizes(page);
    const bad = rows.filter((r) => !near(r.px, MD_ALLOWED));
    expect(bad, `${label}: unexpected font-size ${JSON.stringify(bad.slice(0, 12))}`).toEqual([]);
  };

  await assertAllowed('conversation');

  const chip = page.getByTestId('next-model-chip');
  await chip.click();
  await expect(page.getByTestId('next-model-menu')).toBeVisible();
  await assertAllowed('model-menu');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-model-menu')).toHaveCount(0);

  await page.getByTestId('next-new-chat').click();
  await expect(page.getByTestId('next-draft-hero-ws')).toBeVisible();
  await assertAllowed('draft-home');

  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings')).toBeVisible();
  await assertAllowed('settings-general');
  await page.getByTestId('next-settings-nav-providers').click();
  await expect(page.getByTestId('next-provider-page')).toBeVisible();
  await assertAllowed('settings-providers');

  expectClean(state);
});
