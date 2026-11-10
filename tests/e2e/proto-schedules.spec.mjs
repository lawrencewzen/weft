import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

/**
 * Scheduled tasks (T124-1): Sidebar clock button, active schedules count badge,
 * schedules pane list, create/edit modal with validation (interval >= 5 min),
 * toggle pause/enable, immediate run trigger, expanded execution runs history,
 * and deletion confirmation.
 */
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('scheduled tasks: sidebar navigation, badge count, and empty footer note', async ({ page }) => {
  const state = await openProto(page);

  // 1. Sidebar has schedules entry with clock icon and enabled count badge (seeded: 3 enabled)
  const navBtn = page.getByTestId('next-schedules');
  await expect(navBtn).toBeVisible();
  const countBadge = page.getByTestId('next-schedules-count');
  await expect(countBadge).toHaveText('3');

  // 2. Click to navigate to #/schedules
  await navBtn.click();
  await expect(page).toHaveURL(/#\/schedules$/);
  await expect(navBtn).toHaveClass(/sel/);

  // 3. Middle pane renders schedules view
  const pane = page.getByTestId('next-schedules-pane');
  await expect(pane).toBeVisible();
  await expect(page.getByTestId('next-schedules-title')).toHaveText('定时任务');
  await expect(page.getByTestId('next-schedules-new')).toBeVisible();

  // 4. Seeded schedule rows: 4 items in total
  const rows = page.getByTestId('next-schedule-row');
  await expect(rows).toHaveCount(4);

  // 5. Agent-created badge on sched-2
  const agentRow = page.locator('[data-testid="next-schedule-row"][data-id="sched-2"]');
  await expect(agentRow.getByTestId('next-schedule-agent-badge')).toHaveText('Agent 创建');

  // 6. Footer note visible
  await expect(page.getByTestId('next-schedules-footer-note')).toContainText(
    'Weft 退出后定时任务不会执行，下次启动时补跑一次。',
  );

  expectClean(state);
});

test('scheduled tasks: toggle pause/enable updates status and sidebar count badge', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-schedules').click();
  await expect(page.getByTestId('next-schedules-count')).toHaveText('3');

  // sched-1 is enabled; toggle it off
  const sched1 = page.locator('[data-testid="next-schedule-row"][data-id="sched-1"]');
  const toggle1 = sched1.getByTestId('next-schedule-toggle');
  await expect(toggle1).toHaveClass(/is-on/);

  await toggle1.click();
  await expect(toggle1).not.toHaveClass(/is-on/);
  // Sidebar badge updates from 3 to 2
  await expect(page.getByTestId('next-schedules-count')).toHaveText('2');

  // Toggle it back on
  await toggle1.click();
  await expect(toggle1).toHaveClass(/is-on/);
  await expect(page.getByTestId('next-schedules-count')).toHaveText('3');

  expectClean(state);
});

test('scheduled tasks: interval rule validation blocks < 5 minutes', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-schedules').click();

  // Open create dialog
  await page.getByTestId('next-schedules-new').click();
  const dialog = page.getByTestId('next-schedule-dialog');
  await expect(dialog).toBeVisible();

  // Fill name & message
  await page.getByTestId('next-schedule-name-input').fill('间隔测试');
  await page.getByTestId('next-schedule-message-input').fill('执行高频监控');

  // Select interval rule
  await page.getByTestId('next-schedule-rule-interval').click();
  const intervalInput = page.getByTestId('next-schedule-interval-input');

  // Type 3 minutes (< 5 min)
  await intervalInput.fill('3');
  const err = page.getByTestId('next-schedule-err-interval');
  await expect(err).toBeVisible();
  await expect(err).toContainText('间隔不能少于 5 分钟');

  // Submit button should be disabled
  const submitBtn = page.getByTestId('next-schedule-submit');
  await expect(submitBtn).toBeDisabled();

  // Change to 5 minutes (valid)
  await intervalInput.fill('5');
  await expect(err).toHaveCount(0);
  await expect(submitBtn).toBeEnabled();

  // Cancel closes modal without saving
  await page.getByTestId('next-schedule-cancel').click();
  await expect(dialog).toHaveCount(0);

  expectClean(state);
});

test('scheduled tasks: create, immediate run, expand runs, and delete with confirm', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-schedules').click();

  // 1. Create a new weekly schedule
  await page.getByTestId('next-schedules-new').click();
  await page.getByTestId('next-schedule-name-input').fill('每周安全审计');
  await page.getByTestId('next-schedule-message-input').fill('请执行安全依赖检查并汇总报告');
  await page.getByTestId('next-schedule-rule-weekly').click();

  // Choose Target: new chat in first workspace
  await page.getByTestId('next-schedule-target-new').click();
  await page.getByTestId('next-schedule-submit').click();

  // Modal closes, new schedule appears in list (now 5 rows), badge updates to 4
  await expect(page.getByTestId('next-schedule-dialog')).toHaveCount(0);
  await expect(page.getByTestId('next-schedule-row')).toHaveCount(5);
  await expect(page.getByTestId('next-schedules-count')).toHaveText('4');
  await expect(page.locator('.schedules-list')).toContainText('每周安全审计');

  // Find the newly created schedule row
  const newRow = page.locator('[data-testid="next-schedule-row"]').filter({ hasText: '每周安全审计' });
  await expect(newRow).toBeVisible();

  // 2. Immediate run via "..." menu
  await newRow.getByTestId('next-schedule-more').click();
  const runMenuBtn = page.locator('[data-testid="next-ctx-item"][data-action="run"]');
  await expect(runMenuBtn).toBeVisible();
  await runMenuBtn.click();

  // Run triggered, toast shown, last run status badge becomes ok
  await expect(newRow.locator('.schedule-meta-last')).toContainText('成功');

  // 3. Expand recent runs drawer by clicking the row
  await newRow.click();
  const runsDrawer = newRow.getByTestId('next-schedule-runs');
  await expect(runsDrawer).toBeVisible();
  await expect(runsDrawer.getByTestId('next-schedule-run-item')).toHaveCount(1);

  // 4. Delete with confirm: cancel keeps the row, confirm removes it
  await newRow.getByTestId('next-schedule-more').click();
  const delMenuBtn = page.locator('[data-testid="next-ctx-item"][data-action="delete"]');
  await expect(delMenuBtn).toBeVisible();
  await delMenuBtn.click();

  // Confirm dialog opens
  const confirmDialog = page.getByTestId('next-confirm');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.getByTestId('next-confirm-message')).toContainText('每周安全审计');

  // Cancel deletion
  await page.getByTestId('next-confirm-cancel').click();
  await expect(confirmDialog).toHaveCount(0);
  await expect(page.getByTestId('next-schedule-row')).toHaveCount(5);

  // Re-open delete and confirm
  await newRow.getByTestId('next-schedule-more').click();
  await page.locator('[data-testid="next-ctx-item"][data-action="delete"]').click();
  await expect(confirmDialog).toBeVisible();
  await page.getByTestId('next-confirm-ok').click();

  // Row removed, count drops back to 4 rows (and 3 active)
  await expect(confirmDialog).toHaveCount(0);
  await expect(page.getByTestId('next-schedule-row')).toHaveCount(4);
  await expect(page.getByTestId('next-schedules-count')).toHaveText('3');
  await expect(page.locator('.schedules-list')).not.toContainText('每周安全审计');

  expectClean(state);
});
