import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

async function openConv(page, id) {
  await page.locator(`[data-testid=next-conv-row][data-id="${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${id}$`));
}

const stopCalls = (state) => state.requests().then((rs) => rs.filter((r) => /\/stop/.test(r.url)).length);

async function openRunning(page) {
  const state = await openProto(page);
  await openConv(page, 'c-retrying');
  await expect(page.getByTestId('next-stop')).toBeVisible();
  return state;
}

async function expectStopped(page, state) {
  await expect(page.getByTestId('next-stop')).toHaveCount(0);
  expect(await stopCalls(state)).toBe(1);
}

test('1. Esc stops the running conversation; the button hints Esc', async ({ page }) => {
  const state = await openRunning(page);
  await expect(page.getByTestId('next-stop')).toHaveAttribute('title', /Esc/);
  await expect(page.getByTestId('next-stop')).toHaveAttribute('aria-label', /Esc/);
  await page.getByTestId('next-composer-input').focus();
  await page.keyboard.press('Escape');
  await expectStopped(page, state);
  expectClean(state);
});

test('2. model menu: first Esc closes the menu, second Esc stops', async ({ page }) => {
  const state = await openRunning(page);
  await page.getByTestId('next-model-chip').click();
  await expect(page.getByTestId('next-model-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-model-menu')).toHaveCount(0);
  expect(await stopCalls(state)).toBe(0);
  await expect(page.getByTestId('next-stop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expectStopped(page, state);
  expectClean(state);
});

test('3. @ list: first Esc closes the list, second Esc stops', async ({ page }) => {
  const state = await openRunning(page);
  await page.getByTestId('next-composer-input').fill('@');
  await expect(page.locator('.composer-at-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.composer-at-menu')).toHaveCount(0);
  expect(await stopCalls(state)).toBe(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => stopCalls(state)).toBe(1);
  expectClean(state);
});

test('4. settings open: Esc closes settings and does not stop', async ({ page }) => {
  const state = await openRunning(page);
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toHaveCount(0);
  expect(await stopCalls(state)).toBe(0);
  await expect(page.getByTestId('next-stop')).toBeVisible();
  expectClean(state);
});

test('5. search box focused: Esc does not stop', async ({ page }) => {
  const state = await openRunning(page);
  await page.getByTestId('next-search').click();
  const input = page.getByTestId('next-search-input');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-search-modal')).toHaveCount(0);
  expect(await stopCalls(state)).toBe(0);
  await expect(page.getByTestId('next-stop')).toBeVisible();
  expectClean(state);
});

test('6. editable control outside the composer: Esc does not stop', async ({ page }) => {
  const state = await openRunning(page);
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.id = 'esc-probe';
    document.body.appendChild(i);
    i.focus();
  });
  await page.keyboard.press('Escape');
  expect(await stopCalls(state)).toBe(0);
  await page.evaluate(() => document.getElementById('esc-probe')?.remove());
  await expect(page.getByTestId('next-stop')).toBeVisible();
});

test('7. IME composing Esc does not stop', async ({ page }) => {
  const state = await openRunning(page);
  await page.getByTestId('next-composer-input').focus();
  await page.evaluate(() => {
    const t = document.activeElement;
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true }));
  });
  expect(await stopCalls(state)).toBe(0);
  await expect(page.getByTestId('next-stop')).toBeVisible();
  expectClean(state);
});

test('8. idle conversation: Esc sends no stop request', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  await expect(page.getByTestId('next-stop')).toHaveCount(0);
  await page.getByTestId('next-composer-input').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  expect(await stopCalls(state)).toBe(0);
  expectClean(state);
});
