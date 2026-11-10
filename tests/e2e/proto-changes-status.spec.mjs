import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('changes pane: file status letters, deleted strikethrough, rename display, context menu, and diff notes', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-right-toggle').click();

  // 1. Changes tab is open by default, verify rows
  const addRow = page.locator('[data-testid=next-change-row][data-path="web/src/data/store.test.ts"]');
  const modRow = page.locator('[data-testid=next-change-row][data-path="web/src/data/store.ts"]');
  const delRow = page.locator('[data-testid=next-change-row][data-path="web/src/data/pendingSend.ts"]');
  const renRow = page.locator('[data-testid=next-change-row][data-path="web/src/styles/app.css"]');
  const noStatusRow = page.locator('[data-testid=next-change-row][data-path="web/src/components/ChangesPane.tsx"]');

  // 2. Status letters: A (Added), M (Modified), D (Deleted), R (Renamed)
  const addStatus = addRow.getByTestId('next-change-status');
  await expect(addStatus).toHaveText('A');
  await expect(addStatus).toHaveAttribute('data-status', 'added');
  await expect(addStatus).toHaveAttribute('title', '新增');

  const modStatus = modRow.getByTestId('next-change-status');
  await expect(modStatus).toHaveText('M');
  await expect(modStatus).toHaveAttribute('data-status', 'modified');
  await expect(modStatus).toHaveAttribute('title', '修改');

  const delStatus = delRow.getByTestId('next-change-status');
  await expect(delStatus).toHaveText('D');
  await expect(delStatus).toHaveAttribute('data-status', 'deleted');
  await expect(delStatus).toHaveAttribute('title', '删除');

  const renStatus = renRow.getByTestId('next-change-status');
  await expect(renStatus).toHaveText('R');
  await expect(renStatus).toHaveAttribute('data-status', 'renamed');
  await expect(renStatus).toHaveAttribute('title', '重命名');

  // 3. No status row has no status badge (unchanged from legacy behavior)
  await expect(noStatusRow.getByTestId('next-change-status')).toHaveCount(0);

  // 4. Deleted row: strikethrough styling and by is null (no by badge)
  await expect(delRow.locator('.changed-file-path')).toHaveClass(/is-deleted/);
  await expect(delRow.getByTestId('next-change-by')).toHaveCount(0);

  // Deleted row: right-click menu hides "show_in_files", only shows "copy_path"
  await delRow.locator('.changed-file-pill').click({ button: 'right' });
  const ctxMenu = page.getByTestId('next-ctx-menu');
  await expect(ctxMenu).toBeVisible();
  await expect(ctxMenu.locator('[data-action="show-in-files"]')).toHaveCount(0);
  await expect(ctxMenu.locator('[data-action="copy-path"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(ctxMenu).toHaveCount(0);

  // Non-deleted row: right-click menu includes "show_in_files"
  await modRow.locator('.changed-file-pill').click({ button: 'right' });
  await expect(page.getByTestId('next-ctx-menu')).toBeVisible();
  await expect(page.locator('[data-action="show-in-files"]')).toBeVisible();
  await expect(page.locator('[data-action="copy-path"]')).toBeVisible();
  await page.keyboard.press('Escape');

  // 5. Renamed row: shows "oldPath → newPath", title has full path
  const renPath = renRow.locator('.changed-file-path');
  await expect(renPath).toHaveClass(/is-renamed/);
  await expect(renPath).toContainText('web/src/styles/base.css → web/src/styles/app.css');
  await expect(renRow.locator('.changed-file-pill')).toHaveAttribute(
    'title',
    'web/src/styles/base.css → web/src/styles/app.css',
  );

  // Renamed row: content unchanged -> shows "仅重命名" in diff area instead of blank/empty
  const renDiff = renRow.getByTestId('next-diff');
  await expect(renDiff).toBeVisible();
  await expect(renDiff.locator('.diff-note')).toHaveText('仅重命名');

  // Deleted row diff: displays deleted lines
  const delDiff = delRow.getByTestId('next-diff');
  await expect(delDiff).toBeVisible();
  expect(await delDiff.locator('[data-op=del]').count()).toBeGreaterThan(0);

  // 6. Thread change summary also shows status badges
  await page.getByTestId('next-change-summary-toggle').click();
  const sumAddRow = page.locator('[data-testid=next-change-summary-row][data-path="web/src/data/store.test.ts"]');
  await expect(sumAddRow.getByTestId('next-change-summary-status')).toHaveText('A');
  await expect(sumAddRow.getByTestId('next-change-summary-status')).toHaveAttribute('title', '新增');

  const sumModRow = page.locator('[data-testid=next-change-summary-row][data-path="web/src/data/store.ts"]');
  await expect(sumModRow.getByTestId('next-change-summary-status')).toHaveText('M');

  // Expand change summary to see the others
  await page.getByTestId('next-change-summary-more').click();
  const sumDelRow = page.locator('[data-testid=next-change-summary-row][data-path="web/src/data/pendingSend.ts"]');
  await expect(sumDelRow.getByTestId('next-change-summary-status')).toHaveText('D');
  await expect(sumDelRow.locator('.change-summary-row-name')).toHaveClass(/is-deleted/);

  const sumRenRow = page.locator('[data-testid=next-change-summary-row][data-path="web/src/styles/app.css"]');
  await expect(sumRenRow.getByTestId('next-change-summary-status')).toHaveText('R');
  await expect(sumRenRow).toHaveAttribute('title', 'web/src/styles/base.css → web/src/styles/app.css');

  // 7. Narrow right pane does not overflow horizontally.
  // Width is driven by --right-w (the inner panel's min-width follows it).
  // Setting only the used width starts a CSS transition; measuring mid-way
  // sees a shell narrower than the still-440px inner panel.
  const rightPane = page.getByTestId('next-right');
  await page.getByTestId('next-app').evaluate((shell) => {
    const pane = shell.querySelector('[data-testid=next-right]');
    pane.style.transition = 'none';
    const inner = pane.querySelector('.col-panel-inner');
    if (inner) inner.style.transition = 'none';
    shell.style.setProperty('--right-w', '240px');
  });
  const scrollInfo = await rightPane.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollInfo.scrollWidth).toBeLessThanOrEqual(scrollInfo.clientWidth + 1);

  // Restore right pane width
  await page.getByTestId('next-app').evaluate((shell) => {
    const pane = shell.querySelector('[data-testid=next-right]');
    pane.style.transition = '';
    const inner = pane.querySelector('.col-panel-inner');
    if (inner) inner.style.transition = '';
    shell.style.removeProperty('--right-w');
  });

  // 8. English locale verification
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings-general')).toBeVisible();
  await page.locator('[data-testid=next-pref-lang] button[data-lang="en"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.keyboard.press('Escape');

  // Status tooltips in English
  await expect(addStatus).toHaveAttribute('title', 'Added');
  await expect(modStatus).toHaveAttribute('title', 'Modified');
  await expect(delStatus).toHaveAttribute('title', 'Deleted');
  await expect(renStatus).toHaveAttribute('title', 'Renamed');

  // Diff note in English
  await expect(renDiff.locator('.diff-note')).toHaveText('Renamed only');

  expectClean(state);
});
