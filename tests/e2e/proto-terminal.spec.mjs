import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('clicking command tool row expands full output in place without opening right pane', async ({ page }) => {
  const state = await openProto(page);

  // 1. Terminal tab and pane are completely gone from right pane
  await expect(page.getByTestId('next-right-tab-term')).toHaveCount(0);
  await expect(page.getByTestId('next-term-pane')).toHaveCount(0);
  await page.getByTestId('next-right-toggle').click();
  await expect(page.getByTestId('next-right-tab-changes')).toBeVisible();
  await expect(page.getByTestId('next-right-tab-files')).toBeVisible();

  // 2. Initial conversation: click tool group summary, then click bash tool row
  await page.getByTestId('next-tool-group-summary').first().click();
  const bashRow = page.locator('[data-testid="next-tool-row"][data-tool="bash"]').first();
  await expect(bashRow).toBeVisible();
  await expect(page.getByTestId('next-tool-open-term')).toHaveCount(0);

  // Set right tab to files so we can verify right pane does not switch tab
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.getByTestId('next-right-tab-files')).toHaveClass(/active/);

  // Click bash tool row to expand in-place
  await bashRow.click();
  const detail = bashRow.locator('[data-testid="next-tool-row-detail"]');
  await expect(detail).toBeVisible();
  const block = detail.locator('.tool-detail-block');
  await expect(block).toBeVisible();
  await expect(block).toContainText('npm run test:web');
  await detail.getByTestId('next-tool-output-more').click();
  await expect(block).toContainText('Duration');

  // Verify right pane remained on files tab and did not open terminal
  await expect(page.getByTestId('next-right-tab-files')).toHaveClass(/active/);
  await expect(page.getByTestId('next-right-tab-term')).toHaveCount(0);

  // 3. New chat: send command and check in-place output
  await page.getByTestId('next-new-chat').click();
  await page.getByTestId('next-composer-input').fill('跑测试');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 40000 });
  await expect(page.getByTestId('next-send')).toBeVisible();

  // Expand tool group in thread
  await page.getByTestId('next-tool-group-summary').first().click();
  const newBashRow = page.locator('[data-testid="next-tool-row"][data-tool="bash"]').first();
  await expect(newBashRow).toBeVisible();
  await newBashRow.click();

  const newDetail = newBashRow.locator('[data-testid="next-tool-row-detail"]');
  await expect(newDetail).toBeVisible();
  await expect(newDetail.locator('.tool-detail-block')).toContainText('npm test');

  // Right pane still has no terminal tab
  await expect(page.getByTestId('next-right-tab-term')).toHaveCount(0);

  await expectClean(state);
});
