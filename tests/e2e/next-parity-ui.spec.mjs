import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import {
  openNextChat,
  openWorkspaceConversation,
  sendNext,
  waitRunDone,
} from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

const BACKGROUND_NAME = '巡查';
const BACKGROUND_MESSAGE = '请在后台查看仓库。';
const CHILD_TEXT = '仓库干净，没有未提交改动。';
const REPORT_MARKER = '[subagent 巡查 answered, no reply needed]';
const CHIP_USED_200 = '8%';
const CHIP_ZERO_200 = '0%';

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
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '请派子代理');

    const card = page.getByTestId('next-item-subagent-report');
    await expect(card).toBeVisible({ timeout: 45000 });
    await expect(card).toHaveAttribute('data-kind', 'subagent-report');
    await expect(card).toHaveClass(/msg-side-agent/);
    await expect(card).not.toHaveClass(/is-open/);
    await expect(card.getByTestId('next-subagent-report-summary')).toContainText('子 Agent「');
    await expect(card.getByTestId('next-subagent-report-summary')).toContainText('已交回结果');
    await expect(card.getByTestId('next-subagent-report-body')).toBeHidden();

    const users = page.getByTestId('next-item-user');
    await expect(users).toHaveCount(1);
    await expect(users).toContainText('请派子代理');
    await expect(users).not.toContainText(REPORT_MARKER);
    await expect(users).not.toContainText(CHILD_TEXT);
    await expect(page.getByTestId('next-item-user').filter({ hasText: REPORT_MARKER })).toHaveCount(0);

    await card.getByTestId('next-subagent-report-summary').click();
    await expect(card).toHaveClass(/is-open/);
    await expect(card.getByTestId('next-subagent-report-body')).toBeVisible();
    await expect(card.getByTestId('next-subagent-report-body')).toContainText(CHILD_TEXT);

    await page.reload();
    await expect(page.getByTestId('next-item-subagent-report')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('next-item-subagent-report')).toHaveAttribute('data-kind', 'subagent-report');
    await expect(page.getByTestId('next-item-user')).toHaveCount(1);
    await expect(page.getByTestId('next-item-user')).not.toContainText(REPORT_MARKER);
    await expect(page.getByTestId('next-subagent-report-summary')).toContainText('已交回结果');
    await expect(page.getByTestId('next-subagent-report-body')).toBeHidden();
    await page.getByTestId('next-subagent-report-summary').click();
    await expect(page.getByTestId('next-subagent-report-body')).toBeVisible();
    await expect(page.getByTestId('next-subagent-report-body')).toContainText(CHILD_TEXT);
  } finally {
    await srv.kill();
  }
});

test('stored answered and failed reports render as cards without a user bubble', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const scriptPath = path.join(prepared.root, 'stored-report.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: [
      { text: '主对话已收到。' },
      { when: 'no reply needed', text: '已记下巡查结果。' },
      { when: 'timed out', text: '失败已记下。' },
    ],
  }));
  const answered = `[subagent 巡查 answered, no reply needed] ${CHILD_TEXT}`;
  const failed = '[subagent 编码 failed: timed out]';
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '请派子代理');
    await waitRunDone(page);
    await sendNext(page, answered);
    await waitRunDone(page);
    await sendNext(page, failed);
    await waitRunDone(page);

    const cards = page.getByTestId('next-item-subagent-report');
    await expect(cards).toHaveCount(2, { timeout: 20000 });
    await expect(cards.nth(0).getByTestId('next-subagent-report-summary')).toContainText(`子 Agent「${BACKGROUND_NAME}」已交回结果`);
    await expect(cards.nth(0).getByTestId('status-icon')).toHaveAttribute('data-status', 'done');
    await expect(cards.nth(1)).toHaveClass(/is-failed/);
    await expect(cards.nth(1).getByTestId('next-subagent-report-summary')).toContainText('子 Agent「编码」没完成');
    await expect(cards.nth(1).getByTestId('status-icon')).toHaveAttribute('data-status', 'failed');
    await expect(cards.nth(1).getByTestId('next-subagent-report-summary')).toContainText('timed out');

    const users = page.getByTestId('next-item-user');
    await expect(users).toHaveCount(1);
    await expect(users).toContainText('请派子代理');
    await expect(users).not.toContainText(REPORT_MARKER);
    await expect(users).not.toContainText('failed:');

    await cards.nth(1).getByTestId('next-subagent-report-summary').click();
    await expect(cards.nth(1).getByTestId('next-subagent-report-body')).toContainText('timed out');
  } finally {
    await srv.kill();
  }
});

