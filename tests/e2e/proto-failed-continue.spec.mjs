import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('1. c-truncated shows only one line prompt, without buttons or notes', async ({ page }) => {
  const state = await openProto(page);
  await page.locator('[data-testid=next-conv-row][data-id="c-truncated"]').click();
  await expect(page).toHaveURL(/#\/c\/c-truncated$/);

  const truncated = page.getByTestId('next-truncated');
  await expect(truncated).toBeVisible();
  await expect(truncated).toHaveText('回复被截断');
  await expect(truncated.getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('next-continue')).toHaveCount(0);
  await expect(page.getByTestId('next-auto-continue-note')).toHaveCount(0);
  await expect(page.getByTestId('next-item-system-note')).toHaveCount(0);

  await expectClean(state);
});

test('2. c-failed and c-interrupted show cause and continue in thread; clicking continue streams reply, clears error, and adds no user message bubble', async ({ page }) => {
  const state = await openProto(page);

  // 1. Visit c-failed
  await page.locator('[data-testid=next-conv-row][data-id="c-failed"]').click();
  await expect(page).toHaveURL(/#\/c\/c-failed$/);

  const thread = page.getByTestId('next-thread');
  const threadInner = thread.locator('.thread-inner');
  const errorBanner = page.getByTestId('next-run-error');
  await expect(threadInner.locator('[data-testid="next-run-error"]')).toBeVisible();
  await expect(errorBanner).toContainText('模型请求失败：503 Service Unavailable');

  const continueBtn = page.getByTestId('next-run-continue');
  await expect(continueBtn).toBeVisible();
  await expect(continueBtn).toHaveText('继续');

  const userItemsBefore = await page.getByTestId('next-item-user').count();
  expect(userItemsBefore).toBe(1);

  // Click continue: error disappears, assistant reply appears
  await continueBtn.click();
  await expect(page.getByTestId('next-run-error')).toHaveCount(0);

  const assistant = page.getByTestId('next-item-assistant');
  await expect(assistant).toBeVisible();
  await expect(assistant.getByTestId('next-markdown')).toContainText('已继续执行并完成回复');

  // No extra user message bubble added
  await expect(page.getByTestId('next-item-user')).toHaveCount(1);

  // 2. Visit c-interrupted
  await page.locator('[data-testid=next-conv-row][data-id="c-interrupted"]').click();
  await expect(page).toHaveURL(/#\/c\/c-interrupted$/);

  const interruptedBanner = page.getByTestId('next-run-error');
  await expect(threadInner.locator('[data-testid="next-run-error"]')).toBeVisible();
  await expect(interruptedBanner).toContainText('服务中断，这一轮没有完成。');

  // Assert prompt is positioned inside Thread container, after the last message
  const lastUserMsg = thread.locator('[data-testid="next-item-user"]').last();
  const userBox = await lastUserMsg.boundingBox();
  const bannerBox = await interruptedBanner.boundingBox();
  expect(userBox).not.toBeNull();
  expect(bannerBox).not.toBeNull();
  expect(bannerBox.y).toBeGreaterThanOrEqual(userBox.y + userBox.height - 1);

  // Assert scrolling the conversation moves the error prompt
  const initialY = bannerBox.y;
  await thread.evaluate((el) => {
    el.scrollTop = 0;
  });
  const scrolledBox = await interruptedBanner.boundingBox();
  expect(scrolledBox).not.toBeNull();
  expect(scrolledBox.y).toBeGreaterThan(initialY);

  // Restore scroll to bottom
  await thread.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const interruptedContinueBtn = page.getByTestId('next-run-continue');
  await expect(interruptedContinueBtn).toBeVisible();
  await expect(interruptedContinueBtn).toHaveText('继续');

  await interruptedContinueBtn.click();
  await expect(page.getByTestId('next-run-error')).toHaveCount(0);
  const interruptedAssistant = page.getByTestId('next-item-assistant').last();
  await expect(interruptedAssistant).toBeVisible();
  await expect(interruptedAssistant.getByTestId('next-markdown')).toContainText('已继续执行并完成回复');
  await expect(page.getByTestId('next-item-user')).toHaveCount(2);

  await expectClean(state);
});

test('3. c-no-model-failed has no button; continue failure shows error', async ({ page }) => {
  const state = await openProto(page);

  // 1. Visit c-no-model-failed: canContinue is false, no continue button
  await page.locator('[data-testid=next-conv-row][data-id="c-no-model-failed"]').click();
  await expect(page).toHaveURL(/#\/c\/c-no-model-failed$/);

  const errorBanner = page.getByTestId('next-run-error');
  await expect(errorBanner).toBeVisible();
  await expect(errorBanner).toContainText('未配置可用模型，无法发起调用。');
  await expect(page.getByTestId('next-run-continue')).toHaveCount(0);

  // 2. Continue failure: visit c-failed, simulate failure
  await page.locator('[data-testid=next-conv-row][data-id="c-failed"]').click();
  await expect(page).toHaveURL(/#\/c\/c-failed$/);

  await page.evaluate(() => {
    window.__protoFailContinue = true;
  });

  const continueBtn = page.getByTestId('next-run-continue');
  await expect(continueBtn).toBeVisible();
  await continueBtn.click();

  // Shows error text inside banner
  const failedErrorBanner = page.getByTestId('next-run-error');
  await expect(failedErrorBanner).toContainText('服务异常，继续请求失败');
  await expect(continueBtn).toBeEnabled();

  // Reset flag
  await page.evaluate(() => {
    window.__protoFailContinue = false;
  });

  await expectClean(state);
});

test('4. error banner does not display code text (puts code in title attribute), supports English and dark mode', async ({ page }) => {
  const state = await openProto(page);

  // 1. Code in title, not in text
  await page.locator('[data-testid=next-conv-row][data-id="c-interrupted"]').click();
  await expect(page).toHaveURL(/#\/c\/c-interrupted$/);
  const errorBanner = page.getByTestId('next-run-error');
  await expect(errorBanner).toBeVisible();
  await expect(errorBanner).toHaveAttribute('title', 'interrupted');
  const bannerText = await errorBanner.textContent();
  expect(bannerText).not.toContain('interrupted');

  // 2. Theme switch: dark mode readability
  await expect(page.getByTestId('next-appearance-toggle')).toBeVisible();
  await page.getByTestId('next-appearance-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark$/);
  await expect(errorBanner).toBeVisible();
  await expect(page.getByTestId('next-run-continue')).toBeVisible();

  // 3. Switch to English
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings-general')).toBeVisible();
  await page.locator('[data-testid=next-pref-lang] button[data-lang="en"]').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toHaveCount(0);

  // Check c-truncated in English
  await page.locator('[data-testid=next-conv-row][data-id="c-truncated"]').click();
  const truncatedEn = page.getByTestId('next-truncated');
  await expect(truncatedEn).toBeVisible();
  await expect(truncatedEn).toHaveText('Response was truncated');

  // Check c-failed in English: message and button both English
  await page.locator('[data-testid=next-conv-row][data-id="c-failed"]').click();
  const failedEn = page.getByTestId('next-run-error');
  await expect(failedEn).toBeVisible();
  await expect(failedEn).toContainText('Model request failed: 503 Service Unavailable');
  await expect(page.getByTestId('next-run-continue')).toHaveText('Continue');

  // Check c-interrupted in English
  await page.locator('[data-testid=next-conv-row][data-id="c-interrupted"]').click();
  const interruptedEn = page.getByTestId('next-run-error');
  await expect(interruptedEn).toBeVisible();
  await expect(interruptedEn).toContainText('Service interrupted, this turn did not complete.');
  await expect(page.getByTestId('next-run-continue')).toHaveText('Continue');

  // Check c-no-model-failed in English
  await page.locator('[data-testid=next-conv-row][data-id="c-no-model-failed"]').click();
  const noModelEn = page.getByTestId('next-run-error');
  await expect(noModelEn).toBeVisible();
  await expect(noModelEn).toContainText('No model configured, cannot run.');
  await expect(page.getByTestId('next-run-continue')).toHaveCount(0);

  // Check continue failure error message in English
  await page.locator('[data-testid=next-conv-row][data-id="c-failed"]').click();
  await page.evaluate(() => {
    window.__protoFailContinue = true;
  });
  const continueEnBtn = page.getByTestId('next-run-continue');
  await continueEnBtn.click();
  await expect(page.getByTestId('next-run-error')).toContainText('Service error, failed to continue');
  await page.evaluate(() => {
    window.__protoFailContinue = false;
  });

  await expectClean(state);
});
