import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('prototype terminal tab streams a bash command', async ({ page }) => {
  await openProto(page);

  const termTab = page.getByTestId('next-right-tab-term');
  await expect(termTab).toBeVisible();
  await termTab.click();
  await expect(termTab).toHaveClass(/active/);
  await expect(page.getByTestId('next-term-pane')).toBeVisible();
  await expect(page.getByTestId('next-term-cmd').first()).toBeVisible();
  await expect(page.getByTestId('next-term-body')).toContainText('npm run test:web');
  await expect(page.getByTestId('next-term-note')).toContainText('主 Agent');
  await expect(page.getByTestId('next-term-full')).toBeVisible();
  await page.getByTestId('next-term-full').click();
  await expect(page.getByTestId('next-term-body')).toContainText('Duration');

  await page.getByTestId('next-new-chat').click();
  await page.getByTestId('next-composer-input').fill('跑测试');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-right-tab-term')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('next-right-tab-term').click();
  await expect(page.getByTestId('next-term-cmd')).toHaveAttribute('data-running', 'true', { timeout: 15000 });
  await expect(page.getByTestId('next-term-body')).toContainText('npm test', { timeout: 15000 });
  await expect(page.getByTestId('next-run-status')).toHaveText('完成', { timeout: 40000 });
  await expect(page.getByTestId('next-term-cmd')).toHaveAttribute('data-running', 'false');
  await expect(page.getByTestId('next-term-body')).toContainText('412 tests');

  await page.getByTestId('next-tool-group-summary').first().click();
  await expect(page.getByTestId('next-tool-open-term').first()).toBeVisible();
  await page.getByTestId('next-right-tab-files').click();
  await page.getByTestId('next-tool-open-term').first().click();
  await expect(page.getByTestId('next-right-tab-term')).toHaveClass(/active/);
  await expect(page.getByTestId('next-term-body')).toContainText('npm test');

  await expectClean(page);
});
