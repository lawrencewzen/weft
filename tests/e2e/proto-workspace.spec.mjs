import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

/**
 * Workspace addition flow:
 * 1. Clicking + always opens the dialog first (local path input focused).
 * 2. Browse… calls the (simulated) system folder picker:
 *    - Picked: fills the path, nothing is created until 确定.
 *    - Cancelled: dialog unchanged.
 * 3. Directory browser: breadcrumbs, editable path input (Enter to jump, inline
 *    error on failure), blocked path (~/.ssh) disables create.
 * 4. Git import tab is hidden for now.
 */
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('+ opens the dialog; Browse picks a folder (cancel keeps state) and only 确定 creates the workspace', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.getByTestId('next-ws-node')).toHaveCount(2);

  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();
  await expect(page.getByTestId('next-ws-path')).toBeFocused();
  await expect(page.getByTestId('next-ws-create')).toBeDisabled();

  // 1. Picked (first click) -> path filled, nothing created yet
  const browse = page.getByTestId('next-ws-browse');
  await browse.click();
  await expect(browse).toBeDisabled();
  await expect(page.getByTestId('next-ws-path')).toHaveValue('C:\\Users\\demo\\Projects\\billing-api');
  await expect(browse).toBeEnabled();
  await expect(page.getByTestId('next-ws-create')).toBeEnabled();
  await expect(page.getByTestId('next-ws-node')).toHaveCount(2);

  // 2. Cancelled (second click) -> unchanged
  await browse.click();
  await expect(browse).toBeDisabled();
  await expect(browse).toBeEnabled();
  await expect(page.getByTestId('next-ws-path')).toHaveValue('C:\\Users\\demo\\Projects\\billing-api');
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();
  await expect(page.getByTestId('next-ws-node')).toHaveCount(2);

  // 3. 确定 creates and enters the workspace
  await page.getByTestId('next-ws-create').click();
  await expect(page.getByTestId('next-ws-dialog')).toHaveCount(0);
  await expect(page.getByTestId('next-toast')).toContainText('已创建');
  await expect(page.getByTestId('next-ws-node')).toHaveCount(3);
  await expect(page.getByTestId('next-ws-node').filter({ hasText: 'billing-api' })).toBeVisible();
  await expect(page).toHaveURL(/\/w\/ws-\d+\/new/);
  await expect(page.getByTestId('next-draft-hint')).toContainText('billing-api');
  await expect(page.getByTestId('next-draft-hero-ws')).toContainText('billing-api');
  await expect(page.locator('.draft-hero-hint')).toContainText('billing-api');

  // The new workspace takes conversations.
  await page.getByTestId('next-composer-input').fill('这个工作区里第一条消息');
  await page.getByTestId('next-send').click();
  await expect(page).toHaveURL(/\/c\/c-\d+/);
  await expect(page.getByTestId('next-item-user')).toContainText('这个工作区里第一条消息');
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 40_000 });
  await expect(page.getByTestId('next-send')).toBeVisible();
  const wsId = await page.getByTestId('next-ws-node').filter({ hasText: 'billing-api' }).getAttribute('data-id');
  await expect(page.locator(`[data-testid=next-conv-row][data-ws-id="${wsId}"]`)).toHaveCount(1);

  // The new workspace has its own mock repository in the file tab.
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.locator('[data-testid=next-file-node][data-path="README.md"]')).toBeVisible();

  expectClean(state);
});

test('directory browser supports breadcrumbs, path jumping, and blocked directories', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.getByTestId('next-ws-node')).toHaveCount(2);

  await page.getByTestId('next-ws-new').click();
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

test('T101-4b Acceptance 1: from D:\\work click breadcrumb This PC to see C: and D:, enter C:\\ and continue into Projects, create takes effect on current directory with correct name', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();

  // Initially at D:\work
  await expect(page.getByTestId('next-ws-path')).toHaveValue('D:\\work');

  // Breadcrumbs: click "此电脑"
  const thisPcCrumb = page.getByTestId('next-breadcrumb-item').filter({ hasText: '此电脑' });
  await expect(thisPcCrumb).toBeVisible();
  await thisPcCrumb.click();

  // Sees C: and D: drives
  await expect(page.getByTestId('next-dir-row')).toHaveCount(2);
  const cRow = page.getByTestId('next-dir-row').filter({ hasText: 'C:' });
  const dRow = page.getByTestId('next-dir-row').filter({ hasText: 'D:' });
  await expect(cRow).toBeVisible();
  await expect(dRow).toBeVisible();

  // Click C: to enter C:\
  await cRow.click();
  await expect(page.getByTestId('next-ws-path')).toHaveValue('C:\\');
  await expect(page.getByTestId('next-ws-create')).toBeDisabled(); // Drive root is not selectable

  // Under C:\, see Projects and Windows
  const projectsRow = page.getByTestId('next-dir-row').filter({ hasText: 'Projects' });
  await expect(projectsRow).toBeVisible();

  // Click Projects to continue entering
  await projectsRow.click();
  await expect(page.getByTestId('next-ws-path')).toHaveValue('C:\\Projects');
  await expect(page.getByTestId('next-ws-create')).toBeEnabled();

  // Create takes effect on current directory (C:\Projects), name is "Projects"
  await page.getByTestId('next-ws-create').click();
  await expect(page.getByTestId('next-ws-dialog')).toHaveCount(0);
  await expect(page.getByTestId('next-toast')).toContainText('Projects');
  await expect(page.getByTestId('next-ws-node')).toHaveCount(3);
  await expect(page.getByTestId('next-ws-node').filter({ hasText: 'Projects' })).toBeVisible();

  expectClean(state);
});

