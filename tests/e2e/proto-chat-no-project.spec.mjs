import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('sidebar has a Chats section with seeded no-project conversations', async ({ page }) => {
  const state = await openProto(page);

  const chats = page.getByTestId('next-chats-section');
  await expect(chats).toBeVisible();
  await expect(chats).toContainText('对话');
  await expect(page.getByTestId('next-ws-node')).toHaveCount(2);
  await expect(page.getByTestId('next-chats-list').getByTestId('next-conv-row')).toHaveCount(2);
  await expect(page.getByTestId('next-chats-list').locator('[data-testid=next-conv-row][data-id="c-consult"]')).toContainText('代码咨询');
  await expect(page.getByTestId('next-chats-list').locator('[data-testid=next-conv-row][data-id="c-regex"]')).toContainText('正则怎么写');
  await expect(page.getByTestId('next-ws-node').locator('[data-id="c-consult"]')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-node').locator('[data-id="c-regex"]')).toHaveCount(0);

  expectClean(state);
});

test('picking 不选项目 and sending creates a chat, not a project conversation', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-new-chat').click();
  await expect(page).toHaveURL(/#\/w\/ws-weft\/new$/);
  await expect(page.getByTestId('next-ws-chip')).toContainText('weft');
  await page.getByTestId('next-ws-chip').click();
  await expect(page.getByTestId('next-ws-chip-menu')).toBeVisible();
  const options = page.getByTestId('next-ws-chip-option');
  await expect(options.first()).toHaveAttribute('data-id', 'ws-weft');
  await expect(page.locator('[data-testid=next-ws-chip-option][data-id="__none__"]')).toContainText('不选项目');
  await expect(page.getByTestId('next-ws-chip-new')).toContainText('添加项目…');
  await page.locator('[data-testid=next-ws-chip-option][data-id="__none__"]').click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByTestId('next-ws-chip')).toContainText('选择项目');
  await expect(page.getByTestId('next-ws-chip')).toHaveClass(/is-empty/);
  await expect(page.getByTestId('next-draft-hint')).toHaveText('想做什么？');
  await expect(page.getByTestId('next-draft-hero-ws')).toHaveCount(0);
  await expect(page.locator('.draft-hero-hint')).toHaveCount(0);
  await expect(page.getByTestId('next-composer-git')).toHaveCount(0);

  await page.getByTestId('next-ws-chip').click();
  await expect(page.getByTestId('next-ws-chip-menu')).toBeVisible();
  await expect(page.locator('[data-testid=next-ws-chip-option][data-id="__none__"]')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-chip-menu')).not.toContainText('不选项目');
  await page.keyboard.press('Escape');

  await page.getByTestId('next-composer-input').fill('不选项目也能发');
  await page.getByTestId('next-send').click();
  await expect(page).toHaveURL(/#\/c\/c-\d+$/);
  const cid = page.url().split('/c/')[1];
  const row = page.locator(`[data-testid=next-conv-row][data-id="${cid}"]`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId('next-chats-list').locator(`[data-id="${cid}"]`)).toHaveCount(1);
  await expect(page.getByTestId('next-ws-node').locator(`[data-id="${cid}"]`)).toHaveCount(0);
  await expect(page.getByTestId('next-ws-chip')).toContainText('选择项目');
  await expect(page.getByTestId('next-composer-git')).toHaveCount(0);

  expectClean(state);
});

test('seeded no-project conversation hides git chip and still has a right pane', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-conv-row][data-id="c-regex"]').click();
  await expect(page).toHaveURL(/#\/c\/c-regex$/);
  await expect(page.getByTestId('next-status')).toContainText('正则怎么写');
  await expect(page.getByTestId('next-ws-chip')).toContainText('选择项目');
  await expect(page.getByTestId('next-composer-git')).toHaveCount(0);
  await expect(page.getByTestId('next-tool-group')).toHaveCount(1);
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.locator('[data-testid=next-file-node][data-path="README.md"]')).toBeVisible();
  await page.getByTestId('next-right-tab-term').click();
  await expect(page.getByTestId('next-term-pane')).toBeVisible();

  expectClean(state);
});

