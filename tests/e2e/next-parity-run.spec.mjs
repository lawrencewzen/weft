import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces, api } from './helpers/server.mjs';
import {
  loginNext,
  openNextChat,
  openWorkspaceConversation,
  runStatus,
  sendNext,
  waitRunDone,
  waitRunStopped,
} from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

const exists = (p) => fs.access(p).then(() => true, () => false);

const TEXT_A = '这是一个 TypeScript/Node.js 项目，用于开发相关。';
const TEXT_B = '第二轮已经看完，结论里有顿号、和的字。';

test('auto-continue is a gray note, not a user bubble, including after refresh', async ({ page }) => {
  const prepared = await prepareWorkspaces(['cont']);
  const ws = prepared.dirs[0];
  const scriptPath = path.join(prepared.root, 'continue.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: [
      { text: 'part-one of a long answer', stopReason: 'length' },
      { text: 'part-two finishes the thought.' },
    ],
  }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'cont', ws);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '写一段长回答');
    await waitRunDone(page);
    const users = page.getByTestId('next-item-user');
    await expect(users).toHaveCount(1);
    await expect(users).toContainText('写一段长回答');
    await expect(page.getByTestId('next-auto-continue-note')).toHaveCount(1);
    await expect(page.getByTestId('next-auto-continue-note')).toContainText('输出达到长度上限，已自动续写');
    const assistants = page.getByTestId('next-item-assistant');
    await expect(assistants).toHaveCount(2);
    await expect(assistants.nth(0).getByTestId('next-markdown')).toContainText('part-one');
    await expect(assistants.nth(1).getByTestId('next-markdown')).toContainText('part-two');
    await expect(page.getByTestId('next-truncated')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('next-item-user')).toHaveCount(1, { timeout: 20000 });
    await expect(page.getByTestId('next-auto-continue-note')).toHaveCount(1);
    await expect(page.getByTestId('next-item-assistant')).toHaveCount(2);
    await expect(page.getByTestId('next-item-assistant').nth(0).getByTestId('next-markdown')).toContainText('part-one');
    await expect(page.getByTestId('next-item-assistant').nth(1).getByTestId('next-markdown')).toContainText('part-two');
    await expect(page.getByTestId('next-truncated')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('hitting the auto-continue cap shows a continue button', async ({ page }) => {
  const prepared = await prepareWorkspaces(['cap']);
  const ws = prepared.dirs[0];
  const scriptPath = path.join(prepared.root, 'cap.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: Array.from({ length: 9 }, (_, i) => ({
      text: `chunk-${i + 1}`,
      stopReason: 'length',
    })),
  }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'cap', ws);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, 'keep going');
    await waitRunDone(page);
    await expect(page.getByTestId('next-auto-continue-note')).toHaveCount(8);
    await expect(page.getByTestId('next-item-assistant')).toHaveCount(9);
    const truncated = page.getByTestId('next-truncated');
    await expect(truncated).toHaveCount(1);
    await expect(truncated).toContainText('输出达到长度上限被截断');
    await expect(page.getByTestId('next-continue')).toBeVisible();
    await page.getByTestId('next-continue').click();
    await expect(page.getByTestId('next-item-user').filter({ hasText: '继续' })).toHaveCount(1);
  } finally {
    await srv.kill();
  }
});

