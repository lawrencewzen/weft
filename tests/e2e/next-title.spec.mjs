import { test, expect } from '@playwright/test';
import { api, prepareWorkspaces, startServer } from './helpers/server.mjs';
import { loginNext, sendNext, waitRunDone } from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

const ZH_MSG = '帮我写一个用户登录页面';
const ZH_TITLE = '登录功能';
const EN_MSG = 'Help me write a user login page';
const EN_TITLE = 'Login form';

function convTitle(page, id) {
  return page.locator(`[data-testid=next-conv-row][data-id="${id}"] .sb-conv-title`);
}

test('Chinese project chat: sidebar shows the first message then the generated title', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const srv = await startServer({
    script: 'title.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const ws = await api(srv.url, 'POST', '/workspaces', { name: 'demo', path: prepared.dirs[0] });
    expect(ws.status).toBe(201);
    const conv = await api(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, {});
    expect(conv.status).toBe(201);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.body.id)}`);
    await expect(page.getByTestId('next-composer-input')).toBeVisible();
    await sendNext(page, ZH_MSG);
    await expect(page.getByTestId('next-stop')).toBeVisible({ timeout: 15000 });
    await expect(convTitle(page, conv.body.id)).toHaveText(ZH_MSG);
    await waitRunDone(page);
    await expect(convTitle(page, conv.body.id)).toHaveText(ZH_TITLE, { timeout: 15000 });
    await expect(page.getByTestId('next-status')).toContainText(ZH_TITLE);
  } finally {
    await srv.kill();
  }
});

test('English no-project chat: sidebar shows the first message then the generated title', async ({ page }) => {
  const srv = await startServer({ script: 'title.json' });
  try {
    await page.addInitScript(() => localStorage.setItem('weft_lang', 'en'));
    await loginNext(page, srv);
    await expect(page).toHaveURL(/\/new$/);
    await sendNext(page, EN_MSG);
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    const cid = decodeURIComponent(page.url().split('/c/')[1]);
    await expect(page.getByTestId('next-stop')).toBeVisible({ timeout: 15000 });
    await expect(convTitle(page, cid)).toHaveText(EN_MSG);
    await waitRunDone(page);
    await expect(convTitle(page, cid)).toHaveText(EN_TITLE, { timeout: 15000 });
    await expect(page.getByTestId('next-chats-list').locator(`[data-id="${cid}"]`)).toHaveCount(1);
    await expect(page.getByTestId('next-status')).toContainText(EN_TITLE);
  } finally {
    await srv.kill();
  }
});
