import { test, expect } from '@playwright/test';
import { api, prepareWorkspaces, startServer } from './helpers/server.mjs';
import { apiV2, loginNext, waitRunDone } from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('new chat defaults to 选择项目 and sending creates a chat in the 对话 section', async ({ page }) => {
  const prepared = await prepareWorkspaces(['alpha']);
  const srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const ws = await api(srv.url, 'POST', '/workspaces', { name: 'alpha', path: prepared.dirs[0] });
    expect(ws.status).toBe(201);
    await loginNext(page, srv);
    await expect(page.getByTestId('next-ws-node')).toBeVisible({ timeout: 20000 });
    await page.goto(`${srv.url}/new`);
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByTestId('next-ws-chip')).toContainText('选择项目');
    await expect(page.getByTestId('next-ws-chip')).toHaveClass(/is-empty/);
    await page.getByTestId('next-ws-chip').click();
    await expect(page.getByTestId('next-ws-chip-menu')).toBeVisible();
    await expect(page.locator(`[data-testid=next-ws-chip-option][data-id="${ws.body.id}"]`)).toBeVisible();
    await expect(page.locator('[data-testid=next-ws-chip-option][data-id="__none__"]')).toHaveCount(0);
    await expect(page.getByTestId('next-ws-chip-new')).toContainText('添加项目…');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('next-composer-git')).toHaveCount(0);

    await page.getByTestId('next-composer-input').fill('不选项目也能发');
    await page.getByTestId('next-send').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    await waitRunDone(page);
    await expect(page.getByTestId('next-item-user')).toContainText('不选项目也能发');
    await expect(page.getByTestId('next-item-assistant').first()).toBeVisible({ timeout: 20000 });

    const cid = decodeURIComponent(page.url().split('/c/')[1]);
    await expect(page.getByTestId('next-chats-list').locator(`[data-id="${cid}"]`)).toHaveCount(1);
    await expect(page.getByTestId('next-ws-node').locator(`[data-id="${cid}"]`)).toHaveCount(0);
    await expect(page.getByTestId('next-chats-section')).toContainText('对话');
    await expect(page.getByTestId('next-ws-chip')).toContainText('选择项目');
    await expect(page.getByTestId('next-composer-git')).toHaveCount(0);

    const listed = await apiV2(srv, 'GET', '/api/v2/workspaces');
    expect(listed.status).toBe(200);
    const summary = listed.body.conversations.find((row) => row.id === cid);
    const chatWs = listed.body.workspaces.find((row) => row.id === summary.workspaceId);
    expect(chatWs.kind).toBe('chat');
    expect(chatWs.path).toMatch(/[/\\]chats[/\\]/);
    await page.getByTestId('next-right-tab-files').click();
    await expect(page.getByTestId('next-file-tree')).toBeVisible();
    await expect(page.locator('[data-testid=next-file-node][data-path="docs"]')).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator('[data-testid=next-file-node][data-path="docs/deep/nested/folder/structure/README.md"]'),
    ).toBeVisible({ timeout: 15000 });
  } finally {
    await srv.kill();
  }
});

test('home with no projects is a no-project draft and can send', async ({ page }) => {
  const srv = await startServer({ script: 'basic.json' });
  try {
    await loginNext(page, srv);
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByTestId('next-home-title')).toHaveCount(0);
    await expect(page.getByTestId('next-home-add')).toHaveCount(0);
    await expect(page.getByTestId('next-ws-chip')).toContainText('选择项目');
    await expect(page.getByTestId('next-composer-input')).toBeEnabled();
    await expect(page.getByTestId('next-ws-empty-add')).toBeVisible();
    await page.getByTestId('next-ws-chip').click();
    await expect(page.getByTestId('next-ws-chip-empty')).toContainText('还没有项目');
    await expect(page.getByTestId('next-ws-chip-new')).toContainText('添加项目…');
    await page.keyboard.press('Escape');

    await page.getByTestId('next-composer-input').fill('没有项目也能发');
    await page.getByTestId('next-send').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    await waitRunDone(page);
    await expect(page.getByTestId('next-item-user')).toContainText('没有项目也能发');
    await expect(page.getByTestId('next-chats-list').getByTestId('next-conv-row')).toHaveCount(1);
    await expect(page.getByTestId('next-composer-git')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('English UI uses Chats and Choose project', async ({ page }) => {
  const srv = await startServer({ script: 'basic.json' });
  try {
    await page.addInitScript(() => localStorage.setItem('weft_lang', 'en'));
    await loginNext(page, srv);
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByTestId('next-ws-chip')).toContainText('Choose project');
    await expect(page.getByTestId('next-composer-git')).toHaveCount(0);

    await page.getByTestId('next-composer-input').fill('hello without a project');
    await page.getByTestId('next-send').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    await waitRunDone(page);
    await expect(page.getByTestId('next-chats-section')).toContainText('Chats');
    await expect(page.getByTestId('next-ws-chip')).toContainText('Choose project');
    await expect(page.getByTestId('next-composer-git')).toHaveCount(0);
    await expect(page.getByTestId('next-item-user')).toContainText('hello without a project');
  } finally {
    await srv.kill();
  }
});
