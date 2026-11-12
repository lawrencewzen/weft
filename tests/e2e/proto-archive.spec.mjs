import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('archive, unarchive, undo, auto-unarchive on send, delete confirmation, and disabled actions on running conversation', async ({ page }) => {
  const state = await openProto(page);

  // 1. Initial archived state: seed has 2 archived conversations (c-arch-1, c-arch-2)
  const archivedToggle = page.getByTestId('next-archived-toggle');
  const archivedCount = page.getByTestId('next-archived-count');
  await expect(archivedCount).toHaveText('2');

  // Archive a normal idle conversation (c-truncated)
  const truncConv = page.locator('[data-testid=next-conv-row][data-id="c-truncated"]');
  await expect(truncConv).toBeVisible();
  await truncConv.click({ button: 'right' });

  const ctxMenu = page.getByTestId('next-ctx-menu');
  await expect(ctxMenu).toBeVisible();

  const archiveItem = ctxMenu.locator('[data-action="archive"]');
  await expect(archiveItem).toHaveText('归档');
  await expect(archiveItem).toBeEnabled();
  await archiveItem.click();

  // Toast appears with Undo
  const toast = page.getByTestId('next-toast');
  await expect(toast).toContainText('已归档');
  const undoBtn = page.getByTestId('next-toast-action');
  await expect(undoBtn).toHaveText('撤销');

  // c-truncated moved to archived; badge is now 3
  await expect(truncConv).toHaveCount(0);
  await expect(archivedCount).toHaveText('3');

  // Click Undo: restores conversation
  await undoBtn.click();
  await expect(page.locator('[data-testid=next-conv-row][data-id="c-truncated"]')).toBeVisible();
  await expect(archivedCount).toHaveText('2');

  // 2. Unarchive from archived list
  await archivedToggle.click();
  const archivedList = page.getByTestId('next-archived-list');
  await expect(archivedList).toBeVisible();

  const archTwo = archivedList.locator('[data-testid=next-conv-row][data-id="c-arch-2"]');
  await expect(archTwo).toBeVisible();
  await archTwo.click({ button: 'right' });

  const unarchiveItem = page.getByTestId('next-ctx-menu').locator('[data-action="unarchive"]');
  await expect(unarchiveItem).toHaveText('取消归档');
  await unarchiveItem.click();

  // c-arch-2 moved back to workspace group; badge is 1
  await expect(archTwo).toHaveCount(0);
  await expect(archivedCount).toHaveText('1');

  // Auto-unarchive when sending a message in an archived conversation
  const archOne = archivedList.locator('[data-testid=next-conv-row][data-id="c-arch-1"]');
  await expect(archOne).toBeVisible();
  await archOne.click();

  const composerInput = page.getByTestId('next-composer-input');
  await expect(composerInput).toBeVisible();
  await composerInput.fill('继续处理迁移工作');
  await page.getByTestId('next-send').click();

  // c-arch-1 is now unarchived and back in its workspace group (ws-weft)
  await expect(archOne).toHaveCount(0);
  // Badge is gone because 0 archived conversations left
  await expect(archivedCount).toHaveCount(0);
  await expect(page.locator('[data-testid=next-conv-row][data-id="c-arch-1"]')).toBeVisible();

  // All archived conversations unarchived: empty prompt is displayed between top and bottom borders
  await expect(page.getByTestId('next-archived-empty')).toBeVisible();
  await expect(page.getByTestId('next-archived-empty')).toHaveText('没有归档的对话');
  const archSec = page.getByTestId('next-sidebar-archived-section');
  const archSecBox = await archSec.boundingBox();
  const sideBox = await page.getByTestId('next-sidebar').boundingBox();
  expect(archSecBox).toBeTruthy();
  expect(sideBox).toBeTruthy();
  expect(Math.abs(archSecBox.x - sideBox.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(archSecBox.width - sideBox.width)).toBeLessThanOrEqual(0.5);
  expect(parseFloat(await archSec.evaluate((el) => window.getComputedStyle(el).borderTopWidth))).toBeCloseTo(1, 0);

  // 3. Delete flow: cancel leaves conversation unchanged; confirm deletes it;
  // deleting current conversation jumps to draft page
  const delTarget = page.locator('[data-testid=next-conv-row][data-id="c-truncated"]');
  await delTarget.click();
  await delTarget.click({ button: 'right' });

  const deleteItem = page.getByTestId('next-ctx-menu').locator('[data-action="delete"]');
  await expect(deleteItem).toHaveText('删除');
  await expect(deleteItem).toBeEnabled();
  await deleteItem.click();

  // Confirm dialog appears
  const confirmDialog = page.getByTestId('next-confirm');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.locator('h3')).toContainText('删除对话？');
  await expect(page.getByTestId('next-confirm-message')).toContainText('的记录和历史会被删除，无法恢复。工作区里的文件不受影响。');

  // Cancel deletion
  await page.getByTestId('next-confirm-cancel').click();
  await expect(confirmDialog).toHaveCount(0);
  await expect(delTarget).toBeVisible();

  // Delete and confirm
  await delTarget.click({ button: 'right' });
  await page.getByTestId('next-ctx-menu').locator('[data-action="delete"]').click();
  await page.getByTestId('next-confirm-ok').click();

  // Toast appears; conversation removed
  await expect(page.getByTestId('next-toast')).toContainText('已删除');
  await expect(page.locator('[data-testid=next-conv-row][data-id="c-truncated"]')).toHaveCount(0);
  // Navigated to draft
  await expect(page).toHaveURL(/\/w\/ws-weft\/new/);

  // 4. Running conversation (c-rich is seeded as running): archive and delete are disabled with hover hint
  const runningConv = page.locator('[data-testid=next-conv-row][data-id="c-rich"]');
  await expect(runningConv).toBeVisible();
  await runningConv.click({ button: 'right' });

  const runningCtx = page.getByTestId('next-ctx-menu');
  await expect(runningCtx).toBeVisible();
  await expect(runningCtx.locator('[data-action="stop"]')).toBeVisible();

  const disabledArchive = runningCtx.locator('[data-action="archive"]');
  await expect(disabledArchive).toBeDisabled();
  await expect(disabledArchive).toHaveAttribute('title', '先停止对话');

  const disabledDelete = runningCtx.locator('[data-action="delete"]');
  await expect(disabledDelete).toBeDisabled();
  await expect(disabledDelete).toHaveAttribute('title', '先停止对话');

  // Close context menu
  await page.keyboard.press('Escape');

  await expectClean(state);
});
