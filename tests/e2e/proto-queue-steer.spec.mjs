import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('running composer has no status line, subs button or hints, and shows queue chip and git chip', async ({ page }) => {
  const state = await openProto(page);
  await expect(page).toHaveURL(/#\/c\/c-rich$/);
  await expect(page.getByTestId('next-composer-input')).toHaveAttribute('placeholder', '补充说明……');
  await expect(page.getByTestId('next-composer-run')).toHaveCount(0);
  await expect(page.getByTestId('next-composer-subs')).toHaveCount(0);
  await expect(page.getByTestId('next-composer-sub-pop')).toHaveCount(0);
  await expect(page.getByTestId('next-composer-newline')).toHaveCount(0);
  await expect(page.getByTestId('next-queue-chip')).toContainText('顺便把深色模式也检查一下');
  await expect(page.getByTestId('next-stop')).toBeVisible();

  // Composer git chip in running conversation
  const gitChip = page.getByTestId('next-composer-git');
  await expect(gitChip).toBeVisible();
  await expect(page.getByTestId('next-composer-git-branch')).toHaveText('main');
  await expect(page.getByTestId('next-composer-git-ins')).toHaveText('+42');
  await expect(page.getByTestId('next-composer-git-del')).toHaveText('−7');
  await expect(page.getByTestId('next-composer-git-ahead')).toHaveText('↑2');
  await expect(gitChip).toHaveAttribute('title', '分支 main · 未提交 +42 −7 · 领先远端 2 个提交');
  await expectClean(state);
});

test('composer git chip displays correctly in draft view and switches with workspace', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  await expect(page).toHaveURL(/#\/w\/ws-weft\/new$/);

  const gitChip = page.getByTestId('next-composer-git');
  await expect(gitChip).toBeVisible();
  await expect(page.getByTestId('next-composer-git-branch')).toHaveText('main');
  await expect(page.getByTestId('next-composer-git-ins')).toHaveText('+42');
  await expect(page.getByTestId('next-composer-git-del')).toHaveText('−7');
  await expect(page.getByTestId('next-composer-git-ahead')).toHaveText('↑2');
  await expect(gitChip).toHaveAttribute('title', '分支 main · 未提交 +42 −7 · 领先远端 2 个提交');

  // Switch to website workspace
  await page.getByTestId('next-ws-chip').click();
  await page.locator('[data-testid=next-ws-chip-option][data-id="ws-website"]').click();
  await expect(page).toHaveURL(/#\/w\/ws-website\/new$/);

  // In ws-website, branch is feat/landing-page, +18 -4, ahead is 0 (so no ahead pill)
  await expect(page.getByTestId('next-composer-git-branch')).toHaveText('feat/landing-page');
  await expect(page.getByTestId('next-composer-git-ins')).toHaveText('+18');
  await expect(page.getByTestId('next-composer-git-del')).toHaveText('−4');
  await expect(page.getByTestId('next-composer-git-ahead')).toHaveCount(0);
  await expect(gitChip).toHaveAttribute('title', '分支 feat/landing-page · 未提交 +18 −4');
  await expectClean(state);
});

test('plus menu opens, inserts @ reference, handles Esc and outside click', async ({ page }) => {
  const state = await openProto(page);
  const attachBtn = page.getByTestId('next-composer-attach');
  const plusMenu = page.getByTestId('next-composer-plus-menu');
  const input = page.getByTestId('next-composer-input');

  // Initially closed
  await expect(plusMenu).toHaveCount(0);

  // Open menu
  await attachBtn.click();
  await expect(plusMenu).toBeVisible();
  await expect(page.getByTestId('next-composer-plus-image')).toBeVisible();
  await expect(page.getByTestId('next-composer-plus-at')).toBeVisible();

  // Esc closes
  await page.keyboard.press('Escape');
  await expect(plusMenu).toHaveCount(0);

  // Open again, outside click closes
  await attachBtn.click();
  await expect(plusMenu).toBeVisible();
  await page.getByTestId('next-center').click({ position: { x: 50, y: 50 } });
  await expect(plusMenu).toHaveCount(0);

  // Open again, click "引用项目里的文件"
  await attachBtn.click();
  await expect(plusMenu).toBeVisible();
  await page.getByTestId('next-composer-plus-at').click();
  await expect(plusMenu).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('@');

  // Clicking "图片" triggers file chooser
  await attachBtn.click();
  await expect(plusMenu).toBeVisible();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('next-composer-plus-image').click();
  const fileChooser = await fileChooserPromise;
  expect(fileChooser.isMultiple()).toBe(true);
  await expect(plusMenu).toHaveCount(0);

  await expectClean(state);
});

test('prototype Enter steers, Alt+Enter queues, withdraw and edit work', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  await page.getByTestId('next-composer-input').fill('改一下 store');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-stop')).toBeVisible({ timeout: 10_000 });

  const input = page.getByTestId('next-composer-input');
  await input.fill('插一句');
  await input.press('Enter');
  const steered = page.getByTestId('next-item-user').filter({ hasText: '插一句' });
  await expect(steered.getByTestId('next-steer-hint')).toBeVisible();
  await expect(steered.getByTestId('next-steer-hint')).toHaveCount(0, { timeout: 20_000 });

  await input.fill('排队这条');
  await input.press('Alt+Enter');
  await expect(page.getByTestId('next-queue-chip')).toContainText('排队这条');
  await expect(page.getByTestId('next-item-user').filter({ hasText: '排队这条' })).toHaveCount(0);

  await page.getByTestId('next-queue-edit').click();
  await expect(page.getByTestId('next-queue-chip')).toHaveCount(0);
  await expect(input).toHaveValue('排队这条');

  await input.press('Alt+Enter');
  await expect(page.getByTestId('next-queue-chip')).toBeVisible();
  await page.getByTestId('next-queue-dismiss').click();
  await expect(page.getByTestId('next-queue-chip')).toHaveCount(0);

  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 40_000 });
  await expect(page.getByTestId('next-send')).toBeVisible();
  await expect(page.getByTestId('next-item-user').filter({ hasText: '排队这条' })).toHaveCount(0);
  await expectClean(state);
});
