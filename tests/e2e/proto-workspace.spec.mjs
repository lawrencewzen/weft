import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

/**
 * Workspace addition flow:
 * 1. Native pick dialog preferred (simulated modal in prototype).
 *    - Picked: directly enters new workspace without form.
 *    - Cancelled: no change.
 * 2. Directory browser fallback (unsupported / network failure):
 *    - Clickable breadcrumbs to navigate up.
 *    - Editable path input: Enter to jump, inline error on failure.
 *    - Blocked path (e.g. ~/.ssh): create button disabled.
 *    - Newly opened: create button disabled until navigated.
 * 3. Git import tab is hidden for now.
 */
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('system folder pick: picked directly enters new workspace, cancelled does nothing', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.getByTestId('next-ws-node')).toHaveCount(2);

  // 1. Cancelled -> no changes
  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('proto-pick-modal')).toBeVisible();
  await expect(page.getByTestId('proto-pick-modal')).toContainText('系统选文件夹窗口（原型模拟）');
  await page.getByTestId('proto-pick-cancel').click();
  await expect(page.getByTestId('proto-pick-modal')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-dialog')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-node')).toHaveCount(2);

  // 2. Picked -> directly enters without form
  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('proto-pick-modal')).toBeVisible();
  await expect(page.getByTestId('proto-pick-path')).toHaveValue('D:\\work\\sandbox\\playground');
  await page.getByTestId('proto-pick-folder').click();

  await expect(page.getByTestId('proto-pick-modal')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-dialog')).toHaveCount(0);
  await expect(page.getByTestId('next-toast')).toContainText('已创建');
  await expect(page.getByTestId('next-ws-node')).toHaveCount(3);
  await expect(page.getByTestId('next-ws-node').filter({ hasText: 'playground' })).toBeVisible();
  await expect(page).toHaveURL(/\/w\/ws-\d+\/new/);
  await expect(page.getByTestId('next-draft-hint')).toContainText('playground');
  await expect(page.getByTestId('next-draft-hero-ws')).toContainText('playground');
  await expect(page.locator('.draft-hero-hint')).toContainText('playground');

  // The new workspace takes conversations.
  await page.getByTestId('next-composer-input').fill('这个工作区里第一条消息');
  await page.getByTestId('next-send').click();
  await expect(page).toHaveURL(/\/c\/c-\d+/);
  await expect(page.getByTestId('next-item-user')).toContainText('这个工作区里第一条消息');
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 40_000 });
  await expect(page.getByTestId('next-send')).toBeVisible();
  const wsId = await page.getByTestId('next-ws-node').filter({ hasText: 'playground' }).getAttribute('data-id');
  await expect(page.locator(`[data-testid=next-conv-row][data-ws-id="${wsId}"]`)).toHaveCount(1);

  // The new workspace has its own mock repository in the file tab.
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.locator('[data-testid=next-file-node][data-path="README.md"]')).toBeVisible();

  expectClean(state);
});

test('unsupported pick opens directory browser, supports breadcrumbs, path jumping, and blocked directories', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.getByTestId('next-ws-node')).toHaveCount(2);

  // Unsupported -> fallback to directory browser
  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('proto-pick-modal')).toBeVisible();
  await page.getByTestId('proto-pick-unsupported').click();

  await expect(page.getByTestId('proto-pick-modal')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();

  // Acceptance 3: No Git tabs, no "allowed root" copy
  await expect(page.getByTestId('next-ws-tab-git')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-tab-local')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-name')).toHaveCount(0);
  const dialogText = await page.getByTestId('next-ws-dialog').innerText();
  expect(dialogText).not.toContain('allowed root');
  expect(dialogText).not.toContain('允许的根目录');

  // Acceptance 2: Newly opened -> create disabled
  await expect(page.getByTestId('next-ws-create')).toBeDisabled();

  // Folder entries and Git badge
  await expect(page.getByTestId('next-dir-row')).toHaveCount(4);
  const weftRow = page.getByTestId('next-dir-row').filter({ hasText: 'weft' });
  await expect(weftRow.getByTestId('next-dir-git-badge')).toContainText('Git');

  // Single click row to enter
  await page.getByTestId('next-dir-row').filter({ hasText: 'sandbox' }).click();
  await expect(page.getByTestId('next-dir-row')).toHaveCount(2);
  await expect(page.getByTestId('next-ws-path')).toHaveValue('D:\\work\\sandbox');
  await expect(page.getByTestId('next-ws-create')).toBeEnabled();

  // Breadcrumbs: click "work" to navigate up
  const workCrumb = page.getByTestId('next-breadcrumb-item').filter({ hasText: 'work' });
  await expect(workCrumb).toBeVisible();
  await workCrumb.click();
  await expect(page.getByTestId('next-dir-row')).toHaveCount(4);
  await expect(page.getByTestId('next-ws-path')).toHaveValue('D:\\work');

  // Path input Enter with invalid path -> inline error
  await page.getByTestId('next-ws-path').fill('D:\\nonexistent-folder');
  await page.getByTestId('next-ws-path').press('Enter');
  await expect(page.getByTestId('next-ws-dir-error')).toBeVisible();

  // Enter blocked path ~/.ssh -> create disabled
  await page.getByTestId('next-ws-path').fill('~/.ssh');
  await page.getByTestId('next-ws-path').press('Enter');
  await expect(page.getByTestId('next-ws-path')).toHaveValue('~\\.ssh');
  await expect(page.getByTestId('next-ws-create')).toBeDisabled();

  // Enter valid path and create
  await page.getByTestId('next-ws-path').fill('D:\\work\\sandbox\\playground');
  await page.getByTestId('next-ws-path').press('Enter');
  await expect(page.getByTestId('next-ws-create')).toBeEnabled();

  await page.getByTestId('next-ws-create').click();
  await expect(page.getByTestId('next-ws-dialog')).toHaveCount(0);
  await expect(page.getByTestId('next-toast')).toContainText('已创建');
  await expect(page.getByTestId('next-ws-node')).toHaveCount(3);
  await expect(page.getByTestId('next-ws-node').filter({ hasText: 'playground' })).toBeVisible();

  expectClean(state);
});

test.skip('git import picks a project and a branch', async ({ page }) => {
  // Git 导入暂时隐藏
  const state = await openProto(page);
  await page.getByTestId('next-ws-new').click();
  await page.getByTestId('next-ws-tab-git').click();
  await expect(page.getByTestId('next-git-project')).toHaveCount(2);
  await page.getByTestId('next-git-project').first().click();
  await expect(page.getByTestId('next-git-branch')).toContainText('main');

  await page.getByTestId('next-git-branch').click();
  await expect(page.getByTestId('next-git-branch-pop')).toBeVisible();
  await page.locator('[data-testid=next-git-branch-pop] .ns-pop-item').filter({ hasText: 'develop' }).click();
  await expect(page.getByTestId('next-git-branch')).toContainText('develop');
  await expect(page.getByTestId('next-git-import-name')).toHaveValue('weft-deploy');

  await page.getByTestId('next-ws-create').click();
  await expect(page.getByTestId('next-toast')).toContainText('weft-deploy');
  await expect(page.getByTestId('next-ws-node')).toHaveCount(3);
  const node = page.getByTestId('next-ws-node').filter({ hasText: 'weft-deploy' });
  await expect(node).toBeVisible();
  await expect(node.getByTestId('next-ws-toggle')).toHaveAttribute('title', 'D:\\work\\weft-deploy');

  expectClean(state);
});
