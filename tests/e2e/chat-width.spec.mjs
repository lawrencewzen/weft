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
 * Snapshot layout. Notice inject + measure happen in this one evaluate:
 * `renderCenterNotice()` / `renderChatThread()` wipe `#center-notice`, so a
 * separate inject can lose the race with a late usage/status paint.
 */
async function measureChat(page, { injectNotice = false } = {}) {
  return page.evaluate((injectNotice) => {
    const host = document.getElementById('center-notice');
    let createdNotice = false;
    if (injectNotice && host && !host.querySelector('.center-notice-row')) {
      host.innerHTML = '<div class="center-notice-row"><span class="center-notice-text">notice</span></div>';
      createdNotice = true;
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
    const innerBox = inner?.getBoundingClientRect();
    const stackBox = stack?.getBoundingClientRect();
    let contentTop = heroBox?.top;
    let contentBottom = hintBox ? hintBox.bottom : heroBox?.bottom;
    const snap = {
      viewport: window.innerWidth,
      center: center?.getBoundingClientRect().width || 0,
      composer: boxWidth(stack),
      thread: contentWidth(inner),
      threadBox: boxWidth(inner),
      notice: boxWidth(notice),
      noticeFound: Boolean(notice),
      composerLeft: stackBox?.left ?? 0,
      composerRight: stackBox?.right ?? 0,
      innerLeft: innerBox?.left ?? 0,
      innerRight: innerBox?.right ?? 0,
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
      threadScrolls: thread ? thread.scrollHeight > thread.clientHeight + 1 : false,
      scrollbarGutter: thread ? getComputedStyle(thread).scrollbarGutter : '',
    };
    if (createdNotice && host) host.innerHTML = '';
    return snap;
  }, injectNotice);
}

/** Make `.center-thread` overflow, then measure thread/composer edges in the same turn. */
async function measureScrollingAlignment(page) {
  return page.evaluate(() => {
    const thread = document.querySelector('.center-thread');
    const inner = document.querySelector('.thread-inner');
    const stack = document.querySelector('.composer-stack');
    if (!thread || !inner || !stack) return { ok: false };
    let filler = inner.querySelector('[data-chat-width-filler]');
    if (!filler) {
      filler = document.createElement('div');
      filler.setAttribute('data-chat-width-filler', '1');
      filler.style.flexShrink = '0';
      inner.appendChild(filler);
    }
    filler.style.height = `${thread.clientHeight + 120}px`;
    const innerBox = inner.getBoundingClientRect();
    const stackBox = stack.getBoundingClientRect();
    return {
      ok: true,
      scrolls: thread.scrollHeight > thread.clientHeight + 1,
      innerLeft: innerBox.left,
      innerRight: innerBox.right,
      composerLeft: stackBox.left,
      composerRight: stackBox.right,
      scrollbarGutter: getComputedStyle(thread).scrollbarGutter,
    };
  });
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

test('thread and composer stay aligned when the thread has a classic scrollbar', async ({ page }) => {
  await openApp(page, srv);
  await createWorkspace(page, 'demo', ws);
  await newConversation(page);
  await send(page, '写个 README');
  await expect(page.locator('.thread-inner')).toBeVisible();
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  await applyChatLayout(page, CASES[0]);
  const m = await measureScrollingAlignment(page);
  expect(m.ok).toBe(true);
  expect(m.scrolls, 'thread should overflow vertically').toBe(true);
  expect(m.scrollbarGutter).toMatch(/stable/);
  expect(Math.abs(m.innerLeft - m.composerLeft), 'left edges').toBeLessThanOrEqual(2);
  expect(Math.abs(m.innerRight - m.composerRight), 'right edges').toBeLessThanOrEqual(2);
});
