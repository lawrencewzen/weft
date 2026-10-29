import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

/**
 * AgentsStrip: sub-agent status strip docked above Composer, with in-place expand,
 * stop, queued status, failed reasons, dispatch card linkage, and fadeout after completion.
 * Verifies right pane no longer contains a Sub-agents tab.
 */
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('status strip appearance, collapsed counts, expand, in-place details, and stop', async ({ page }) => {
  const state = await openProto(page);

  // 1. Visit c-rich: carries unended sub-agents (running, stuck, waiting)
  await page.locator('[data-testid=next-conv-row][data-id="c-rich"]').click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);

  // Status strip appears above composer
  const strip = page.getByTestId('next-agents-strip');
  await expect(strip).toBeVisible();

  // Right pane has NO subagent tab
  await expect(page.getByTestId('next-right-tab-subagents')).toHaveCount(0);
  await expect(page.getByTestId('next-right-tab-changes')).toBeVisible();

  // Collapsed strip displays summary counts and headline
  const toggle = page.getByTestId('next-agents-strip-toggle');
  await expect(toggle).toBeVisible();
  const headline = page.getByTestId('next-agents-strip-headline');
  await expect(headline).toContainText('运行中');
  await expect(headline).toContainText('排队');

  const expandBtn = page.getByTestId('next-agents-strip-expand');
  await expect(expandBtn).toContainText('展开');

  // Strip starts collapsed; list is not visible
  await expect(page.getByTestId('next-agents-strip-list')).toHaveCount(0);

  // 2. Click header to expand strip
  await toggle.click();
  await expect(strip).toHaveClass(/open/);
  await expect(expandBtn).toContainText('收起');
  const list = page.getByTestId('next-agents-strip-list');
  await expect(list).toBeVisible();

  const rows = page.getByTestId('next-agents-strip-row');
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(5);

  // Check rows: running row has elapsed time; done / failed row has no timer and no stop button
  const doneRow = page.locator('[data-testid="next-agents-strip-row"][data-agent-id="c-rich:sub:sa-2"]');
  await expect(doneRow).toBeVisible();
  await expect(doneRow.getByTestId('next-agents-strip-time')).toHaveText('');
  await expect(doneRow.getByTestId('next-agents-strip-stop')).toHaveCount(0);

  const failedRow = page.locator('[data-testid="next-agents-strip-row"][data-agent-id="c-rich:sub:sa-4"]');
  await expect(failedRow).toBeVisible();
  await expect(failedRow.getByTestId('next-agents-strip-time')).toHaveText('');
  await expect(failedRow.getByTestId('next-agents-strip-stop')).toHaveCount(0);
  await expect(failedRow.getByTestId('next-agents-strip-doing')).toContainText('没完成');

  // 3. In-place expansion
  // (a) Queued row: shows "还没开始"
  const waitRow = page.locator('[data-testid="next-agents-strip-row"][data-agent-id="c-rich:sub:sa-3"]');
  await expect(waitRow).toBeVisible();
  await waitRow.click();
  const waitItem = page.locator('.agents-strip-item[data-agent-id="c-rich:sub:sa-3"]');
  await expect(waitItem.getByTestId('next-agents-strip-detail-text')).toContainText('还没开始');

  // (b) Done row: shows result summary
  await doneRow.click();
  const doneItem = page.locator('.agents-strip-item[data-agent-id="c-rich:sub:sa-2"]');
  await expect(doneItem.getByTestId('next-agents-strip-detail-text')).toContainText('text.delta');

  // (c) Failed row: shows failure reason read-only
  await failedRow.click();
  const failedItem = page.locator('.agents-strip-item[data-agent-id="c-rich:sub:sa-4"]');
  await expect(failedItem.getByTestId('next-agents-strip-detail-text')).toContainText('PowerShell');
  // Read-only: no input box
  await expect(failedItem.locator('input')).toHaveCount(0);
  await expect(failedItem.locator('textarea')).toHaveCount(0);

  // (d) Running row: shows recent steps
  const runRow = page.locator('[data-testid="next-agents-strip-row"][data-agent-id="c-rich:sub:sa-1"]');
  await expect(runRow).toBeVisible();
  await runRow.click();
  const runItem = page.locator('.agents-strip-item[data-agent-id="c-rich:sub:sa-1"]');
  await expect(runItem.getByTestId('next-agents-strip-step')).not.toHaveCount(0);

  // 4. Hovering on running row shows stop button; clicking stop stops it
  const stopBtn = runRow.getByTestId('next-agents-strip-stop');
  await expect(stopBtn).toBeAttached();
  await stopBtn.click();
  await expect(runRow).toHaveAttribute('data-status', 'stopped');

  expectClean(state);
});

