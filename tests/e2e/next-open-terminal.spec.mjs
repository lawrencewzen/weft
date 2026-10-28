import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { apiV2, openNextChat, openWorkspaceConversation } from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

async function boot(page) {
  const prepared = await prepareWorkspaces(['ws']);
  const wsDir = prepared.dirs[0];
  await fs.mkdir(path.join(wsDir, 'src'));
  await fs.writeFile(path.join(wsDir, 'src', 'app.js'), 'ok\n');
  await fs.writeFile(path.join(wsDir, 'README.md'), 'hi\n');
  const srv = await startServer({
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      WEFT_TERMINAL_MOCK: '1',
    },
  });
  const { ws, conv } = await openWorkspaceConversation(srv, 'demo', wsDir);
  await openNextChat(page, srv, conv.id);
  return { srv, ws, conv, wsDir };
}

function openTerminalPosts(page) {
  /** @type {{ url: string, body: Record<string, unknown> }[]} */
  const posts = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().includes('/open-terminal')) return;
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch { body = {}; }
    posts.push({ url: req.url(), body });
  });
  return posts;
}

async function clickOpenTerminal(page) {
  const item = page.getByTestId('next-ctx-menu').locator('[data-action=open-terminal]');
  await expect(item).toBeVisible();
  await item.click();
}

test('three UI entries POST open-terminal; files do not get the item; traversal is E_PATH', async ({ page }) => {
  const { srv, ws } = await boot(page);
  const posts = openTerminalPosts(page);
  try {
    await page.getByTestId('next-ws-toggle').click({ button: 'right' });
    await clickOpenTerminal(page);
    await expect(page.getByTestId('next-toast')).toContainText('已在系统终端中打开');
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].url).toContain(`/api/v2/workspaces/${encodeURIComponent(ws.id)}/open-terminal`);
    expect(posts[0].body.path == null || posts[0].body.path === '').toBe(true);

    await page.getByTestId('next-right-tab-files').click();
    const dir = page.locator('[data-testid=next-file-node][data-path="src"]');
    await expect(dir).toBeVisible({ timeout: 15000 });
    await dir.click({ button: 'right' });
    await clickOpenTerminal(page);
    await expect(page.getByTestId('next-toast')).toContainText('已在系统终端中打开');
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1].body).toEqual({ path: 'src' });

    const file = page.locator('[data-testid=next-file-node][data-path="README.md"]');
    await expect(file).toBeVisible();
    await file.click({ button: 'right' });
    await expect(page.getByTestId('next-ctx-menu')).toHaveCount(0);

    await page.getByTestId('next-ws-chip').click({ button: 'right' });
    await clickOpenTerminal(page);
    await expect(page.getByTestId('next-toast')).toContainText('已在系统终端中打开');
    await expect.poll(() => posts.length).toBe(3);
    expect(posts[2].body.path == null || posts[2].body.path === '').toBe(true);

    const escaped = await apiV2(srv, 'POST', `/api/v2/workspaces/${ws.id}/open-terminal`, { path: '../secret' });
    expect(escaped.status).toBe(400);
    expect(escaped.body.code).toBe('E_PATH');
  } finally {
    await srv.kill();
  }
});

test('open-terminal error from the server shows in the toast', async ({ page }) => {
  const { srv } = await boot(page);
  try {
    await page.route('**/api/v2/workspaces/*/open-terminal', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: '路径超出工作区', code: 'E_PATH' }),
      });
    });
    await page.getByTestId('next-ws-chip').click({ button: 'right' });
    await clickOpenTerminal(page);
    await expect(page.getByTestId('next-toast')).toContainText('路径超出工作区');
  } finally {
    await srv.kill();
  }
});