test('clearing projects shows the no-project draft and can send', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('proto-clear-projects').click();
  await expect(page.getByTestId('next-app')).toBeVisible();
  await expect(page).toHaveURL(/empty=1/);
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByTestId('next-home-title')).toHaveCount(0);
  await expect(page.getByTestId('next-home-add')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-node')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-new')).toBeVisible();
  await expect(page.getByTestId('next-draft-hint')).toHaveText('想做什么？');
  await expect(page.getByTestId('next-draft-hero-ws')).toHaveCount(0);
  await expect(page.locator('.draft-hero-hint')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-chip')).toContainText('选择项目');
  await expect(page.getByTestId('next-ws-chip')).toHaveClass(/is-empty/);
  await page.getByTestId('next-ws-chip').click();
  await expect(page.getByTestId('next-ws-chip-menu')).toBeVisible();
  await expect(page.getByTestId('next-ws-chip-empty')).toContainText('还没有项目');
  await expect(page.getByTestId('next-ws-chip-new')).toContainText('添加项目…');
  await expect(page.locator('[data-testid=next-ws-chip-option][data-id="__none__"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-composer-input')).toBeEnabled();

  await page.getByTestId('next-composer-input').fill('没有项目也能发');
  await page.getByTestId('next-send').click();
  await expect(page).toHaveURL(/#\/c\/c-\d+$/);
  await expect(page.getByTestId('next-item-user')).toContainText('没有项目也能发');
  await expect(page.getByTestId('next-chats-list').getByTestId('next-conv-row')).toHaveCount(3);

  expectClean(state);
});

test('⌘K search finds no-project conversations under 对话', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-search').click();
  const modal = page.getByTestId('next-search-modal');
  await expect(modal).toBeVisible();
  await page.getByTestId('next-search-input').fill('正则');
  const result = modal.getByTestId('next-search-result');
  await expect(result).toHaveCount(1);
  await expect(result.locator('.search-result-title')).toContainText('正则怎么写');
  await expect(result.locator('.search-result-project')).toContainText('对话');
  await page.getByTestId('next-search-input').press('Enter');
  await expect(modal).toHaveCount(0);
  await expect(page).toHaveURL(/#\/c\/c-regex$/);

  expectClean(state);
});

test('新对话 from a no-project chat stays no-project; from a project chat stays in that project', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-chats-list] [data-testid=next-conv-row][data-id="c-regex"]').click();
  await expect(page).toHaveURL(/#\/c\/c-regex$/);
  await page.getByTestId('next-new-chat').click();
  await expect(page).toHaveURL(/#\/new$/);

  await page.evaluate(() => { window.location.hash = '#/c/c-site-1'; });
  await expect(page.locator('[data-testid=next-conv-row][data-id="c-site-1"]')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('next-new-chat').click();
  await expect(page).toHaveURL(/#\/w\/ws-website\/new$/);

  expectClean(state);
});

test('hero chip can switch to 不选项目 and the title becomes 想做什么？ only', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-new-chat').click();
  await expect(page).toHaveURL(/#\/w\/ws-weft\/new$/);
  await expect(page.getByTestId('next-draft-hero-ws')).toContainText('weft');
  await expect(page.locator('.draft-hero-hint')).toContainText('weft');
  await expect(page.getByTestId('next-draft-hint')).toContainText('要在');
  await page.getByTestId('next-draft-hero-ws').click();
  await expect(page.getByTestId('next-draft-hero-menu')).toBeVisible();
  await page.locator('[data-testid=next-ws-chip-option][data-id="__none__"]').click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByTestId('next-draft-hint')).toHaveText('想做什么？');
  await expect(page.getByTestId('next-draft-hero-ws')).toHaveCount(0);
  await expect(page.locator('.draft-hero-hint')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-chip')).toContainText('选择项目');

  expectClean(state);
});

test('with no projects the sidebar shows a visible 添加项目 row', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.getByTestId('next-ws-empty-add')).toHaveCount(0);
  await page.getByTestId('proto-clear-projects').click();
  await expect(page).toHaveURL(/empty=1/);
  const add = page.getByTestId('next-ws-empty-add');
  await expect(add).toBeVisible();
  await expect(add).toContainText('添加项目');
  await add.click();
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();
  expectClean(state);
});
