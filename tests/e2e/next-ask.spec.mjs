import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { api, prepareWorkspaces, readDiscovery, startServer, tmpdir } from './helpers/server.mjs';

test.use({ locale: 'zh-CN' });
test.describe.configure({ timeout: 60_000 });

async function loginNext(page, srv) {
  const discovery = await readDiscovery(srv.dataDir);
  const issued = await fetch(`${srv.url}/api/v2/auth/web-code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${discovery.token}`,
    },
    body: '{}',
  });
  expect(issued.status).toBe(200);
  const body = await issued.json();
  await page.goto(`${srv.url}/auth?code=${encodeURIComponent(body.code)}`);
  await expect(page).not.toHaveURL(/\/auth(?:\?|$)/);
  await expect(page.getByTestId('next-app')).toBeVisible();
}

async function openWorkspaceConversation(srv, name, wsPath, title = 'ask-test') {
  const ws = await api(srv.url, 'POST', '/workspaces', { name, path: wsPath });
  expect(ws.status).toBe(201);
  const conv = await api(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, { title });
  expect(conv.status).toBe(201);
  return { ws: ws.body, conv: conv.body };
}

test('model calls ask_user_question -> panel appears -> submit answers -> composer restored -> model continues and record displays answer', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const dataDir = await tmpdir('piw-ask-e2e-');
  const scriptPath = path.join(dataDir, 'ask-script.json');

  await fs.writeFile(
    scriptPath,
    JSON.stringify({
      turns: [
        {
          text: '请先确认包管理器。',
          tool: 'ask_user_question',
          id: 'ask-1',
          args: {
            questions: [
              {
                question: '用哪种包管理器？',
                header: '包管理器',
                multiSelect: false,
                options: [
                  { label: 'npm', description: 'Node 自带' },
                  { label: 'pnpm', description: '节省磁盘' },
                ],
              },
            ],
          },
        },
        {
          text: '已收到包管理器选择，继续执行后续步骤。',
        },
      ],
    }),
  );

  const srv = await startServer({
    dataDir,
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      WEFT_FAUX_SCRIPT: scriptPath,
    },
  });

  try {
    const { conv } = await openWorkspaceConversation(srv, 'ask-demo', prepared.dirs[0]);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    await expect(page.getByTestId('next-thread')).toBeVisible();

    // 1. Send initial user prompt
    await page.getByTestId('next-composer-input').fill('开始初始化');
    await page.getByTestId('next-send').click();

    // 2. Model calls ask_user_question -> ask panel appears without page refresh
    const panel = page.getByTestId('next-ask-panel');
    await expect(panel).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('next-composer')).toBeHidden();

    // 3. User selects pnpm and submits
    await page.getByTestId('next-ask-option').filter({ hasText: 'pnpm' }).click();
    const submitBtn = page.getByTestId('next-ask-submit');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // 4. Panel immediately collapses, composer is restored
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('next-composer')).toBeVisible();

    // 5. Model receives answer and replies
    const assistant = page.getByTestId('next-item-assistant').last();
    await expect(assistant).toContainText('已收到包管理器选择', { timeout: 20000 });

    // 6. Record in thread displays the answer card with full question text and answer
    const toolRow = page.locator('[data-testid=next-tool-row][data-tool="ask"]');
    await expect(toolRow).toBeVisible();
    await expect(toolRow.getByTestId('next-tool-row-status')).toHaveText('已回答');
    const qEl = toolRow.getByTestId('next-tool-row-question').first();
    const ansEl = toolRow.getByTestId('next-tool-row-hint').first();
    await expect(qEl).toHaveText('用哪种包管理器？');
    await expect(ansEl).toContainText('pnpm');

    // Assert answer color and question color are different
    const qColor = await qEl.evaluate((el) => window.getComputedStyle(el).color);
    const ansColor = await ansEl.evaluate((el) => window.getComputedStyle(el).color);
    expect(qColor).not.toBe(ansColor);

    // 7. Refresh page: record remains, panel does not reappear
    await page.reload();
    await expect(page.getByTestId('next-thread')).toBeVisible();
    await expect(page.getByTestId('next-ask-panel')).toBeHidden();
    await expect(page.getByTestId('next-composer')).toBeVisible();

    const reloadedToolRow = page.locator('[data-testid=next-tool-row][data-tool="ask"]');
    await expect(reloadedToolRow).toBeVisible();
    await expect(reloadedToolRow.getByTestId('next-tool-row-status')).toHaveText('已回答');
    await expect(reloadedToolRow.getByTestId('next-tool-row-question').first()).toHaveText('用哪种包管理器？');
    await expect(reloadedToolRow.getByTestId('next-tool-row-hint').first()).toContainText('pnpm');
  } finally {
    await srv.kill();
  }
});
