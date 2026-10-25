import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, openApp } from './helpers/ui.mjs';

const BACKGROUND_NAME = '巡查';
const BACKGROUND_MESSAGE = '请在后台查看仓库。';
const CHILD_TEXT = '仓库干净，没有未提交改动。';
const REPORT_MARKER = '[subagent 巡查 answered, no reply needed]';

test.use({
  viewport: { width: 1440, height: 900 },
});
test.describe.configure({ timeout: 90_000 });

test('background sub-agent report is a folded card, not a user bubble, including after refresh', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const scriptPath = path.join(prepared.root, 'subagent-report.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: [
      { tool: 'subagent', args: { action: 'spawn', name: BACKGROUND_NAME, message: BACKGROUND_MESSAGE } },
      { text: '已派出巡查。' },
      { when: BACKGROUND_MESSAGE, text: CHILD_TEXT },
      { when: 'no reply needed', text: '已记下巡查结果。' },
    ],
  }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', prepared.dirs[0]);
    await newConversation(page);
    await send(page, '请派子代理');

    const card = page.getByTestId('subagent-report');
    await expect(card).toBeVisible({ timeout: 45000 });
    await expect(card).toHaveAttribute('data-kind', 'subagent-report');
    await expect(card).toHaveClass(/msg-side-agent/);
    await expect(card).not.toHaveClass(/is-open/);
    await expect(card.getByTestId('subagent-report-summary')).toContainText('子 Agent「');
    await expect(card.getByTestId('subagent-report-summary')).toContainText('已交回结果');
    await expect(card.getByTestId('subagent-report-body')).toBeHidden();

    const users = page.locator('#center-thread [data-testid=message][data-role=user]');
    await expect(users).toHaveCount(1);
    await expect(users).toContainText('请派子代理');
    await expect(users).not.toContainText(REPORT_MARKER);
    await expect(users).not.toContainText(CHILD_TEXT);
    await expect(page.locator('#center-thread [data-testid=message][data-role=user]').filter({
      hasText: REPORT_MARKER,
    })).toHaveCount(0);

    await card.getByTestId('subagent-report-summary').click();
    await expect(card).toHaveClass(/is-open/);
    await expect(card.getByTestId('subagent-report-body')).toBeVisible();
    await expect(card.getByTestId('subagent-report-body')).toContainText(CHILD_TEXT);

    await page.reload();
    await expect(page.getByTestId('subagent-report')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('subagent-report')).toHaveAttribute('data-kind', 'subagent-report');
    await expect(page.locator('#center-thread [data-testid=message][data-role=user]')).toHaveCount(1);
    await expect(page.locator('#center-thread [data-testid=message][data-role=user]')).not.toContainText(REPORT_MARKER);
    await expect(page.getByTestId('subagent-report-summary')).toContainText('已交回结果');
    await expect(page.getByTestId('subagent-report-body')).toBeHidden();
    await page.getByTestId('subagent-report-summary').click();
    await expect(page.getByTestId('subagent-report-body')).toBeVisible();
    await expect(page.getByTestId('subagent-report-body')).toContainText(CHILD_TEXT);
  } finally {
    await srv.kill();
  }
});

test('stored answered and failed reports render as cards without a user bubble', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const scriptPath = path.join(prepared.root, 'stored-report.json');
  await fs.writeFile(scriptPath, JSON.stringify({ turns: [{ text: '主对话已收到。' }] }));
  const answered = `[subagent 巡查 answered, no reply needed] ${CHILD_TEXT}`;
  const failed = '[subagent 编码 failed: timed out]';
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
            modelSourceId: null,
            modelId: null,
            messages: [
              { id: 'user-send', role: 'user', text: '请派子代理' },
              { id: 'asst-reply', role: 'assistant', text: '主对话已收到。' },
              { id: 'rpt-ok', role: 'user', text: answered },
              { id: 'rpt-fail', role: 'user', text: failed },
            ],
            agents: [
              {
                id: `${cid}:sub:11`,
                name: BACKGROUND_NAME,
                status: 'done',
                mode: 'background',
              },
            ],
          },
        });
        return;
      }
      await route.continue();
    });

    await openApp(page, srv);
    await createWorkspace(page, 'demo', prepared.dirs[0]);
    await newConversation(page);
    await send(page, '请派子代理');

    const cards = page.getByTestId('subagent-report');
    await expect(cards).toHaveCount(2, { timeout: 20000 });
    await expect(cards.nth(0).getByTestId('subagent-report-summary')).toContainText(`子 Agent「${BACKGROUND_NAME}」已交回结果`);
    await expect(cards.nth(1)).toHaveClass(/is-failed/);
    await expect(cards.nth(1).getByTestId('subagent-report-summary')).toContainText('子 Agent「编码」失败');
    await expect(cards.nth(1).getByTestId('subagent-report-summary')).toContainText('timed out');

    const users = page.locator('#center-thread [data-testid=message][data-role=user]');
    await expect(users).toHaveCount(1);
    await expect(users).toContainText('请派子代理');
    await expect(users).not.toContainText(REPORT_MARKER);
    await expect(users).not.toContainText('failed:');

    await expect(cards.nth(0).getByTestId('subagent-report-open')).toBeVisible();
    await expect(cards.nth(1).getByTestId('subagent-report-open')).toHaveCount(0);

    await cards.nth(1).getByTestId('subagent-report-summary').click();
    await expect(cards.nth(1).getByTestId('subagent-report-body')).toContainText('timed out');
  } finally {
    await srv.kill();
  }
});