test('dispatch card click opens status strip and focuses that subagent row', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-conv-row][data-id="c-rich"]').click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);

  const card = page.getByTestId('next-dispatch-card');
  await expect(card).toBeVisible();

  const strip = page.getByTestId('next-agents-strip');
  await expect(strip).toBeVisible();
  // Initially strip is collapsed
  await expect(strip).not.toHaveClass(/open/);

  // Click row 0 (sa-1) in dispatch card
  const dispatchRows = card.getByTestId('next-dispatch-row');
  await dispatchRows.nth(0).click();

  // Strip should now be expanded and the sa-1 row opened in-place
  await expect(strip).toHaveClass(/open/);
  const targetItem = page.locator('.agents-strip-item[data-agent-id="c-rich:sub:sa-1"]');
  await expect(targetItem).toHaveClass(/is-open/);
  await expect(targetItem.getByTestId('next-agents-strip-detail')).toBeVisible();

  // Subagent report open button in thread also focuses that row
  const reportOpen = page.getByTestId('next-report-open').first();
  if (await reportOpen.count()) {
    await reportOpen.click();
    await expect(strip).toHaveClass(/open/);
  }

  expectClean(state);
});

test('a message spawns a subagent, status strip shows running, then shows done and fades out', async ({ page }) => {
  const state = await openProto(page);

  await expect(page.getByTestId('next-conv-row').first()).toBeVisible();
  await page.getByTestId('next-new-chat').click();

  // Initially draft has no subagent strip
  await expect(page.getByTestId('next-agents-strip')).toHaveCount(0);

  await page.getByTestId('next-composer-input').fill('派个子 Agent 核对一下右栏的变更列表');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-stop')).toBeVisible({ timeout: 10_000 });

  // Status strip appears while the subagent runs
  const strip = page.getByTestId('next-agents-strip');
  await expect(strip).toBeVisible({ timeout: 20_000 });
  await expect(strip.getByTestId('next-agents-strip-headline')).toContainText('运行中');

  // After subagent finishes, report lands in thread and strip shows completed
  await expect(page.getByTestId('next-item-subagent-report').last()).toBeVisible({ timeout: 40_000 });
  await expect(strip.getByTestId('next-agents-strip-headline')).toContainText('已完成');

  // Within ~7-8 seconds, the strip fades out and disappears
  await expect(strip).toHaveCount(0, { timeout: 15_000 });

  expectClean(state);
});

test('switching between conversations never flashes loading or empty thread', async ({ page }) => {
  const state = await openProto(page);

  const richRow = page.locator('[data-testid=next-conv-row][data-id="c-rich"]');
  const gitRow = page.locator('[data-testid=next-conv-row][data-id="c-git"]');
  await expect(richRow).toBeVisible();
  await expect(gitRow).toBeVisible();

  await richRow.click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);
  await expect(page.locator('.msg-group')).not.toHaveCount(0);

  await gitRow.click();
  await expect(page).toHaveURL(/#\/c\/c-git$/);
  await expect(page.locator('.msg-group')).not.toHaveCount(0);

  // Switch back and forth 3 times
  for (let i = 0; i < 3; i++) {
    await richRow.click();
    await expect(page).toHaveURL(/#\/c\/c-rich$/);
    await gitRow.click();
    await expect(page).toHaveURL(/#\/c\/c-git$/);
  }

  expectClean(state);
});
