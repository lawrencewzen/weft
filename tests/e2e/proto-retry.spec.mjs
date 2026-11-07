import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

async function openConv(page, id) {
  await page.locator(`[data-testid=next-conv-row][data-id="${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${id}$`));
}

const animationOf = (locator, pseudo = null) => locator.evaluate(
  (el, p) => getComputedStyle(el, p).animationName,
  pseudo,
);

test('1. c-retrying: the pending row says why and how many tries; stop clears it', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-retrying');

  const pending = page.getByTestId('next-thread-pending');
  await expect(pending).toHaveAttribute('data-retrying', 'true');
  await expect(pending).toHaveText('连不上模型服务，正在重试（第 6 次，共 10 次）');
  await expect(pending).not.toContainText('思考中');
  await expect(pending).not.toContainText(/fetch failed|ECONN/i);
  // The stop button is unchanged.
  await expect(page.getByTestId('next-stop')).toBeVisible();
  await page.getByTestId('next-stop').click();
  await expect(pending).toHaveCount(0);
  await expectClean(state);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('2. running spinners keep spinning; panel slide stays off', async ({ page }) => {
    const state = await openProto(page);
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

    // Thread pending spinner (run-spin::before) and the sidebar running icon.
    await openConv(page, 'c-retrying');
    const spin = page.getByTestId('next-thread-pending').locator('.run-spin');
    await expect(spin).toBeVisible();
    expect(await animationOf(spin, '::before')).not.toBe('none');
    const running = page.locator('.status-icon-running').first();
    await expect(running).toBeVisible();
    expect(await animationOf(running)).not.toBe('none');

    // Decorative panel slide is still disabled.
    const shell = page.locator('.next-shell');
    await expect(shell).toHaveClass(/is-ready/);
    const center = page.locator('.next-shell .col-center');
    expect(await center.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe('none');
    await expectClean(state);
  });
});

test('3. without reduced motion the panel slide transition is on', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.locator('.next-shell')).toHaveClass(/is-ready/);
  const center = page.locator('.next-shell .col-center');
  expect(await center.evaluate((el) => getComputedStyle(el).transitionProperty)).not.toBe('none');
  await expectClean(state);
});
