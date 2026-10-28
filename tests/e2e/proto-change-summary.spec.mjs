import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('change summary card: title, sorting, collapse threshold, expand/collapse, outside tag, and diff opening', async ({ page }) => {
  const state = await openProto(page);

  const card = page.getByTestId('next-change-summary');
  await expect(card).toBeVisible();

  // 1. Title line with icon, count, totals, and "查看变更 ›"
  const head = card.getByTestId('next-change-summary-head');
  await expect(head).toBeVisible();
  await expect(head.locator('.change-summary-head-title')).toHaveText('改了 8 个文件');
  await expect(head.locator('.change-summary-head-sum .add')).toHaveText('+73');
  await expect(head.locator('.change-summary-head-sum .del')).toHaveText('−18');
  await expect(head.locator('.change-summary-head-view')).toHaveText('查看变更 ›');

  // 2. Rows sorted by change volume descending. 8 files > 6 threshold, so first 5 are shown.
  const rows = card.getByTestId('next-change-summary-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveAttribute('data-path', 'web/src/components/ChangesPane.tsx');
  await expect(rows.nth(1)).toHaveAttribute('data-path', 'web/src/data/diffView.ts');
  await expect(rows.nth(2)).toHaveAttribute('data-path', 'web/src/data/store.test.ts');
  await expect(rows.nth(3)).toHaveAttribute('data-path', 'web/src/data/store.ts');
  await expect(rows.nth(4)).toHaveAttribute('data-path', 'web/src/components/Thread.tsx');

  // 3. More toggle shows remaining count (8 - 5 = 3)
  const moreBtn = card.getByTestId('next-change-summary-more');
  await expect(moreBtn).toBeVisible();
  await expect(moreBtn).toContainText('还有 3 个文件');

  // 4. Click expand: shows all 8 files and scrolls
  await moreBtn.click();
  await expect(rows).toHaveCount(8);
  await expect(moreBtn).toContainText('收起');
  await expect(card.locator('.change-summary-rows')).toHaveClass(/is-scroll/);

  // 5. Outside workspace row has the outside badge and ~ abbreviated path
  const outsideRow = card.locator('[data-testid=next-change-summary-row][data-path="/Users/lawrence/.config/weft/notes.md"]');
  await expect(outsideRow).toBeVisible();
  await expect(outsideRow.getByTestId('next-change-summary-outside')).toHaveText('工作区外');
  await expect(outsideRow.locator('.change-summary-row-dir')).toContainText('~/.config/weft/');
  await expect(outsideRow.locator('.change-summary-row-name')).toHaveText('notes.md');

  // 6. Click collapse: hides extra rows again
  await moreBtn.click();
  await expect(rows).toHaveCount(5);
  await expect(moreBtn).toContainText('还有 3 个文件');

  // 7. Click a row to open diff in the right pane
  await card.locator('[data-testid=next-change-summary-row][data-path="web/src/data/store.ts"]').click();
  await expect(page.locator('.right-tabs-bar .tab-btn.active')).toContainText('变更');
  await expect(
    page.locator('[data-testid=next-change-row][data-path="web/src/data/store.ts"]').getByTestId('next-diff'),
  ).toBeVisible();

  // 8. Click header line opens right pane on changes tab
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.locator('.right-tabs-bar .tab-btn.active')).toContainText('文件');
  await head.click();
  await expect(page.locator('.right-tabs-bar .tab-btn.active')).toContainText('变更');

  expectClean(state);
});