test('two turns each leave one agent reply, including after refresh', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ghost']);
  const ws = prepared.dirs[0];
  await fs.mkdir(path.join(ws, 'src'));
  const scriptPath = path.join(prepared.root, 'ghost.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: [
      { tool: 'ls', args: { path: '.' } },
      { text: TEXT_A },
      { tool: 'ls', args: { path: 'src' } },
      { text: TEXT_B },
    ],
  }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_FAUX_TPS: '4',
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'ghost', ws);
    await openNextChat(page, srv, conv.id);
    const assistants = page.getByTestId('next-item-assistant');

    await sendNext(page, '先看一下这个仓库');
    await expect(assistants.filter({ hasText: TEXT_A })).toHaveCount(1, { timeout: 30000 });
    await waitRunDone(page);
    await expect(assistants).toHaveCount(1);

    await sendNext(page, '再看一眼 src');
    await expect(assistants.filter({ hasText: TEXT_B })).toHaveCount(1, { timeout: 30000 });
    await waitRunDone(page);
    await expect(assistants).toHaveCount(2);
    await expect(assistants.nth(0).getByTestId('next-markdown')).toContainText(TEXT_A);
    await expect(assistants.nth(1).getByTestId('next-markdown')).toContainText(TEXT_B);

    await page.reload();
    await expect(page.getByTestId('next-item-assistant').filter({ hasText: TEXT_A })).toHaveCount(1, { timeout: 20000 });
    await expect(page.getByTestId('next-item-assistant').filter({ hasText: TEXT_B })).toHaveCount(1);
    await expect(page.getByTestId('next-item-assistant')).toHaveCount(2);
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('next-item-assistant')).toHaveCount(2);
    await expect(page.getByTestId('next-item-assistant').nth(0).getByTestId('next-markdown')).toContainText(TEXT_A);
    await expect(page.getByTestId('next-item-assistant').nth(1).getByTestId('next-markdown')).toContainText(TEXT_B);
    await expect(runStatus(page)).not.toHaveAttribute('data-status', 'running');
  } finally {
    await srv.kill();
  }
});

test('interrupt while running, then stop', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ctl']);
  const srv = await startServer({ script: 'slow.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    const { ws: workspace, conv } = await openWorkspaceConversation(srv, 'ctl', ws);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, 'run');
    await expect(page.getByTestId('next-stop')).toBeVisible();
    const input = page.getByTestId('next-composer-input');
    await expect(input).toBeEnabled();
    await expect(input).toHaveAttribute('placeholder', /补充说明/);
    await input.fill('插一句');
    await page.getByTestId('next-send').click();
    await expect(page.getByTestId('next-item-user').filter({ hasText: '插一句' })).toBeVisible();
    await waitRunDone(page);
    expect(await exists(path.join(ws, 'b.txt'))).toBe(true);

    const second = await api(srv.url, 'POST', `/workspaces/${workspace.id}/conversations`, { title: 'stop' });
    expect(second.status).toBe(201);
    await page.goto(`${srv.url}/c/${encodeURIComponent(second.body.id)}`);
    await expect(page.getByTestId('next-composer-input')).toBeVisible();
    await sendNext(page, 'run again');
    await expect(page.getByTestId('next-stop')).toBeVisible();
    const stop = page.getByTestId('next-stop');
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAttribute('aria-label', /终止|Stop/);
    await stop.click();
    await waitRunStopped(page);
    await page.waitForTimeout(4000);
    await expect(runStatus(page)).toHaveAttribute('data-status', /stopped|idle/);
  } finally {
    await srv.kill();
  }
});

