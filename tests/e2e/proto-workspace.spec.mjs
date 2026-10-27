import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

/**
 * New workspace dialog: browsing the mock local directory tree, and importing a
 * GitLab project with its branch list. Both flows end in a real new workspace
 * that can hold conversations.
 */
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('local directory browse, create, then start a conversation inside it', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.getByTestId('next-ws-node')).toHaveCount(2);

  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();
  await expect(page.getByTestId('next-dir-row')).toHaveCount(4);
  await expect(page.getByTestId('next-dir-row').first().locator('.ns-dir-name')).toHaveText('weft');

  // Enter a directory, then choose one inside it.
  await page.getByTestId('next-dir-row').filter({ hasText: 'sandbox' }).locator('.ns-dir-name').click();
  await expect(page.getByTestId('next-dir-row')).toHaveCount(2);
  await page.getByTestId('next-dir-row').filter({ hasText: 'playground' }).getByTestId('next-dir-choose').click();
  await expect(page.getByTestId('next-ws-name')).toHaveValue('playground');
  await expect(page.getByTestId('next-ws-path')).toHaveValue('D:\\work\\sandbox\\playground');

  await page.getByTestId('next-ws-create').click();
  await expect(page.getByTestId('next-toast')).toContainText('已创建');
  await expect(page.getByTestId('next-ws-node')).toHaveCount(3);
  await expect(page.getByTestId('next-ws-node').filter({ hasText: 'playground' })).toBeVisible();
  await expect(page).toHaveURL(/\/w\/ws-\d+\/new/);
  await expect(page.getByTestId('next-draft-hint')).toContainText('playground');

  // The new workspace takes conversations.
  await page.getByTestId('next-composer-input').fill('这个工作区里第一条消息');
  await page.getByTestId('next-send').click();
  await expect(page).toHaveURL(/\/c\/c-\d+/);
  await expect(page.getByTestId('next-item-user')).toContainText('这个工作区里第一条消息');
  await expect(page.getByTestId('next-run-status')).toHaveText('完成', { timeout: 40_000 });
  const wsId = await page.getByTestId('next-ws-node').filter({ hasText: 'playground' }).getAttribute('data-id');
  await expect(page.locator(`[data-testid=next-conv-row][data-ws-id="${wsId}"]`)).toHaveCount(1);

  // The new workspace has its own (empty-ish) mock repository in the file tab.
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.locator('[data-testid=next-file-node][data-path="README.md"]')).toBeVisible();

  expectClean(state);
});

test('git import picks a project and a branch', async ({ page }) => {
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
