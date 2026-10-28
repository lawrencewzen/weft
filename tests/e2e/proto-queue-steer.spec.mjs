import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('seeded running composer shows status, queue chip and sub-agent popover', async ({ page }) => {
  const state = await openProto(page);
  await expect(page).toHaveURL(/#\/c\/c-rich$/);
  await expect(page.getByTestId('next-composer-input')).toHaveAttribute('placeholder', '补充说明……');
  await expect(page.getByTestId('next-composer-run')).toBeVisible();
  await expect(page.getByTestId('next-composer-run')).toContainText('正在编辑');
  await expect(page.getByTestId('next-composer-run')).toContainText('第');
  await expect(page.getByTestId('next-queue-chip')).toContainText('顺便把深色模式也检查一下');
  await expect(page.getByTestId('next-composer-newline')).toHaveText('Enter 插话 · Alt+Enter 排队');
  await expect(page.getByTestId('next-composer-subs')).toContainText('个子 Agent 在跑');

  await page.getByTestId('next-composer-subs').click();
  await expect(page.getByTestId('next-composer-sub-pop')).toBeVisible();
  await expect(page.getByTestId('next-composer-sub-row')).toHaveCount(2);
  await page.getByTestId('next-composer-sub-row').first().click();
  await expect(page).toHaveURL(/\/a\//);
  await expect(page.getByTestId('next-right-tab-subagents')).toHaveClass(/active/);
  await expect(page.getByTestId('next-subagent-view')).toBeVisible();
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

  await expect(page.getByTestId('next-run-status')).toHaveText('完成', { timeout: 40_000 });
  await expect(page.getByTestId('next-item-user').filter({ hasText: '排队这条' })).toHaveCount(0);
  await expectClean(state);
});