test('running status lives in the sidebar status dot and live tool group', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['pending']);
  const srv = await startServer({ script: 'pending-run.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'pending', ws);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, 'run');
    await expect(page.getByTestId('next-stop')).toBeVisible();

    await expect(page.getByTestId('next-tool-group-spinner')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('next-tool-group-text')).toHaveText('正在运行 `sleep 2`…');
    await expect(page.getByTestId('next-tool-group-elapsed')).toHaveText(/^\d+:\d{2}$/);
    await expect(page.locator('.tool-group-spin, .run-spin, [data-testid=next-stream-spin]')).toHaveCount(1);
    await expect(page.locator('[data-testid=next-tool-row][data-tool=bash]')).toBeHidden();

    await expect(page.getByTestId('next-tool-group-text')).toHaveText('运行 sleep 2 · 思考中', { timeout: 8000 });
    await expect(page.getByTestId('next-tool-group-spinner')).toBeVisible();
    await expect(page.getByTestId('next-tool-group-elapsed')).toHaveText(/^\d+:\d{2}$/);
    await expect(page.locator('.tool-group-spin, .run-spin, [data-testid=next-stream-spin]')).toHaveCount(1);

    await expect(page.getByTestId('next-item-assistant').filter({ hasText: '跑完了。' })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('next-tool-group-spinner')).toHaveCount(0);
    await expect(page.getByTestId('next-tool-group-elapsed')).toHaveCount(0);
    await waitRunDone(page);
    await expect(page.getByTestId('next-stop')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('main thread omits default sender and does not show 主 Agent', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['role']);
  const srv = await startServer({ script: 'basic.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'role', ws);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, 'default role');
    await waitRunDone(page);
    await expect(page.locator('[data-testid=next-thread] [data-testid=next-item-assistant] [data-testid=message-sender]')).toHaveCount(0);
    await expect(page.getByTestId('next-thread')).not.toContainText('主 Agent');
    const chip = page.locator('[data-testid=next-thread] [data-testid=next-item-assistant] [data-testid=next-message-chip]').first();
    await expect(chip).toBeVisible();
    expect(await chip.textContent()).toBe('faux-1');
  } finally {
    await srv.kill();
  }
});

test('stream cut retries and finishes', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['cut']);
  const srv = await startServer({ script: 'crash.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'cut', ws);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, 'go');
    await waitRunDone(page, 30000);
    await expect(page.getByTestId('next-auto-continue-note')).toHaveCount(0);
    expect(await fs.readFile(path.join(ws, 'final.txt'), 'utf8')).toBe('ok\n');
  } finally {
    await srv.kill();
  }
});

test('kill -9 server mid-task, restart -> resumes to done without duplicate writes', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['crash']);
  const holdReady = path.join(root, 'hold-ready');
  let srv = await startServer({
    script: 'crash.json',
    extraEnv: {
      WEFT_WORKSPACE_ROOT: root,
      WEFT_FAUX_HOLD_READY: holdReady,
    },
  });
  const { dataDir, port } = srv;
  try {
    const { conv } = await openWorkspaceConversation(srv, 'crash', ws);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, 'go');
    await expect.poll(() => fs.readFile(path.join(ws, 'log.txt'), 'utf8').catch(() => ''), { timeout: 15000 }).toBe('1\n');
    await expect.poll(() => fs.readFile(path.join(ws, 'side_effect.txt'), 'utf8').catch(() => ''), { timeout: 15000 }).toBe('once\n');
    await expect.poll(() => fs.readFile(holdReady, 'utf8').catch(() => ''), { timeout: 15000 }).toBe('seen');
    await srv.kill('SIGKILL');

    srv = await startServer({ script: 'crash.json', dataDir, port, extraEnv: { WEFT_WORKSPACE_ROOT: root } });
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    await expect(page.getByTestId('next-thread')).toBeVisible();
    await waitRunDone(page, 30000);
    expect(await fs.readFile(path.join(ws, 'final.txt'), 'utf8')).toBe('ok\n');
    expect(await fs.readFile(path.join(ws, 'side_effect.txt'), 'utf8')).toBe('once\n');
    expect(await fs.readFile(path.join(ws, 'log.txt'), 'utf8')).toBe('1\n');
    await page.getByTestId('next-tool-group-summary').first().click();
    const groups = page.getByTestId('next-tool-group-summary');
    const n = await groups.count();
    for (let i = 1; i < n; i += 1) await groups.nth(i).click();
    await expect(page.locator('[data-testid=next-tool-row][data-tool=bash]')).toHaveCount(1);
    await expect(page.locator('[data-testid=next-tool-row][data-tool=write]')).toHaveCount(2);
    const listed = await api(srv.url, 'GET', `/conversations/${conv.id}`);
    expect(listed.status).toBe(200);
    expect(['done', 'idle']).toContain(listed.body.status);
  } finally {
    await srv.kill();
  }
});