test('860px window does not scroll horizontally; thread and composer stay aligned', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await page.setViewportSize({ width: 860, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const empty = await page.evaluate(() => {
      const se = document.scrollingElement || document.documentElement;
      const inner = document.querySelector('.thread-inner');
      const stack = document.querySelector('.composer-stack');
      return {
        scrollWidth: se.scrollWidth,
        innerWidth: window.innerWidth,
        composer: stack ? stack.getBoundingClientRect().width : 0,
        center: document.querySelector('.col-center')?.getBoundingClientRect().width || 0,
        innerLeft: inner?.getBoundingClientRect().left ?? 0,
        innerRight: inner?.getBoundingClientRect().right ?? 0,
        composerLeft: stack?.getBoundingClientRect().left ?? 0,
        composerRight: stack?.getBoundingClientRect().right ?? 0,
      };
    });
    expect(empty.scrollWidth).toBeLessThanOrEqual(empty.innerWidth);
    expect(empty.composer).toBeGreaterThan(0);
    expect(empty.composer).toBeLessThanOrEqual(empty.center - 24);
    expect(Math.abs(empty.innerLeft - empty.composerLeft), 'left edges').toBeLessThanOrEqual(2);
    expect(Math.abs(empty.innerRight - empty.composerRight), 'right edges').toBeLessThanOrEqual(2);

    await sendNext(page, '写个 README');
    await waitRunDone(page);
    const filled = await page.evaluate(() => {
      const inner = document.querySelector('.thread-inner');
      const stack = document.querySelector('.composer-stack');
      return {
        innerLeft: inner?.getBoundingClientRect().left ?? 0,
        innerRight: inner?.getBoundingClientRect().right ?? 0,
        composerLeft: stack?.getBoundingClientRect().left ?? 0,
        composerRight: stack?.getBoundingClientRect().right ?? 0,
        scrollWidth: (document.scrollingElement || document.documentElement).scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
    expect(filled.scrollWidth).toBeLessThanOrEqual(filled.innerWidth);
    expect(Math.abs(filled.innerLeft - filled.composerLeft), 'left edges after send').toBeLessThanOrEqual(2);
    expect(Math.abs(filled.innerRight - filled.composerRight), 'right edges after send').toBeLessThanOrEqual(2);
  } finally {
    await srv.kill();
  }
});

test('context chip shows reported usage over the configured window', async ({ page }) => {
  const prepared = await prepareWorkspaces(['usage']);
  const srv = await startServer({
    script: 'usage.json',
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      LLM_CONTEXT_WINDOW: '200000',
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'usage', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await expect(page.getByTestId('next-context-chip')).toHaveText(CHIP_ZERO_200);
    await sendNext(page, 'count tokens');
    await expect(page.getByTestId('next-context-chip')).toHaveText(CHIP_USED_200, { timeout: 20000 });
    await waitRunDone(page);
    await page.reload();
    await expect(page.getByTestId('next-context-chip')).toHaveText(CHIP_USED_200, { timeout: 20000 });
  } finally {
    await srv.kill();
  }
});

test('context chip stays at 0% when the model reports no usage', async ({ page }) => {
  const prepared = await prepareWorkspaces(['plain']);
  const srv = await startServer({
    script: 'no-usage.json',
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      LLM_CONTEXT_WINDOW: '200000',
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'plain', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, 'hello');
    await waitRunDone(page);
    await expect(page.getByTestId('next-context-chip')).toHaveText(CHIP_ZERO_200);
    await page.reload();
    await expect(page.getByTestId('next-context-chip')).toHaveText(CHIP_ZERO_200, { timeout: 20000 });
  } finally {
    await srv.kill();
  }
});
