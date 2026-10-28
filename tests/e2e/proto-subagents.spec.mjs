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
  // A tree with a live agent starts open; clicking the orbit does not toggle, clicking the toggle chevron toggles it.
  const chip = page.getByTestId('next-subagent-chip').first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('3/5');
  const tree = page.getByTestId('next-subagent-tree').first();
  await expect(tree).toHaveClass(/is-open/);
  await expect(page.getByTestId('next-subagent-row')).toHaveCount(5);

  // Requirement 3: Orbit animation is non-clickable (clicking does not collapse list)
  const orbit = chip.getByTestId('next-subagent-orbit');
  await orbit.click();
  await expect(tree).toHaveClass(/is-open/);

  // Separate toggle button collapses and expands list
  const toggleBtn = chip.getByTestId('next-subagent-toggle');
  await toggleBtn.click();
  await expect(tree).not.toHaveClass(/is-open/);
  await toggleBtn.click();
  await expect(tree).toHaveClass(/is-open/);
  await expect(page.getByTestId('next-subagent-row').evaluateAll(
    (rows) => rows.map((row) => row.dataset.status),
  )).resolves.toEqual(['running', 'stuck', 'done', 'waiting', 'failed']);
  await expect(page.getByTestId('next-subagent-action')).toHaveCount(0);
  await expect(page.getByTestId('next-subagent-time')).toHaveCount(0);

  // Non-current conversation: chip only until clicked; current tree stays open when leaving.
  const docsChip = page.locator('[data-testid=next-conv-row][data-id="c-docs"]').getByTestId('next-subagent-chip');
  await expect(docsChip).toHaveText(/3/);
  await expect(docsChip).not.toHaveClass(/is-live/);
  const docsToggle = docsChip.getByTestId('next-subagent-toggle');
  await expect(docsToggle).toHaveAttribute('aria-expanded', 'false');
  await docsToggle.click();
  await expect(docsToggle).toHaveAttribute('aria-expanded', 'true');
  const docsTree = page.locator('[data-testid=next-subagent-tree][data-conv-id="c-docs"]');
  await expect(docsTree.getByTestId('next-subagent-row')).toHaveCount(3);
  await expect(docsTree.getByTestId('next-subagent-row').first()).toHaveAttribute('data-visual', 'done');
  await expect(docsTree.getByTestId('next-subagent-time')).toHaveCount(0);

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

  // Opening the running subagent shows its process in the right pane; center stays the main chat.
  const title = await page.locator('.col-center .top-title').innerText();
  await page.getByTestId('next-subagent-row').first().click();
  await expect(page).toHaveURL(/\/a\//);
  await expect(page.getByTestId('next-center')).toBeVisible();
  await expect(page.locator('.col-center .top-title')).toHaveText(title);
  await expect(page.getByTestId('next-right-tab-subagents')).toHaveClass(/active/);
  await expect(page.getByTestId('next-right-tab-subagents')).toContainText('5');
  const view = page.getByTestId('next-subagent-view');
  await expect(view).toBeVisible();
  await expect(view.getByTestId('next-subagent-status')).toContainText('运行中');
  await expect(view.getByTestId('next-tool-group')).toHaveCount(1);

  await page.getByTestId('next-subagent-input').fill('顺便核对一下 diff 的行号');
  await page.getByTestId('next-subagent-send').click();
  await expect(view.getByTestId('next-item-user').last()).toContainText('diff 的行号');
  await expect(page.getByTestId('next-subagent-stop')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByTestId('next-subagent-stop').click();
  await expect(page.getByTestId('next-subagent-stop')).toHaveCount(0);
  await expect(view.getByTestId('next-subagent-status')).toContainText('已停止');

  // Breadcrumb returns to the overview; the failed report opens its detail in the right pane.
  await page.getByTestId('next-subagent-back').click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);
  await expect(page.getByTestId('next-subagent-overview')).toBeVisible();
  await expect(page.getByTestId('next-subagent-card')).toHaveCount(5);
  await failed.getByTestId('next-report-open').click();
  await expect(page.getByTestId('next-subagent-view')).toBeVisible();
  await expect(page.getByTestId('next-subagent-view').getByTestId('next-subagent-status')).toContainText('失败');
  await expect(page.getByTestId('next-subagent-view').getByTestId('next-tool-row-status').first()).toContainText('失败');

  await page.locator('[data-testid=next-conv-row][data-id="c-rich"]').click();
  await expect(page.getByTestId('next-right-tab-changes')).toHaveClass(/active/);
  await expect(page.getByTestId('next-subagent-view')).toHaveCount(0);
  await expect(page.getByTestId('next-subagent-overview')).toHaveCount(0);

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
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 40_000 });
  await expect(page.getByTestId('next-send')).toBeVisible();
  const cid = page.url().split('/c/')[1];
  await expect(page.locator(`[data-testid=next-conv-row][data-id="${cid}"]`)).toHaveCount(1);

  await page.getByTestId('next-subagent-report-summary').last().click();
  await expect(page.getByTestId('next-subagent-report-body').last()).toContainText('变更列表');

  // The report opens the subagent's thread in the right pane; the main chat stays.
  await page.getByTestId('next-report-open').last().click();
  await expect(page.getByTestId('next-center')).toBeVisible();
  await expect(page.getByTestId('next-subagent-view')).toBeVisible();
  await expect(page.getByTestId('next-subagent-view').getByTestId('next-subagent-status')).toContainText('完成');
  await expect(page.getByTestId('next-subagent-view').getByTestId('next-markdown').last()).toContainText('变更列表');

  expectClean(state);
});

test('subagent tab overview, breadcrumb switcher, and deep link', async ({ page }) => {
  const state = await openProto(page);

  await expect(page.getByTestId('next-right-tab-subagents')).toBeVisible();
  await page.getByTestId('next-right-tab-subagents').click();
  await expect(page.getByTestId('next-subagent-overview')).toBeVisible();
  await expect(page.getByTestId('next-center')).toBeVisible();
  await expect(page.getByTestId('next-subagent-card')).toHaveCount(5);

  await page.getByTestId('next-subagent-card').nth(1).click();
  await expect(page).toHaveURL(/\/a\//);
  await expect(page.getByTestId('next-subagent-view')).toBeVisible();
  await expect(page.getByTestId('next-subagent-switch')).toBeVisible();
  await page.getByTestId('next-subagent-switch').click();
  await expect(page.getByTestId('next-subagent-menu')).toBeVisible();
  const items = page.getByTestId('next-subagent-menu-item');
  await expect(items).toHaveCount(5);
  const targetId = await items.nth(2).getAttribute('data-agent-id');
  await items.nth(2).click();
  await expect.poll(() => decodeURIComponent(page.url())).toMatch(new RegExp(`/a/${targetId}$`));
  await expect(page.getByTestId('next-subagent-menu')).toHaveCount(0);
  await expect(page.getByTestId('next-center')).toBeVisible();

  await page.locator('[data-testid=next-conv-row][data-id="c-tests"]').click();
  await expect(page.getByTestId('next-right-tab-changes')).toHaveClass(/active/);
  await expect(page.getByTestId('next-right-tab-subagents')).toHaveCount(0);

  await page.evaluate(() => { window.location.hash = '#/c/c-rich/a/c-rich:sub:sa-1'; });
  await expect(page.getByTestId('next-subagent-view')).toBeVisible();
  await expect(page.getByTestId('next-subagent-view')).toContainText('核对 store.ts');
  await expect(page.getByTestId('next-center')).toBeVisible();
  await expect(page.getByTestId('next-right-tab-subagents')).toHaveClass(/active/);

  expectClean(state);
});
