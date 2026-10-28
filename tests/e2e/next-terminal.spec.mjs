import { test, expect } from '@playwright/test';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { openNextChat, openWorkspaceConversation, sendNext, waitRunDone } from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

test('streaming bash output appears in the terminal tab', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  const srv = await startServer({ script: 'bash-stream.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', ws);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '跑测试');

    const termTab = page.getByTestId('next-right-tab-term');
    await expect(termTab).toBeVisible({ timeout: 20000 });
    await expect(termTab.locator('.tab-count')).toHaveText('1');
    await termTab.click();
    await expect(termTab).toHaveClass(/active/);
    await expect(page.getByTestId('next-term-pane')).toBeVisible();
    const cmd = page.getByTestId('next-term-cmd');
    await expect(cmd).toHaveCount(1);
    await expect(cmd).toHaveAttribute('data-running', 'true');
    await expect(page.getByTestId('next-term-body')).toContainText('tick-0', { timeout: 15000 });
    await expect(page.getByTestId('next-term-body')).toContainText('tick-3', { timeout: 15000 });
    await waitRunDone(page);
    await expect(cmd).toHaveAttribute('data-running', 'false');
    await expect(page.getByTestId('next-term-note')).toContainText('主 Agent');
    await expect(page.getByTestId('next-term-body')).toContainText('tick-5');

    await page.getByTestId('next-tool-group-summary').click();
    const openTerm = page.getByTestId('next-tool-open-term');
    await expect(openTerm).toBeVisible();
    await page.getByTestId('next-right-tab-changes').click();
    await expect(page.getByTestId('next-term-pane')).toHaveCount(0);
    await openTerm.click();
    await expect(page.getByTestId('next-right-tab-term')).toHaveClass(/active/);
    await expect(page.getByTestId('next-term-body')).toContainText('tick-5');
  } finally {
    await srv.kill();
  }
});