test('T101-4b Acceptance 2: in drives view, create is disabled, path input is empty, pasting path and pressing Enter jumps', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();

  // Click "此电脑" to enter drives view
  const thisPcCrumb = page.getByTestId('next-breadcrumb-item').filter({ hasText: '此电脑' });
  await thisPcCrumb.click();

  // Create button is disabled
  await expect(page.getByTestId('next-ws-create')).toBeDisabled();

  // Path input is empty and editable
  const pathInput = page.getByTestId('next-ws-path');
  await expect(pathInput).toHaveValue('');
  await expect(pathInput).not.toHaveAttribute('readonly', '');
  await expect(pathInput).toBeEnabled();

  // Breadcrumbs only has "此电脑"
  await expect(page.getByTestId('next-breadcrumb-item')).toHaveCount(1);
  await expect(page.getByTestId('next-breadcrumb-item')).toHaveText('此电脑');

  // Paste path and press Enter to jump
  await pathInput.fill('D:\\work\\sandbox');
  await pathInput.press('Enter');

  await expect(page.getByTestId('next-ws-path')).toHaveValue('D:\\work\\sandbox');
  await expect(page.getByTestId('next-breadcrumb-item').filter({ hasText: 'sandbox' })).toBeVisible();
  await expect(page.getByTestId('next-ws-create')).toBeEnabled();

  expectClean(state);
});

test('T101-4b Acceptance 3: non-Windows paths do not show "此电脑" in breadcrumbs', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();

  // The dialog fills the path from the first directory listing. Wait for that
  // write to finish; typing earlier is replaced by the default D:\work.
  const pathInput = page.getByTestId('next-ws-path');
  await expect(pathInput).toHaveValue('D:\\work');
  await pathInput.fill('~/.ssh');
  await pathInput.press('Enter');

  await expect(pathInput).toHaveValue('~\\.ssh');
  // Breadcrumbs do not contain "此电脑"
  await expect(page.getByTestId('next-breadcrumb-item').filter({ hasText: '此电脑' })).toHaveCount(0);
  await expect(page.getByTestId('next-breadcrumb-item').filter({ hasText: '~' })).toBeVisible();

  // Enter POSIX path /Users/alice
  await pathInput.fill('/Users/alice');
  await pathInput.press('Enter');

  await expect(pathInput).toHaveValue('/Users/alice');
  await expect(page.getByTestId('next-breadcrumb-item').filter({ hasText: '此电脑' })).toHaveCount(0);
  await expect(page.getByTestId('next-breadcrumb-item').filter({ hasText: 'alice' })).toBeVisible();

  expectClean(state);
});

test('typed path can be confirmed directly without pressing Enter; invalid path shows an error', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('next-ws-create')).toBeDisabled();

  await page.getByTestId('next-ws-path').fill('');
  await expect(page.getByTestId('next-ws-create')).toBeDisabled();

  await page.getByTestId('next-ws-path').fill('D:\\nonexistent-folder');
  await expect(page.getByTestId('next-ws-create')).toBeEnabled();
  await page.getByTestId('next-ws-create').click();
  await expect(page.getByTestId('next-ws-dir-error')).toBeVisible();
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();
  await expect(page.getByTestId('next-ws-node')).toHaveCount(2);

  await page.getByTestId('next-ws-path').fill('D:\\work\\sandbox\\notes');
  await page.getByTestId('next-ws-create').click();
  await expect(page.getByTestId('next-ws-dialog')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-node')).toHaveCount(3);
  await expect(page.getByTestId('next-ws-node').filter({ hasText: 'notes' })).toBeVisible();

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
