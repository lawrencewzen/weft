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

function treeOf(page, convId) {
  return page.locator(`[data-testid=next-subagent-tree][data-conv-id="${convId}"]`);
}

async function clipStyle(locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      overflow: s.overflow,
      overflowX: s.overflowX,
      overflowY: s.overflowY,
      radius: s.borderRadius,
    };
  });
}

async function waitSubagentRow(page, convId, timeout = 45000) {
  const row = treeOf(page, convId).getByTestId('next-subagent-row').first();
  await expect(row).toBeVisible({ timeout });
  return row;
}

async function writeScript(dir, name, turns) {
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify({ turns }));
  return file;
}

test('demo model badges appear beside the title and under the composer', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await expect(page.getByTestId('next-demo-model-badge')).toBeVisible();
    await expect(page.getByTestId('next-demo-model-badge')).toHaveText('演示模型');
    await expect(page.getByTestId('next-demo-model-chip')).toBeVisible();
    await expect(page.getByTestId('next-demo-model-chip')).toHaveText('演示模型');
  } finally {
    await srv.kill();
  }
});

test('spawning a sub-agent shows a sidebar row and chip; running time ticks', async ({ page }) => {
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
    await expect(page.getByTestId('next-demo-model-badge')).toBeVisible();
    await sendNext(page, '请派子代理');
    const row = await waitSubagentRow(page, conv.id);
    await expect(convRow(page, conv.id).getByTestId('next-subagent-chip')).toBeVisible();
    await expect(convRow(page, conv.id).getByTestId('next-subagent-chip')).toHaveClass(/is-live/);
    await expect(row).toHaveAttribute('data-status', /running|waiting|stuck/);
    await expect(row.getByTestId('next-subagent-time')).toHaveCount(0);
    await expect(row.getByTestId('next-subagent-action')).toHaveCount(0);
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
    await expect(row.getByTestId('next-subagent-time')).toHaveCount(0);
    await expect(row.getByTestId('next-subagent-action')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('other conversation chip expands by subscribing and collapses by unsubscribing', async ({ page }) => {
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
    const chipB = convRow(page, bId).getByTestId('next-subagent-chip');
    await expect(chipB).toBeVisible();
    await expect(chipB).toHaveAttribute('aria-expanded', 'true');
    await expect(treeOf(page, bId).getByTestId('next-subagent-row')).toHaveCount(1, { timeout: 15000 });
    await expect.poll(async () => lastTopics(page), { timeout: 10000 }).toEqual(
      expect.arrayContaining([`conversation:${aId}`, `conversation:${bId}`]),
    );

    // Clicking orbit does not toggle
    await chipB.getByTestId('next-subagent-orbit').click();
    await expect(chipB).toHaveAttribute('aria-expanded', 'true');

    // Clicking toggle chevron toggles collapse/expand
    const toggleB = chipB.getByTestId('next-subagent-toggle');
    await toggleB.click();
    await expect(chipB).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(async () => lastTopics(page), { timeout: 10000 }).not.toContain(`conversation:${bId}`);
    await expect.poll(async () => lastTopics(page)).toContain(`conversation:${aId}`);

    await toggleB.click();
    await expect(chipB).toHaveAttribute('aria-expanded', 'true');
    await expect(treeOf(page, bId).getByTestId('next-subagent-row')).toHaveCount(1, { timeout: 15000 });
    await expect.poll(async () => lastTopics(page), { timeout: 10000 }).toEqual(
      expect.arrayContaining([`conversation:${aId}`, `conversation:${bId}`]),
    );
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
    await expect(page.locator(`[data-testid=next-subagent-row][data-agent-id="${agentId}"]`)).toHaveClass(/is-active/);
    await expect(page.getByTestId('next-demo-model-badge')).toBeVisible();
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

test('expanding conversation A then opening B leaves A expanded', async ({ page }) => {
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
    const chipA = convRow(page, aId).getByTestId('next-subagent-chip');
    await expect(chipA).toHaveAttribute('aria-expanded', 'true');
    const toggleA = chipA.getByTestId('next-subagent-toggle');
    await toggleA.click();
    await expect(chipA).toHaveAttribute('aria-expanded', 'false');
    await toggleA.click();
    await expect(chipA).toHaveAttribute('aria-expanded', 'true');

    await convRow(page, bId).click();
    await expect(page).toHaveURL(new RegExp(`/c/${bId}$`));
    await expect(convRow(page, aId).getByTestId('next-subagent-chip')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeOf(page, aId).getByTestId('next-subagent-row')).toHaveCount(1, { timeout: 15000 });
  } finally {
    await srv.kill();
  }
});

test('with no saved tree state a running sub-agent tree starts open', async ({ page }) => {
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
    await expect(convRow(page, conv.id).getByTestId('next-subagent-chip')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeOf(page, conv.id)).toHaveClass(/is-open/);
  } finally {
    await srv.kill();
  }
});

test('finished sub-agent trees start closed, show a check, and use the name when there is no title', async ({ page }) => {
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
    const chip = convRow(page, conv.id).getByTestId('next-subagent-chip');
    await expect(chip).toBeVisible({ timeout: 45000 });
    await expect(chip).not.toHaveClass(/is-live/, { timeout: 45000 });
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(treeOf(page, conv.id)).not.toHaveClass(/is-open/);

    await chip.getByTestId('next-subagent-toggle').click();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    const doneRow = treeOf(page, conv.id).getByTestId('next-subagent-row').first();
    await expect(doneRow).toBeVisible();
    await expect(doneRow).toHaveAttribute('data-status', 'done');
    await expect(doneRow).toHaveAttribute('data-visual', 'done');
    await expect(doneRow.getByTestId('next-subagent-summary')).toHaveText('worker');
    await expect(doneRow.locator('.sa-check')).toHaveCSS('opacity', '1');
  } finally {
    await srv.kill();
  }
});

test('opening a sub-agent keeps the parent lightweight; tree rails are unclipped and continuous', async ({ page }) => {
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
    const tree = treeOf(page, conv.id);
    const rows = tree.getByTestId('next-subagent-row');
    await expect(rows).toHaveCount(2, { timeout: 45000 });
    await expect(rows.nth(1)).toBeVisible();
    await expect.poll(async () => rows.first().evaluate((el) => getComputedStyle(el).transform)).toBe('none');

    const node = convNode(page, conv.id);
    await expect(node).toHaveClass(/conv-active/);
    await expect(node).not.toHaveClass(/conv-child-active/);
    await expect(convRow(page, conv.id)).not.toHaveClass(/is-child-active/);

    const shells = tree.getByTestId('next-subagent-tree-shell');
    const stem = tree.getByTestId('next-subagent-tree-stem');
    const rails = tree.getByTestId('next-subagent-tree-v');
    const elbows = tree.getByTestId('next-subagent-tree-h');
    await expect(shells).toHaveCount(2);
    await expect(stem).toBeVisible();
    await expect(rails).toHaveCount(2);
    await expect(elbows).toHaveCount(2);

    for (const loc of [stem, shells.first(), shells.last(), rails.first(), rails.last(), elbows.first()]) {
      const css = await clipStyle(loc);
      expect(css.overflow, 'tree rail host must not clip').toBe('visible');
      expect(css.overflowX).toBe('visible');
      expect(css.overflowY).toBe('visible');
      expect(css.radius === '0px' || css.radius === '0px 0px 0px 0px').toBeTruthy();
    }

    const firstRow = await rows.first().boundingBox();
    const lastRow = await rows.last().boundingBox();
    const stemBox = await stem.boundingBox();
    const firstV = await rails.first().boundingBox();
    const lastV = await rails.last().boundingBox();
    const firstH = await elbows.first().boundingBox();
    expect(firstRow).toBeTruthy();
    expect(lastRow).toBeTruthy();
    expect(stemBox).toBeTruthy();
    expect(firstV).toBeTruthy();
    expect(lastV).toBeTruthy();
    expect(firstH).toBeTruthy();
    expect(stemBox.y).toBeLessThanOrEqual(firstRow.y + 0.5);
    expect(firstV.y).toBeLessThanOrEqual(firstRow.y + 2);
    expect(Math.abs((stemBox.y + stemBox.height) - firstV.y)).toBeLessThanOrEqual(1.5);
    expect(lastV.y + lastV.height).toBeGreaterThanOrEqual(lastRow.y + 11);
    expect(lastV.y + lastV.height).toBeLessThan(lastRow.y + lastRow.height);
    expect(Math.abs((firstV.y + firstV.height) - lastV.y)).toBeLessThanOrEqual(1.5);
    expect(firstH.width).toBeGreaterThanOrEqual(8);
    expect(firstH.width).toBeLessThanOrEqual(10);

    await rows.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/c/${conv.id}/a/`));
    await expect(page.getByTestId('next-center')).toBeVisible();
    await expect(page.getByTestId('next-subagent-view')).toBeVisible();
    await expect(page.getByTestId('next-right-tab-subagents')).toHaveClass(/active/);
    await expect(node).not.toHaveClass(/conv-active/);
    await expect(node).toHaveClass(/conv-child-active/);
    await expect(convRow(page, conv.id)).toHaveClass(/is-child-active/);
    await expect(rows.nth(1)).toHaveClass(/is-active/);
    await expect(rows.first()).not.toHaveClass(/is-active/);

    await convRow(page, conv.id).click();
    await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
    await expect(page.getByTestId('next-subagent-view')).toHaveCount(0);
    await expect(page.getByTestId('next-right-tab-changes')).toHaveClass(/active/);
    await expect(node).toHaveClass(/conv-active/);
    await expect(node).not.toHaveClass(/conv-child-active/);
    await expect(convRow(page, conv.id)).not.toHaveClass(/is-child-active/);
    await expect(tree.locator('[data-testid=next-subagent-row].is-active')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});
