import { test, expect } from '@playwright/test';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, statusText, openApp } from './helpers/ui.mjs';

let srv, ws;
test.beforeEach(async () => {
  const prepared = await prepareWorkspaces(['ws']);
  ws = prepared.dirs[0];
  srv = await startServer({ script: 'basic.json', extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
});
test.afterEach(async () => { await srv?.kill(); });

/** Same formula as public/app.css `--chat-w`. */
function chatW(centerW, viewportW) {
  return Math.min(centerW - 32, Math.max(560, Math.min(centerW - 96, viewportW - 800)));
}

const CASES = [
  { name: '1720 default sidebars', width: 1720, leftW: 264, rightW: 440, leftOpen: true, rightOpen: true, expected: 920 },
  { name: '1720 both sidebars closed', width: 1720, leftW: 264, rightW: 440, leftOpen: false, rightOpen: false, expected: 920 },
  { name: '1720 sidebars 340/600', width: 1720, leftW: 340, rightW: 600, leftOpen: true, rightOpen: true, expected: 684 },
  { name: '1720 sidebars 380/720 floor', width: 1720, leftW: 380, rightW: 720, leftOpen: true, rightOpen: true, expected: 560 },
  { name: '1440 default sidebars', width: 1440, leftW: 264, rightW: 440, leftOpen: true, rightOpen: true, expected: 640 },
  { name: '1920 default sidebars', width: 1920, leftW: 264, rightW: 440, leftOpen: true, rightOpen: true, expected: 1120 },
];

async function applyChatLayout(page, { width, leftW, rightW, leftOpen, rightOpen }) {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(({ leftW, rightW, leftOpen, rightOpen }) => {
    const shell = document.getElementById('app-shell');
    shell.style.setProperty('--left-w', `${leftW}px`);
    shell.style.setProperty('--right-w', `${rightW}px`);
    shell.classList.toggle('left-closed', !leftOpen);
    shell.classList.toggle('right-closed', !rightOpen);
  }, { leftW, rightW, leftOpen, rightOpen });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * Snapshot layout. When `injectNotice` is set, (re)create `.center-notice-row`
 * in the same turn as the measurement: `renderCenterNotice()` / `renderChatThread()`
 * wipe `#center-notice`, so a separate inject can lose the race with a late
 * usage/status paint.
 */
async function measureChat(page, { injectNotice = false } = {}) {
  return page.evaluate((injectNotice) => {
    if (injectNotice) {
      const host = document.getElementById('center-notice');
      if (host) {
        host.innerHTML = '<div class="center-notice-row"><span class="center-notice-text">notice</span></div>';
      }
    }
    const boxWidth = (el) => el ? el.getBoundingClientRect().width : 0;
    const contentWidth = (el) => {
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    };
    const center = document.getElementById('col-center');
    const stack = document.querySelector('.composer-stack');
    const inner = document.querySelector('.thread-inner');
    const notice = document.querySelector('.center-notice-row');
    const composer = document.querySelector('.center-composer');
    const box = document.querySelector('.composer-box');
    const hero = document.querySelector('.draft-hero');
    const hint = document.querySelector('.draft-hint');
    const stage = document.querySelector('.draft-stage');
    const bar = document.querySelector('.center-top-bar');
    const thread = document.querySelector('.center-thread');
    const firstMsg = document.querySelector('.thread-inner > *');
    const se = document.scrollingElement || document.documentElement;
    const heroBox = hero?.getBoundingClientRect();
    const hintBox = hint && getComputedStyle(hint).display !== 'none' ? hint.getBoundingClientRect() : null;
    const stageBox = stage && getComputedStyle(stage).display !== 'none' ? stage.getBoundingClientRect() : null;
    let contentTop = heroBox?.top;
    let contentBottom = hintBox ? hintBox.bottom : heroBox?.bottom;
    return {
      viewport: window.innerWidth,
      center: center?.getBoundingClientRect().width || 0,
      composer: boxWidth(stack),
      thread: contentWidth(inner),
      threadBox: boxWidth(inner),
      notice: boxWidth(notice),
      noticeFound: Boolean(notice),
      composerBottom: box?.getBoundingClientRect().bottom ?? 0,
      footerBottom: composer?.getBoundingClientRect().bottom ?? 0,
      heroMid: heroBox ? (heroBox.top + heroBox.bottom) / 2 : 0,
      groupMid: contentTop != null && contentBottom != null ? (contentTop + contentBottom) / 2 : 0,
      stageMid: stageBox ? (stageBox.top + stageBox.bottom) / 2 : 0,
      spaceTop: bar?.getBoundingClientRect().bottom ?? 0,
      spaceBottom: composer?.getBoundingClientRect().top ?? 0,
      threadTop: thread?.getBoundingClientRect().top ?? 0,
      innerTop: inner?.getBoundingClientRect().top ?? 0,
      firstMsgTop: firstMsg?.getBoundingClientRect().top ?? 0,
      scrollWidth: se.scrollWidth,
      innerWidth: window.innerWidth,
    };
  }, injectNotice);
}

test('composer, thread and notice follow W; empty composer sits at the filled bottom', async ({ page }) => {
  await openApp(page, srv);
  await createWorkspace(page, 'demo', ws);
  await newConversation(page);
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await expect(page.locator('.col-center')).toHaveClass(/is-draft/);

  await applyChatLayout(page, CASES[0]);
  const empty = await measureChat(page);
  expect(empty.spaceBottom).toBeGreaterThan(empty.spaceTop);
  expect(Math.abs(empty.groupMid - empty.stageMid)).toBeLessThanOrEqual(8);

  await send(page, '写个 README');
  await expect(page.getByTestId('message').filter({ hasText: '写个 README' })).toBeVisible();
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  await expect(page.locator('.thread-inner')).toBeVisible();
  await expect(page.locator('.col-center')).not.toHaveClass(/is-draft/);

  const filled = await measureChat(page);
  expect(Math.abs(filled.composerBottom - empty.composerBottom)).toBeLessThanOrEqual(2);
  expect(Math.abs(filled.footerBottom - empty.footerBottom)).toBeLessThanOrEqual(2);
  expect(filled.firstMsgTop).toBeGreaterThanOrEqual(filled.threadTop);
  expect(filled.firstMsgTop).toBeLessThanOrEqual(filled.innerTop + 24);

  for (const c of CASES) {
    await applyChatLayout(page, c);
    const m = await measureChat(page, { injectNotice: true });
    expect(m.noticeFound, `${c.name} notice row present`).toBe(true);
    const fromCenter = chatW(m.center, m.viewport);
    expect(Math.abs(m.composer - c.expected), `${c.name} composer vs example W`).toBeLessThanOrEqual(2);
    expect(Math.abs(m.thread - c.expected), `${c.name} thread vs example W`).toBeLessThanOrEqual(2);
    expect(Math.abs(m.threadBox - c.expected), `${c.name} thread box vs example W`).toBeLessThanOrEqual(2);
    expect(Math.abs(m.notice - c.expected), `${c.name} notice vs example W`).toBeLessThanOrEqual(2);
    expect(Math.abs(m.composer - fromCenter), `${c.name} composer vs formula`).toBeLessThanOrEqual(2);
    expect(Math.abs(m.thread - m.composer), `${c.name} thread vs composer`).toBeLessThanOrEqual(2);
  }
});

test('860px window does not scroll horizontally', async ({ page }) => {
  await openApp(page, srv);
  await createWorkspace(page, 'demo', ws);
  await newConversation(page);
  await applyChatLayout(page, { width: 860, leftW: 264, rightW: 440, leftOpen: true, rightOpen: true });
  const m = await measureChat(page);
  expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
  expect(m.composer).toBeGreaterThan(0);
  expect(m.composer).toBeLessThanOrEqual(m.center - 24);
});
