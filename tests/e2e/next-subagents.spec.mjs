import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces, api } from './helpers/server.mjs';
import {
  loginNext,
  openNextChat,
  openWorkspaceConversation,
  sendNext,
  waitRunDone,
} from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

const HOLD = 'hold-task';
const STEER = 'please-steer';
const REPORT_NAME = '巡查';
const REPORT_MSG = '请在后台查看仓库。';
const REPORT_TEXT = '仓库干净，没有未提交改动。';

function attachCspLog(page) {
  const csp = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/content security policy/i.test(text)) csp.push(text);
  });
  return csp;
}

async function trackEventSources(page) {
  await page.addInitScript(() => {
    const Orig = window.EventSource;
    window.EventSource = class extends Orig {
      constructor(url, config) {
        super(url, config);
        window.__testEventSources = window.__testEventSources || [];
        window.__testEventSources.push(String(url));
      }
    };
  });
}

async function lastTopics(page) {
  return page.evaluate(() => {
    const urls = window.__testEventSources || [];
    const last = urls[urls.length - 1] || '';
    try {
      const params = new URL(last, location.origin).searchParams.get('topics') || '';
      return params.split(',').filter(Boolean);
    } catch {
      return [];
    }
  });
}

function convRow(page, id) {
  return page.locator(`[data-testid=next-conv-row][data-id="${id}"]`);
}

function convNode(page, id) {
  return page.locator('.conv-tree-node').filter({ has: convRow(page, id) });
}

async function waitSubagentRow(page, convId, timeout = 45000) {
  const card = page.getByTestId('next-dispatch-card');
  await expect(card).toBeVisible({ timeout });
  const row = card.getByTestId('next-dispatch-row').first();
  await expect(row).toBeVisible({ timeout });
  return row;
}

async function writeScript(dir, name, turns) {
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify({ turns }));
  return file;
}

test('demo model badges appear under the composer and not in the header', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await expect(page.getByTestId('next-demo-model-badge')).toHaveCount(0);
    await expect(page.getByTestId('next-demo-model-chip')).toBeVisible();
    await expect(page.getByTestId('next-demo-model-chip')).toHaveText('演示模型');
  } finally {
    await srv.kill();
  }
});

test('spawning a sub-agent does not show subagents in sidebar; appears in thread dispatch card', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const script = await writeScript(prepared.root, 'spawn-hold.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: HOLD } },
    { text: 'parent-idle' },
    { when: HOLD, delayMs: 12000, text: 'child-done' },
  ]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: script, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  const csp = attachCspLog(page);
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '请派子代理');
    const row = await waitSubagentRow(page, conv.id);
    await expect(page.getByTestId('next-sidebar').getByTestId('next-subagent-chip')).toHaveCount(0);
    await expect(page.getByTestId('next-sidebar').getByTestId('next-subagent-tree')).toHaveCount(0);
    await expect(row).toHaveAttribute('data-status', /running|waiting|stuck/);
    await expect(row.getByTestId('next-dispatch-name')).toHaveText('worker');
    expect(csp, 'page console has no CSP errors').toEqual([]);
  } finally {
    await srv.kill();
  }
});

test('short WEFT_SUBAGENT_STUCK_MS turns the row stuck with idle time without refresh', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const script = await writeScript(prepared.root, 'spawn-stuck.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: HOLD } },
    { text: 'parent-idle' },
    { when: HOLD, tool: 'ls', args: { path: '.' } },
    { when: HOLD, delayMs: 20000, text: 'child-done' },
  ]);
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: script,
      WEFT_WORKSPACE_ROOT: prepared.root,
      WEFT_SUBAGENT_STUCK_MS: '800',
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '请派子代理');
    const row = await waitSubagentRow(page, conv.id);
    await expect(row).toHaveAttribute('data-status', 'stuck', { timeout: 20000 });
  } finally {
    await srv.kill();
  }
});

