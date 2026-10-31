import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });

test('git test feedback: drawer test button shows "测试中…" for at least 500ms and result is scrolled into view not obscured by footer', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-git').click();

  await page.getByTestId('next-git-add').click();
  await expect(page.getByTestId('next-git-drawer')).toBeVisible();

  await page.getByTestId('next-git-kind-other').click();

  await page.locator('.ns-adv-toggle').click();
  await expect(page.getByTestId('next-git-ca')).toBeVisible();

  const testBtn = page.getByTestId('next-git-test');
  await expect(testBtn).toHaveText('测试');
  await expect(testBtn).toBeEnabled();

  await testBtn.click();

  // Within 500ms, button shows "测试中…" and is disabled
  await expect(testBtn).toHaveText('测试中…');
  await expect(testBtn).toBeDisabled();

  // Result appears after >= 500ms
  const result = page.getByTestId('next-git-test-result');
  await expect(result).toBeVisible();
  await expect(testBtn).toHaveText('测试');
  await expect(testBtn).toBeEnabled();

  // Assert result element is inside viewport
  await expect(result).toBeInViewport();

  // Assert result bottom <= drawer footer top (not obscured by footer)
  const resultBox = await result.boundingBox();
  const footBox = await page.locator('.ns-drawer-foot').boundingBox();
  expect(resultBox).not.toBeNull();
  expect(footBox).not.toBeNull();
  expect(resultBox.y + resultBox.height).toBeLessThanOrEqual(footBox.y);

  expectClean(state);
});

test('git row test: shows "测试中…" for at least 500ms and disables row button', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-git').click();

  const row = page.getByTestId('next-git-row').first();
  const rowTestBtn = row.getByTestId('next-git-row-test');
  await expect(rowTestBtn).toBeEnabled();

  await rowTestBtn.click();

  // Within 500ms, row shows "测试中…" and button is disabled
  await expect(row).toContainText('测试中…');
  await expect(rowTestBtn).toBeDisabled();

  // After >= 500ms, restores
  await expect(rowTestBtn).toBeEnabled();
  await expect(row).not.toContainText('测试中…');

  expectClean(state);
});
