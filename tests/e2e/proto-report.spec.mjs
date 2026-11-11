import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('about -> report a problem -> export downloads a zip', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-about').click();
  await page.getByTestId('next-about-report').click();

  const dialog = page.getByTestId('next-report');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('next-report-conversation')).toHaveCount(0);
  await expect(page.getByTestId('next-report-files')).toContainText('doctor.txt');
  await page.getByTestId('next-report-doctor').uncheck();
  await expect(page.getByTestId('next-report-files')).not.toContainText('doctor.txt');
  await page.getByTestId('next-report-text').fill('点发送没反应');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('next-report-export').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^weft-report-\d{8}-\d{6}\.zip$/);
  await expect(page.getByTestId('next-report-status')).toContainText('已导出');
  await expect(page.getByTestId('next-report-reveal')).toHaveCount(0);
  expectClean(state);
});

test('conversation menu and error row open the dialog with the conversation, not attached by default', async ({ page }) => {
  const state = await openProto(page);
  const row = page.locator('[data-testid=next-conv-row][data-id="c-failed"]');
  await row.click({ button: 'right' });
  await page.locator('[data-action="report"]').click();
  await expect(page.getByTestId('next-report-conversation')).not.toBeChecked();
  await expect(page.getByTestId('next-report-files')).not.toContainText('conversation-c-failed.json');
  await page.getByTestId('next-report-conversation').check();
  await expect(page.getByTestId('next-report-files')).toContainText('conversation-c-failed.json');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-report')).toHaveCount(0);

  await row.click();
  await page.getByTestId('next-run-report').click();
  await expect(page.getByTestId('next-report-conversation')).toBeVisible();
  expectClean(state);
});

test('desktop shell: save goes through the shell and offers reveal', async ({ page }) => {
  const state = await openProto(page, 'shell=1');
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-about').click();
  await page.getByTestId('next-about-report').click();
  await page.getByTestId('next-report-export').click();
  await expect(page.getByTestId('next-report-status')).toContainText('已导出');
  await page.getByTestId('next-report-reveal').click();
  const msgs = await page.evaluate(() => window.__protoShellMessages.map((m) => m.type));
  expect(msgs).toEqual(['weft.saveReport', 'weft.revealInFolder']);
  expectClean(state);
});