test('other conversation does not show subagents in sidebar', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const script = await writeScript(prepared.root, 'spawn-other.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: HOLD } },
    { text: 'parent-idle' },
    { when: HOLD, delayMs: 20000, text: 'child-done' },
  ]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: script, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    await trackEventSources(page);
    const { ws, conv: aConv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0], 'chat-a');
    const b = await api(srv.url, 'POST', `/workspaces/${ws.id}/conversations`, { title: 'chat-b' });
    expect(b.status).toBe(201);
    const aId = aConv.id;
    const bId = b.body.id;

    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(bId)}`);
    await expect(page.getByTestId('next-thread')).toBeVisible();
    await sendNext(page, '请派子代理');
    await waitSubagentRow(page, bId);

    await convRow(page, aId).click();
    await expect(page).toHaveURL(new RegExp(`/c/${aId}$`));
    await expect(page.getByTestId('next-sidebar').getByTestId('next-subagent-chip')).toHaveCount(0);
    await expect(page.getByTestId('next-sidebar').getByTestId('next-subagent-tree')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('clicking a row opens the sub-agent view; send and stop work; refresh keeps it', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const script = await writeScript(prepared.root, 'spawn-steer.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: HOLD } },
    { text: 'parent-idle' },
    { when: HOLD, delayMs: 12000, text: 'child-first' },
    { when: STEER, text: 'pad-0' },
    { when: STEER, delayMs: 25000, text: 'child-after-steer' },
  ]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: script, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '请派子代理');
    const row = await waitSubagentRow(page, conv.id);
    const agentId = await row.getAttribute('data-agent-id');
    expect(agentId).toBeTruthy();
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/c/${conv.id}/a/`));
    await expect(page.getByTestId('next-center')).toBeVisible();
    await expect(page.getByTestId('next-subagent-view')).toBeVisible();
    await expect(page.getByTestId('next-right-tab-subagents')).toHaveClass(/active/);
    await expect(page.getByTestId('next-subagent-back')).toHaveText('子 Agent');
    await expect(page.locator(`[data-testid=next-dispatch-row][data-agent-id="${agentId}"]`)).toHaveClass(/is-selected/);
    await expect(page.getByTestId('next-subagent-thread')).toContainText(HOLD);
    await expect(page.getByTestId('next-subagent-input')).toBeVisible();
    await expect(page.getByTestId('next-subagent-stop')).toBeVisible({ timeout: 15000 });

    const posted = page.waitForResponse((res) => (
      res.request().method() === 'POST'
      && /\/api\/v2\/conversations\/[^/]+\/subagents\/[^/]+\/messages$/.test(new URL(res.url()).pathname)
    ), { timeout: 15000 });
    await page.getByTestId('next-subagent-input').fill(STEER);
    await page.getByTestId('next-subagent-send').click();
    const sendRes = await posted;
    expect(sendRes.status(), await sendRes.text()).toBe(202);
    await expect(page.getByTestId('next-subagent-input')).toHaveValue('');
    await expect(page.getByTestId('next-composer-error')).toHaveCount(0);
    await expect(page.getByTestId('next-subagent-thread')).toContainText(STEER, { timeout: 25000 });
    await expect(page.getByTestId('next-subagent-stop')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('next-subagent-stop').click();
    await expect(page.getByTestId('next-subagent-status')).toHaveText(/已停止|Stopped/i, { timeout: 20000 });

    await page.reload();
    await expect(page.getByTestId('next-center')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('next-subagent-view')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('next-subagent-thread')).toContainText(HOLD);
    await expect(page.getByTestId('next-subagent-thread')).toContainText(STEER);
    await expect(page.getByTestId('next-subagent-status')).toHaveText(/已停止|Stopped|完成|Done/i);

    await page.getByTestId('next-subagent-back').click();
    await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
    await expect(page.getByTestId('next-subagent-overview')).toBeVisible();
    await convRow(page, conv.id).click();
    await expect(page.getByTestId('next-right-tab-changes')).toHaveClass(/active/);
    await expect(page.getByTestId('next-subagent-view')).toHaveCount(0);
    await expect(page.getByTestId('next-subagent-overview')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('report open jumps to the matching sub-agent; missing sub-agent shows an error', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const script = await writeScript(prepared.root, 'spawn-report.json', [
    { tool: 'subagent', args: { action: 'spawn', name: REPORT_NAME, message: REPORT_MSG } },
    { text: '已派出巡查。' },
    { when: REPORT_MSG, text: REPORT_TEXT },
    { when: 'no reply needed', text: '已记下巡查结果。' },
  ]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: script, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '请派子代理');
    const card = page.getByTestId('next-item-subagent-report');
    await expect(card).toBeVisible({ timeout: 45000 });
    const openBtn = card.getByTestId('next-report-open');
    await expect(openBtn).toBeVisible();
    await openBtn.click();
    await expect(page).toHaveURL(new RegExp(`/c/${conv.id}/a/`));
    await expect(page.getByTestId('next-center')).toBeVisible();
    await expect(page.getByTestId('next-subagent-view')).toBeVisible();
    await expect(page.getByTestId('next-subagent-view')).toContainText(new RegExp(`${REPORT_NAME}|${REPORT_MSG}`));
    await expect(page.getByTestId('next-subagent-thread')).toContainText(REPORT_TEXT, { timeout: 15000 });

    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}/a/does-not-exist`);
    await expect(page.getByTestId('next-center')).toBeVisible();
    await expect(page.getByTestId('next-subagent-view')).toBeVisible();
    await expect(page.getByTestId('next-error')).toHaveText('子 Agent 不存在');
  } finally {
    await srv.kill();
  }
});

test('switching conversation leaves sidebar clean without subagents', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const script = await writeScript(prepared.root, 'spawn-keep.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: HOLD } },
    { text: 'parent-idle' },
    { when: HOLD, delayMs: 20000, text: 'child-done' },
  ]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: script, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { ws, conv: aConv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0], 'chat-a');
    const b = await api(srv.url, 'POST', `/workspaces/${ws.id}/conversations`, { title: 'chat-b' });
    expect(b.status).toBe(201);
    const aId = aConv.id;
    const bId = b.body.id;

    await openNextChat(page, srv, aId);
    await sendNext(page, '请派子代理');
    await waitSubagentRow(page, aId);

    await convRow(page, bId).click();
    await expect(page).toHaveURL(new RegExp(`/c/${bId}$`));
    await expect(page.getByTestId('next-sidebar').getByTestId('next-subagent-chip')).toHaveCount(0);
    await expect(page.getByTestId('next-sidebar').getByTestId('next-subagent-tree')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('running sub-agent does not show in sidebar', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const script = await writeScript(prepared.root, 'spawn-live-default.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: HOLD } },
    { text: 'parent-idle' },
    { when: HOLD, delayMs: 20000, text: 'child-done' },
  ]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: script, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '请派子代理');
    await waitSubagentRow(page, conv.id);
    await expect(page.getByTestId('next-sidebar').getByTestId('next-subagent-chip')).toHaveCount(0);
    await expect(page.getByTestId('next-sidebar').getByTestId('next-subagent-tree')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('finished sub-agents report in thread and do not show in sidebar', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const script = await writeScript(prepared.root, 'spawn-done-default.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: 'quick-task' } },
    { text: 'parent-idle' },
    { when: 'quick-task', text: 'child-done' },
  ]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: script, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '请派子代理');
    await expect(page.getByTestId('next-item-subagent-report')).toBeVisible({ timeout: 45000 });
    await expect(page.getByTestId('next-sidebar').getByTestId('next-subagent-chip')).toHaveCount(0);
    await expect(page.getByTestId('next-sidebar').getByTestId('next-subagent-tree')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('opening a sub-agent keeps the parent lightweight and opens in right pane', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const script = await writeScript(prepared.root, 'spawn-two-hold.json', [
    {
      tools: [
        { tool: 'subagent', args: { action: 'spawn', name: 'alpha', message: 'hold-a' } },
        { tool: 'subagent', args: { action: 'spawn', name: 'beta', message: 'hold-b' } },
      ],
    },
    { text: 'parent-idle' },
    { when: 'hold-a', delayMs: 20000, text: 'a-done' },
    { when: 'hold-b', delayMs: 20000, text: 'b-done' },
  ]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: script, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '请派子代理');
    const card = page.getByTestId('next-dispatch-card');
    await expect(card).toBeVisible({ timeout: 45000 });
    const rows = card.getByTestId('next-dispatch-row');
    await expect(rows).toHaveCount(2);

    await rows.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/c/${conv.id}/a/`));
    await expect(page.getByTestId('next-center')).toBeVisible();
    await expect(page.getByTestId('next-subagent-view')).toBeVisible();
    await expect(page.getByTestId('next-right-tab-subagents')).toHaveClass(/active/);

    await convRow(page, conv.id).click();
    await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
    await expect(page.getByTestId('next-subagent-view')).toHaveCount(0);
    await expect(page.getByTestId('next-right-tab-changes')).toHaveClass(/active/);
  } finally {
    await srv.kill();
  }
});

test('dispatch card appears in thread when spawning sub-agent, transitioning from running to done', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const script = await writeScript(prepared.root, 'spawn-card.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: HOLD } },
    { text: 'parent-idle' },
    { when: HOLD, delayMs: 4000, text: 'child-done' },
  ]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: script, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '请派子代理');

    // Wait for the dispatch card to appear in the center chat thread
    const card = page.getByTestId('next-dispatch-card');
    await expect(card).toBeVisible({ timeout: 45000 });

    const row = card.getByTestId('next-dispatch-row').first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('next-dispatch-name')).toHaveText('worker');

    // Status is initially running
    await expect(row).toHaveAttribute('data-status', /running|waiting/);
    await expect(row.getByTestId('next-dispatch-status')).toHaveText(/运行中|排队中|等待中/);

    // After child finishes, status transitions to done
    await expect(row).toHaveAttribute('data-status', 'done', { timeout: 30000 });
    await expect(row.getByTestId('next-dispatch-status')).toHaveText('完成');
  } finally {
    await srv.kill();
  }
});
