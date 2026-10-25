import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, statusText, openApp } from './helpers/ui.mjs';

const NOTES = Array.from({ length: 8 }, (_, i) => `line-${i + 1}`).join('\n');

async function boot(page, extra = {}) {
  const prepared = await prepareWorkspaces(['repo']);
  const ws = prepared.dirs[0];
  await fs.writeFile(path.join(ws, 'notes.txt'), `${NOTES}\n`);
  const scriptPath = path.join(prepared.root, 'path-chips.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: extra.turns || [
      { text: '请看 `notes.txt:3` 和 `missing.nope:1`。' },
    ],
  }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  await openApp(page, srv);
  await createWorkspace(page, 'demo', ws);
  await newConversation(page);
  return { srv, ws };
}

test.use({ viewport: { width: 1440, height: 900 } });

test('existing inline path becomes a chip; missing path stays code; click opens and highlights the line', async ({ page }) => {
  const { srv } = await boot(page);
  try {
    await send(page, '看这两个路径');
    await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
    const body = page.locator('[data-testid=message][data-role=assistant] [data-testid=message-body]').first();
    const chip = body.locator('code.md-path');
    await expect(chip).toHaveCount(1, { timeout: 15000 });
    await expect(chip).toHaveAttribute('data-path', 'notes.txt');
    await expect(chip).toHaveAttribute('data-line', '3');
    await expect(chip.locator('.md-path-line')).toHaveText(':3');
    await expect(body.locator('code:not(.md-path)')).toHaveText('missing.nope:1');

    await chip.click();
    const preview = page.getByTestId('file-view');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('notes.txt');
    await expect(preview).toContainText('line-3');
    const target = preview.locator('.file-line.is-target');
    await expect(target).toHaveCount(1);
    await expect(target.locator('.n')).toHaveText('3');
    await expect(target.locator('.code')).toHaveText('line-3');
  } finally {
    await srv.kill();
  }
});

test('forged open-path chip cannot open a path outside the workspace tree', async ({ page }) => {
  const { srv } = await boot(page, {
    turns: [{
      text: '请看 `notes.txt:3`。\n\n'
        + '<code class="md-path" data-action="open-path" data-path="../secret.txt">../secret.txt</code>',
    }],
  });
  try {
    await send(page, '看这两个路径');
    await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
    const body = page.locator('[data-testid=message][data-role=assistant] [data-testid=message-body]').first();
    // Wait until the workspace tree has been applied (real path becomes a chip).
    await expect(body.locator('code.md-path[data-path="notes.txt"]')).toBeVisible({ timeout: 15000 });
    const forged = body.locator('code.md-path[data-path="../secret.txt"]');
    await expect(forged).toBeVisible();
    await expect(forged).toHaveAttribute('data-action', 'open-path');
    await forged.click();
    await expect(page.locator('.file-preview-head')).toHaveCount(0);
    await expect(page.getByTestId('file-view')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('sub-agent report body turns an existing path into a chip', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const ws = prepared.dirs[0];
  await fs.writeFile(path.join(ws, 'notes.txt'), `${NOTES}\n`);
  const scriptPath = path.join(prepared.root, 'report-path.json');
  await fs.writeFile(scriptPath, JSON.stringify({ turns: [{ text: '主对话已收到。' }] }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  try {
    await page.route(/\/api\/conversations\//, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const convGet = url.pathname.match(/\/api\/conversations\/([^/]+)$/);
      if (req.method() === 'GET' && convGet) {
        const cid = decodeURIComponent(convGet[1]);
        await route.fulfill({
          json: {
            id: cid,
            title: '请派子代理',
            status: 'idle',
            messages: [
              { id: 'user-send', role: 'user', text: '请派子代理' },
              { id: 'asst-reply', role: 'assistant', text: '主对话已收到。' },
              {
                id: 'rpt-ok',
                role: 'user',
                text: '[subagent 巡查 answered, no reply needed] 结果在 `notes.txt:3` 和 `missing.nope`。',
              },
            ],
            agents: [{ id: `${cid}:sub:11`, name: '巡查', status: 'done', mode: 'background' }],
          },
        });
        return;
      }
      await route.continue();
    });
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '请派子代理');
    const card = page.getByTestId('subagent-report');
    await expect(card).toBeVisible({ timeout: 20000 });
    await card.getByTestId('subagent-report-summary').click();
    const report = card.getByTestId('subagent-report-body');
    await expect(report).toBeVisible();
    await expect(report.locator('code.md-path')).toHaveCount(1, { timeout: 15000 });
    await expect(report.locator('code.md-path')).toHaveAttribute('data-path', 'notes.txt');
    await expect(report.locator('code:not(.md-path)')).toHaveText('missing.nope');
  } finally {
    await srv.kill();
  }
});

test('sub-agent pane path chips work the same way', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const ws = prepared.dirs[0];
  await fs.writeFile(path.join(ws, 'notes.txt'), `${NOTES}\n`);
  const scriptPath = path.join(prepared.root, 'pane-path.json');
  await fs.writeFile(scriptPath, JSON.stringify({ turns: [{ text: '主对话已收到。' }] }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  const agentId = 'run:sub:tester';
  try {
    await page.route(/\/api\/conversations\//, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const pathname = url.pathname;
      const convGet = pathname.match(/\/api\/conversations\/([^/]+)$/);
      if (req.method() === 'GET' && convGet) {
        const cid = decodeURIComponent(convGet[1]);
        await route.fulfill({
          json: {
            id: cid,
            title: '请派子代理',
            status: 'idle',
            messages: [
              { id: 'user-send', role: 'user', text: '请派子代理' },
              { id: 'asst-reply', role: 'assistant', text: '主对话已收到。' },
            ],
            agents: [{
              id: agentId,
              name: '测试',
              status: 'done',
              mode: 'foreground',
              title: '写登录单测',
              lastText: '改完了',
            }],
          },
        });
        return;
      }
      const msg = pathname.match(/\/api\/conversations\/([^/]+)\/agents\/([^/]+)\/messages$/);
      if (msg && req.method() === 'GET') {
        await route.fulfill({
          json: {
            id: agentId,
            name: '测试',
            status: 'done',
            mode: 'foreground',
            messages: [
              { id: 'u1', role: 'user', text: '请处理 auth' },
              { id: 'a1', role: 'assistant', text: '看 `notes.txt:3` 和 `missing.nope`。' },
            ],
          },
        });
        return;
      }
      await route.continue();
    });
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '请派子代理');
    await page.getByTestId('agent-tab').click();
    await expect(page.getByTestId('subagent-overview')).toBeVisible({ timeout: 20000 });
    await page.getByTestId('subagent-card').click();
    const pane = page.getByTestId('subagent-pane');
    await expect(pane).toBeVisible();
    await expect(pane.locator('code.md-path')).toHaveCount(1, { timeout: 15000 });
    await expect(pane.locator('code.md-path')).toHaveAttribute('data-path', 'notes.txt');
    await expect(pane.locator('code:not(.md-path)')).toHaveText('missing.nope');
  } finally {
    await srv.kill();
  }
});
