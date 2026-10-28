import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

/**
 * Subagents: the seeded tree with one agent in each state, the subagent view
 * (messages + stop), the two report cards in the parent thread, and a run that
 * spawns a subagent from a chat message.
 */
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('seeded subagent tree, report cards, messages and stop', async ({ page }) => {
  const state = await openProto(page);

  // c-rich carries five subagents: running, stuck, done, waiting and failed.
  // A tree with a live agent starts open; the chip toggles it closed and open.
  const chip = page.getByTestId('next-subagent-chip').first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('3/5');
  const tree = page.getByTestId('next-subagent-tree').first();
  await expect(tree).toHaveClass(/is-open/);
  await expect(page.getByTestId('next-subagent-row')).toHaveCount(5);
  await chip.click();
  await expect(tree).not.toHaveClass(/is-open/);
  await chip.click();
  await expect(tree).toHaveClass(/is-open/);
  await expect(page.getByTestId('next-subagent-row').evaluateAll(
    (rows) => rows.map((row) => row.dataset.status),
  )).resolves.toEqual(['running', 'stuck', 'done', 'waiting', 'failed']);
  await expect(page.getByTestId('next-subagent-action').first()).toHaveText(/正在读取 web\/src\/data\/store\.ts/);
  await expect(page.getByTestId('next-subagent-action').first()).not.toHaveText(/`/);
  await expect(page.getByTestId('next-subagent-row').nth(1).getByTestId('next-subagent-time')).toContainText('静默');

  // Non-current conversation: chip only until clicked; current tree stays open when leaving.
  const docsChip = page.locator('[data-testid=next-conv-row][data-id="c-docs"]').getByTestId('next-subagent-chip');
  await expect(docsChip).toHaveText(/3/);
  await expect(docsChip).not.toHaveClass(/is-live/);
  await expect(docsChip).toHaveAttribute('aria-expanded', 'false');
  await docsChip.click();
  await expect(docsChip).toHaveAttribute('aria-expanded', 'true');
  const docsTree = page.locator('[data-testid=next-subagent-tree][data-conv-id="c-docs"]');
  await expect(docsTree.getByTestId('next-subagent-row')).toHaveCount(3);
  await expect(docsTree.getByTestId('next-subagent-row').first()).toHaveAttribute('data-visual', 'done');
  await expect(docsTree.getByTestId('next-subagent-time').first()).toHaveText('');

  await page.locator('[data-testid=next-conv-row][data-id="c-tests"]').click();
  await expect(page).toHaveURL(/#\/c\/c-tests$/);
  await expect(tree).toHaveClass(/is-open/);
  await page.locator('[data-testid=next-conv-row][data-id="c-rich"]').click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);

  // Two report cards: one answered, one failed.
  await expect(page.getByTestId('next-item-subagent-report')).toHaveCount(2);
  const answered = page.getByTestId('next-item-subagent-report').first();
  const failed = page.getByTestId('next-item-subagent-report').last();
  await expect(answered.locator('.subagent-report-summary')).toContainText('交回结果');
  await expect(failed).toHaveClass(/is-failed/);
  await expect(failed.locator('.subagent-report-summary')).toContainText('失败');
  await answered.getByTestId('next-subagent-report-summary').click();
  await expect(answered.getByTestId('next-subagent-report-body')).toContainText('text.delta');

  // Opening the running subagent shows its own thread and composer.
  await page.getByTestId('next-subagent-row').first().click();
  await expect(page).toHaveURL(/\/a\//);
  await expect(page.getByTestId('next-subagent-view')).toBeVisible();
  await expect(page.getByTestId('next-run-status')).toContainText('运行中');
  await expect(page.getByTestId('next-tool-group')).toHaveCount(1);

  await page.getByTestId('next-composer-input').fill('顺便核对一下 diff 的行号');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-item-user').last()).toContainText('diff 的行号');
  await expect(page.getByTestId('next-stop')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByTestId('next-stop').click();
  await expect(page.getByTestId('next-stop')).toHaveCount(0);
  await expect(page.getByTestId('next-run-status')).toContainText('已停止');

  // Back to the parent conversation; the failed report opens its subagent view.
  await page.getByTestId('next-subagent-back').click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);
  await failed.getByTestId('next-report-open').click();
  await expect(page.getByTestId('next-subagent-view')).toBeVisible();
  await expect(page.getByTestId('next-run-status')).toContainText('失败');
  await expect(page.getByTestId('next-tool-row-status').first()).toContainText('失败');

  expectClean(state);
});

test('a message spawns a subagent and its report lands in the thread', async ({ page }) => {
  const state = await openProto(page);

  await expect(page.getByTestId('next-conv-row').first()).toBeVisible();
  await page.getByTestId('next-new-chat').click();
  await page.getByTestId('next-composer-input').fill('派个子 Agent 核对一下右栏的变更列表');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-stop')).toBeVisible({ timeout: 10_000 });

  // The subagent appears in the sidebar while it runs, then reports back.
  await expect(page.getByTestId('next-subagent-chip').last()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('next-item-subagent-report').last()).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('next-run-status')).toHaveText('完成', { timeout: 40_000 });
  const cid = page.url().split('/c/')[1];
  await expect(page.locator(`[data-testid=next-conv-row][data-id="${cid}"]`)).toHaveCount(1);

  await page.getByTestId('next-subagent-report-summary').last().click();
  await expect(page.getByTestId('next-subagent-report-body').last()).toContainText('变更列表');

  // The report opens the subagent's own thread and it is finished there.
  await page.getByTestId('next-report-open').last().click();
  await expect(page.getByTestId('next-subagent-view')).toBeVisible();
  await expect(page.getByTestId('next-run-status')).toContainText('完成');
  await expect(page.getByTestId('next-markdown').last()).toContainText('变更列表');

  expectClean(state);
});
