import { test, expect } from '@playwright/test';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import {
  openNextChat,
  openWorkspaceConversation,
  sendNext,
  waitRunDone,
} from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

test('Enter steers a running turn; Alt+Enter queues until the turn ends', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['steer']);
  const srv = await startServer({ script: 'slow-queue.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'steer', ws);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, 'run');
    await expect(page.getByTestId('next-composer-run')).toBeVisible();
    await expect(page.getByTestId('next-composer-newline')).toContainText('Enter 插话');

    const input = page.getByTestId('next-composer-input');
    await input.fill('插一句');
    await input.press('Enter');
    const steered = page.getByTestId('next-item-user').filter({ hasText: '插一句' });
    await expect(steered).toBeVisible();
    await expect(steered.getByTestId('next-steer-hint')).toHaveText('已插话，Agent 下一步会读到');
    await expect(steered.getByTestId('next-steer-hint')).toHaveCount(0, { timeout: 20_000 });

    await input.fill('下一轮再做');
    await input.press('Alt+Enter');
    await expect(page.getByTestId('next-queue-chip')).toContainText('下一轮再做');
    await expect(page.getByTestId('next-item-user').filter({ hasText: '下一轮再做' })).toHaveCount(0);

    await expect(page.getByTestId('next-item-user').filter({ hasText: '下一轮再做' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('next-queue-chip')).toHaveCount(0);
    await waitRunDone(page);
  } finally {
    await srv.kill();
  }
});

test('withdraw drops a queued follow-up; edit puts the text back', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['withdraw']);
  const srv = await startServer({ script: 'slow-queue.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'withdraw', ws, 'drop');
    await openNextChat(page, srv, conv.id);
    await sendNext(page, 'run');
    await expect(page.getByTestId('next-stop')).toBeVisible();

    const input = page.getByTestId('next-composer-input');
    await input.fill('不要执行这条');
    await input.press('Alt+Enter');
    await expect(page.getByTestId('next-queue-chip')).toContainText('不要执行这条');
    await page.getByTestId('next-queue-dismiss').click();
    await expect(page.getByTestId('next-queue-chip')).toHaveCount(0);

    await input.fill('改回去再发');
    await input.press('Alt+Enter');
    await expect(page.getByTestId('next-queue-chip')).toContainText('改回去再发');
    await page.getByTestId('next-queue-edit').click();
    await expect(page.getByTestId('next-queue-chip')).toHaveCount(0);
    await expect(input).toHaveValue('改回去再发');
    await waitRunDone(page);
    await expect(page.getByTestId('next-item-user').filter({ hasText: '不要执行这条' })).toHaveCount(0);
    await expect(page.getByTestId('next-item-user').filter({ hasText: '改回去再发' })).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});
