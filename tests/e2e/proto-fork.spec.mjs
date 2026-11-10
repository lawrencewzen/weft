import { test, expect } from '@playwright/test';
import { openProto, expectClean } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('fork conversation from assistant message and user message (T123-1)', async ({ page }) => {
  const state = await openProto(page);

  // Starts at c-rich (title: "重构会话列表的加载逻辑")
  await expect(page.getByTestId('next-status')).toContainText('重构会话列表的加载逻辑');

  // 1. Fork from an assistant message
  const assistantMsg = page.getByTestId('next-item-assistant').first();
  await expect(assistantMsg).toBeVisible();

  // Hover over assistant message: fork button appears
  await assistantMsg.hover();
  const forkBtnAssistant = assistantMsg.getByTestId('next-msg-fork');
  await expect(forkBtnAssistant).toBeVisible();
  await expect(forkBtnAssistant).toHaveAttribute('title', '从这里分叉');

  // Click fork on assistant message
  await forkBtnAssistant.click();

  // URL navigates to new conversation
  await expect(page).toHaveURL(/#\/c\/c-\d+$/);

  // Title in status bar is "<原标题>（分叉）"
  await expect(page.getByTestId('next-status')).toContainText('重构会话列表的加载逻辑（分叉）');

  // Sidebar shows the new forked conversation
  const sidebarConv = page.locator('[data-testid="next-conv-row"]').filter({ hasText: '重构会话列表的加载逻辑（分叉）' });
  await expect(sidebarConv.first()).toBeVisible();

  // Top of thread shows forkedFrom row: "分叉自 重构会话列表的加载逻辑 与原对话共用工作区文件"
  const forkedBanner = page.getByTestId('next-forked-from');
  await expect(forkedBanner).toBeVisible();
  await expect(forkedBanner).toContainText('分叉自');
  await expect(forkedBanner).toContainText('重构会话列表的加载逻辑');
  await expect(forkedBanner).toContainText('与原对话共用工作区文件');

  // Input box is empty
  const composerInput = page.getByTestId('next-composer-input');
  await expect(composerInput).toHaveValue('');

  // Click the original title link to jump back to c-rich
  const origLink = page.getByTestId('next-forked-link');
  await origLink.click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);
  await expect(page.getByTestId('next-status')).toContainText('重构会话列表的加载逻辑');

  // 2. Fork from a user message
  const userMsg = page.getByTestId('next-item-user').first();
  await expect(userMsg).toBeVisible();

  // Hover over user message: fork button appears
  await userMsg.hover();
  const forkBtnUser = userMsg.getByTestId('next-msg-fork');
  await expect(forkBtnUser).toBeVisible();
  await expect(forkBtnUser).toHaveAttribute('title', '从这里分叉');

  // Click fork on user message
  await forkBtnUser.click();

  // URL navigates to another new conversation
  await expect(page).toHaveURL(/#\/c\/c-\d+$/);

  // Title in status bar is "<原标题>（分叉）"
  await expect(page.getByTestId('next-status')).toContainText('重构会话列表的加载逻辑（分叉）');

  // The input box is filled with the user message text!
  await expect(composerInput).toHaveValue(/看一下 `web\/src\/data\/store\.ts` 里 items 的加载顺序/);

  // 3. Fork failure gives visible error toast (c-scripts has forkFails)
  const scriptsConv = page.locator('[data-testid="next-conv-row"]').filter({ hasText: '整理 Windows 下的启动脚本' });
  await scriptsConv.first().click();
  await expect(page.getByTestId('next-status')).toContainText('整理 Windows 下的启动脚本');

  const scriptsAssistantMsg = page.getByTestId('next-item-assistant').first();
  await expect(scriptsAssistantMsg).toBeVisible();
  await scriptsAssistantMsg.hover();
  const scriptsForkBtn = scriptsAssistantMsg.getByTestId('next-msg-fork');
  await expect(scriptsForkBtn).toBeVisible();
  await scriptsForkBtn.click();

  // Toast appears with error message
  const toast = page.getByTestId('next-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('分叉失败：对话历史已损坏');

  expectClean(state);
});
