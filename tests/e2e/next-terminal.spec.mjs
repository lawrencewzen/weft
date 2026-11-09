import { test, expect } from '@playwright/test';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { openNextChat, openWorkspaceConversation, sendNext, waitRunDone } from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

test('streaming bash output appears in thread tool row without terminal tab', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  const srv = await startServer({ script: 'bash-stream.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', ws);
    await openNextChat(page, srv, conv.id);

    // Right pane has changes and files tabs, no terminal tab
    await page.getByTestId('next-right-toggle').click();
    await expect(page.getByTestId('next-right-tab-changes')).toBeVisible();
    await expect(page.getByTestId('next-right-tab-files')).toBeVisible();
    await expect(page.getByTestId('next-right-tab-term')).toHaveCount(0);
    await expect(page.getByTestId('next-term-pane')).toHaveCount(0);

    await sendNext(page, '跑测试');

    // Tool group appears in conversation
    const groupSummary = page.getByTestId('next-tool-group-summary');
    await expect(groupSummary).toBeVisible({ timeout: 20000 });
    await groupSummary.click();

    const bashRow = page.locator('[data-testid="next-tool-row"][data-tool="bash"]').first();
    await expect(bashRow).toBeVisible();
    await expect(page.getByTestId('next-tool-open-term')).toHaveCount(0);

    // Click to expand in-place
    await bashRow.click();
    const detail = bashRow.locator('[data-testid="next-tool-row-detail"]');
    await expect(detail).toBeVisible();

    await waitRunDone(page);
    await expect(detail.locator('.tool-detail-block')).toContainText('tick-5');

    // Right pane remained without terminal tab
    await expect(page.getByTestId('next-right-tab-term')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});
