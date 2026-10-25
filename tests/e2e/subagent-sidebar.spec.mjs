import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, openApp } from './helpers/ui.mjs';

const TESTER = 'run:sub:tester';
const CODER = 'run:sub:coder';
const AUDITOR = 'run:sub:auditor';
const NOTE_TEXT = '你对 测试 说：只跑 auth 相关的';
const NUDGE_TEXT = '只跑 auth 相关的';
const FROZEN_NOW = Date.parse('2026-10-24T12:00:00.000Z');

const AGENTS = [
  {
    id: TESTER,
    name: '测试',
    status: 'running',
    step: 2,
    totalSteps: 5,
    lastText: '正在写登录测试，路径很长很长很长很长很长很长很长很长',
    mode: 'foreground',
  },
  {
    id: CODER,
    name: '编码',
    status: 'done',
    lastText: '改完了 auth',
    mode: 'foreground',
  },
  {
    id: AUDITOR,
    name: '审计',
    status: 'waiting',
    lastText: 'auditor',
    mode: 'foreground',
  },
];

const RICH_AGENTS = [
  {
    id: TESTER,
    name: '测试',
    status: 'running',
    title: '写登录单测',
    brief: '你在 /Users/demo/app 里写登录测试\n不要跑支付',
    startedAt: FROZEN_NOW - 5_000,
    lastActivityAt: FROZEN_NOW - 2_000,
    currentAction: '正在读 auth.test.js',
    lastText: '旧的 lastText 不应作为摘要',
    mode: 'foreground',
  },
  {
    id: CODER,
    name: '编码',
    status: 'done',
    brief: '改完 auth 模块',
    startedAt: FROZEN_NOW - 120_000,
    endedAt: FROZEN_NOW - 3_000,
    lastText: '改完了 auth',
    mode: 'foreground',
  },
  {
    id: AUDITOR,
    name: '审计',
    status: 'running',
    brief: '审查权限边界',
    startedAt: FROZEN_NOW - 90_000,
    lastActivityAt: FROZEN_NOW - 65_000,
    currentAction: '等待模型返回',
    lastText: 'auditor',
    mode: 'foreground',
  },
];

function mockedConversation(cid, bag) {
  return {
    id: cid,
    title: bag.title || '请派子代理',
    status: bag.status || 'idle',
    updatedAt: bag.updatedAt,
    modelSourceId: null,
    modelId: null,
    messages: [
      { id: 'user-send', role: 'user', text: '请派子代理' },
      { id: 'asst-reply', role: 'assistant', text: '主对话已收到。' },
      ...(bag.extraMessages || []),
    ],
    agents: bag.agents,
  };
}

function agentMessages(aid, extras = {}, agents = AGENTS) {
  const known = agents.find((item) => item.id === aid) || { id: aid };
  return {
    ...known,
    ...extras,
    messages: extras.messages || [
      { id: `${aid}-u`, role: 'user', text: '请处理 auth' },
      { id: `${aid}-a`, role: 'assistant', text: '正在处理' },
    ],
  };
}

async function fetchRouted(route, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await route.fetch();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (!/ECONNRESET|ECONNREFUSED|socket hang up|net::ERR_/i.test(msg) || i === attempts - 1) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 40 * (i + 1)));
    }
  }
  throw lastErr;
}

async function mockSubagentApi(page, bag) {
  await page.route(/\/api\/workspaces\/[^/]+\/conversations(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const res = await fetchRouted(route);
    const list = await res.json();
    if (!Array.isArray(list)) {
      await route.fulfill({ json: list });
      return;
    }
    await route.fulfill({
      json: list.map((item) => ({
        ...item,
        ...(bag.status != null ? { status: bag.status } : {}),
        ...(bag.updatedAt != null ? { updatedAt: bag.updatedAt } : {}),
        ...(bag.title != null ? { title: bag.title } : {}),
      })),
    });
  });
  await page.route(/\/api\/conversations\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const method = req.method();

    const convGet = pathname.match(/\/api\/conversations\/([^/]+)$/);
    if (method === 'GET' && convGet) {
      await route.fulfill({ json: mockedConversation(decodeURIComponent(convGet[1]), bag) });
      return;
    }

    const msg = pathname.match(/\/api\/conversations\/([^/]+)\/agents\/([^/]+)\/messages$/);
    if (msg) {
      const aid = decodeURIComponent(msg[2]);
      if (method === 'GET') {
        await route.fulfill({ json: agentMessages(aid, bag.agentExtras[aid], bag.agents) });
        return;
      }
      if (method === 'POST') {
        bag.posts.push({ aid, body: req.postDataJSON(), url: req.url() });
        await route.fulfill({ json: { ok: true } });
        return;
      }
    }

    const stop = pathname.match(/\/api\/conversations\/([^/]+)\/agents\/([^/]+)\/stop$/);
    if (stop && method === 'POST') {
      bag.stops.push({ aid: decodeURIComponent(stop[2]), url: req.url() });
      await route.fulfill({ json: { status: 'stopped' } });
      return;
    }

    await route.continue();
  });
}

async function dispatchAgentEvent(page, data) {
  await page.evaluate((payload) => {
    const sources = window.__testEventSources || [];
    const es = sources[sources.length - 1];
    if (!es) throw new Error('no EventSource');
    es.dispatchEvent(new MessageEvent('agent', { data: JSON.stringify(payload) }));
  }, data);
}

async function dispatchStatusEvent(page, data) {
  await page.evaluate((payload) => {
    const sources = window.__testEventSources || [];
    const es = sources[sources.length - 1];
    if (!es) throw new Error('no EventSource');
    es.dispatchEvent(new MessageEvent('status', { data: JSON.stringify(payload) }));
  }, data);
}

async function boot(page, { agents = AGENTS, now, status, title, updatedAt } = {}) {
  const prepared = await prepareWorkspaces(['repo']);
  const scriptPath = path.join(prepared.root, 'sidebar.json');
  await fs.writeFile(scriptPath, JSON.stringify({ turns: [{ text: '主对话已收到。' }] }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  const bag = {
    agents: agents.map((item) => ({ ...item })),
    extraMessages: [{ id: 'note-1', role: 'note', text: NOTE_TEXT }],
    posts: [],
    stops: [],
    agentExtras: {},
    status,
    title,
    updatedAt,
  };
  if (now != null) {
    await page.addInitScript((t0) => {
      window.__WEFT_NOW = t0;
      Date.now = () => window.__WEFT_NOW;
    }, now);
  }
  await page.addInitScript(() => {
    const Orig = window.EventSource;
    window.EventSource = class extends Orig {
      constructor(url, config) {
        super(url, config);
        window.__testEventSources = window.__testEventSources || [];
        window.__testEventSources.push(this);
      }
    };
  });
  await mockSubagentApi(page, bag);
  await openApp(page, srv);
  await createWorkspace(page, 'demo', prepared.dirs[0]);
  await newConversation(page);
  await send(page, '请派子代理');
  await expect(page.getByTestId('subagent-tree-row')).toHaveCount(3, { timeout: 20000 });
  return { srv, bag };
}

function rowOf(page, id) {
  return page.locator(`[data-testid=subagent-tree-row][data-agent-id="${id}"]`);
}

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

test('sidebar tree, chip, pane interrupt/stop, note, and narrow overflow', async ({ page }) => {
  const { srv, bag } = await boot(page);
  try {
    const rows = page.getByTestId('subagent-tree-row');
    await expect(rows).toHaveCount(3);
    const testerRow = rowOf(page, TESTER);
    const coderRow = rowOf(page, CODER);
    const auditorRow = rowOf(page, AUDITOR);
    const conv = page.getByTestId('conversation-item').first();
    await expect(testerRow).toHaveAttribute('data-status', 'running');
    await expect(testerRow).toHaveAttribute('data-depth', '0');
    await expect(coderRow).toHaveAttribute('data-depth', '0');
    await expect(auditorRow).toHaveAttribute('data-depth', '0');
    await expect(coderRow.getByTestId('subagent-tree-time')).toHaveText('');
    await expect(coderRow).toHaveAttribute('data-visual', 'done');
    await expect(testerRow.getByTestId('subagent-tree-summary')).toContainText('正在写登录测试');
    await expect(testerRow.getByTestId('subagent-tree-action')).toHaveCount(0);
    expect(await testerRow.getByTestId('subagent-tree-time').textContent()).toBe('');
    await expect(page.locator('.col-left')).not.toContainText('个完成');

    const pads = await page.evaluate(() => [...document.querySelectorAll('[data-testid=subagent-tree-row]')].map((el) => getComputedStyle(el).paddingLeft));
    expect(new Set(pads).size).toBe(1);
    await expect.poll(async () => auditorRow.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(26);
    const connectors = await page.evaluate(() => [...document.querySelectorAll('[data-testid=subagent-tree-row]')].map((el, i, all) => {
      const before = getComputedStyle(el, '::before');
      const after = getComputedStyle(el, '::after');
      return {
        last: el.classList.contains('is-last'),
        isLastIndex: i === all.length - 1,
        beforeH: parseFloat(before.height),
        afterW: parseFloat(after.width),
        rowH: el.getBoundingClientRect().height,
        treeLine: getComputedStyle(el.closest('.subagent-tree'), '::before').content,
      };
    }));
    expect(connectors.every((item) => item.isLastIndex === item.last)).toBe(true);
    expect(connectors.at(-1).last).toBe(true);
    expect(connectors.slice(0, -1).every((item) => !item.last)).toBe(true);
    expect(connectors.every((item) => item.afterW === 9)).toBe(true);
    expect(connectors.at(-1).beforeH).toBe(13);
    expect(connectors[0].beforeH).toBeGreaterThan(connectors.at(-1).beforeH);
    expect(connectors[0].treeLine === 'none' || connectors[0].treeLine === '').toBe(true);

    const chip = page.getByTestId('subagent-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('2/3');
    await expect(chip).toHaveClass(/is-live/);
    await expect(chip).toHaveAttribute('aria-label', /折叠/);
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    const chipBox = await chip.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { h: Math.round(box.height) };
    });
    expect(chipBox.h).toBe(18);
    await expect(page.getByTestId('subagent-orbit')).toHaveCount(0);
    await expect(page.getByTestId('subagent-tree-toggle')).toHaveCount(0);
    await expect(conv.locator('.conv-node-meta')).toBeVisible();

    await chip.click();
    await expect(page.getByTestId('subagent-pane')).toHaveCount(0);
    await expect(conv).toHaveClass(/conv-active/);
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(chip).toHaveAttribute('aria-label', /展开/);

    const wrap = page.getByTestId('subagent-tree-wrap');
    await expect(wrap).not.toHaveClass(/is-open/);
    const wrapTransition = await wrap.evaluate((el) => getComputedStyle(el).transition);
    expect(wrapTransition).toMatch(/grid-template-rows/);
    const arcTransition = await testerRow.locator('.sa-arc').evaluate((el) => {
      const s = getComputedStyle(el);
      return { transition: s.transition, animation: s.animationDuration, name: s.animationName };
    });
    expect(arcTransition.transition).toMatch(/stroke|opacity/);
    expect(arcTransition.name).not.toBe('none');
    const doneCheck = await coderRow.locator('.sa-check').evaluate((el) => getComputedStyle(el).stroke);
    expect(doneCheck).not.toBe('none');
    const actionSlot = await testerRow.locator('.subagent-tree-action-slot').evaluate((el) => getComputedStyle(el).transition);
    expect(actionSlot).toMatch(/grid-template-rows/);

    const rowText = await rows.allTextContents();
    for (const text of rowText) {
      expect(text).not.toMatch(/undefined|NaN/);
    }

    await expect.poll(async () => wrap.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(2);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toBeVisible();
    await expect.poll(async () => wrap.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(20);

    await testerRow.click();
    await expect(page.getByTestId('subagent-pane')).toBeVisible();
    await expect(page.getByTestId('subagent-banner-text')).toContainText('测试');
    await expect(testerRow).toHaveClass(/is-active/);
    await expect(page.getByTestId('subagent-input')).toBeVisible();
    await expect(page.getByTestId('subagent-send')).toBeVisible();
    await expect(page.getByTestId('subagent-stop')).toBeVisible();

    await page.getByTestId('subagent-input').fill(NUDGE_TEXT);
    await page.getByTestId('subagent-input').press('Enter');
    await expect.poll(() => bag.posts.length).toBe(1);
    expect(bag.posts[0].aid).toBe(TESTER);
    expect(bag.posts[0].body).toEqual({ text: NUDGE_TEXT });
    const pending = page.getByTestId('subagent-nudge-pending');
    await expect(pending).toBeVisible();
    await expect(pending).toContainText(NUDGE_TEXT);
    await expect(pending).toContainText('插话 · 等当前这一步做完');
    await expect(page.getByTestId('subagent-input')).toHaveValue('');

    await page.getByTestId('subagent-stop').click();
    await expect.poll(() => bag.stops.length).toBe(1);
    expect(bag.stops[0].aid).toBe(TESTER);
    await dispatchAgentEvent(page, { id: TESTER, status: 'stopped' });
    await expect(page.getByTestId('subagent-input')).toHaveCount(0);
    await expect(page.getByTestId('subagent-stopped-note')).toBeVisible();
    await expect(page.getByTestId('subagent-stopped-note')).toContainText('已被你停止');
    await expect(testerRow).toHaveAttribute('data-status', 'stopped');
    await expect(testerRow).toHaveAttribute('data-visual', 'stopped');
    await expect(testerRow.getByTestId('subagent-tree-time')).toHaveText('已停止');
    const stopTrans = await testerRow.locator('.sa-stop').evaluate((el) => getComputedStyle(el).transition);
    expect(stopTrans).toMatch(/opacity|transform/);

    await coderRow.click();
    await expect(page.getByTestId('subagent-banner-text')).toContainText('编码');
    await expect(page.getByTestId('subagent-input')).toHaveCount(0);
    await expect(page.getByTestId('subagent-send')).toHaveCount(0);
    await expect(page.getByTestId('subagent-stop')).toHaveCount(0);
    await expect(page.getByTestId('subagent-pane')).toContainText('交回给主 Agent');

    const note = page.locator('#center-thread [data-testid=message][data-role=note]');
    await expect(note).toBeVisible();
    await expect(note).toHaveText(NOTE_TEXT);
    await expect(note).toHaveCSS('font-size', '12px');
    const noteColor = await note.evaluate((el) => getComputedStyle(el).color);
    const userBubble = page.locator('#center-thread [data-testid=message][data-role=user]').first();
    await expect(userBubble).not.toContainText(NOTE_TEXT);
    const userBg = await userBubble.locator('[data-testid=message-body]').evaluate((el) => getComputedStyle(el).backgroundColor);
    const noteBg = await note.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(noteBg).not.toBe(userBg);
    expect(noteColor).not.toBe('rgba(0, 0, 0, 0)');

    await page.setViewportSize({ width: 390, height: 844 });
    // Crossing 860px closes the left overlay in the resize handler. Wait for
    // that before opening it, otherwise the rows can still be in the DOM
    // (count 4) while the panel is already display:none.
    await expect(page.locator('#app-shell')).toHaveClass(/left-closed/);
    await page.locator('.col-center [data-action="toggle-left"]').click();
    await expect(page.locator('#app-shell')).not.toHaveClass(/left-closed/);
    await expect(page.getByTestId('subagent-tree-row')).toHaveCount(3);
    await expect(page.getByTestId('subagent-tree-row').first()).toBeVisible();
    const overflow = await page.evaluate(() => {
      const left = document.querySelector('.col-left');
      const leftBox = left.getBoundingClientRect();
      const nodes = [
        ...document.querySelectorAll('[data-testid=subagent-tree-row]'),
        ...document.querySelectorAll('.conv-node-header'),
        ...document.querySelectorAll('[data-testid=subagent-chip]'),
      ];
      return nodes.map((row) => {
        const box = row.getBoundingClientRect();
        return {
          id: row.getAttribute('data-agent-id') || row.className,
          right: box.right,
          leftRight: leftBox.right,
          scroll: row.scrollWidth,
          client: row.clientWidth,
        };
      });
    });
    for (const row of overflow) {
      expect(row.right, row.id).toBeLessThanOrEqual(row.leftRight + 1);
      expect(row.scroll, row.id).toBeLessThanOrEqual(row.client + 1);
    }
  } finally {
    await srv?.kill();
  }
});

test('brief, elapsed mm:ss, idle, and currentAction', async ({ page }) => {
  const { srv } = await boot(page, { agents: RICH_AGENTS, now: FROZEN_NOW, status: 'running' });
  try {
    const testerRow = rowOf(page, TESTER);
    const coderRow = rowOf(page, CODER);
    const auditorRow = rowOf(page, AUDITOR);

    await expect(testerRow.getByTestId('subagent-tree-summary')).toHaveText('写登录单测');
    await expect(testerRow).toHaveAttribute('title', '写登录单测');
    await expect(testerRow.getByTestId('subagent-tree-summary')).not.toContainText('/Users/');
    await expect(testerRow.getByTestId('subagent-tree-time')).toHaveText('00:05');
    await expect(testerRow.getByTestId('subagent-tree-action')).toHaveText('正在读 auth.test.js');
    await expect(testerRow).toHaveAttribute('data-visual', 'running');

    await expect(coderRow.getByTestId('subagent-tree-summary')).toHaveText('改完 auth 模块');
    await expect(coderRow.getByTestId('subagent-tree-time')).toHaveText('');
    await expect(coderRow.getByTestId('subagent-tree-action')).toHaveCount(0);
    await expect(coderRow).toHaveAttribute('data-visual', 'done');

    await expect(auditorRow.getByTestId('subagent-tree-summary')).toHaveText('审查权限边界');
    await expect(auditorRow.getByTestId('subagent-tree-time')).toHaveText('无动作 01:05');
    await expect(auditorRow.getByTestId('subagent-tree-time')).toHaveClass(/is-idle/);
    await expect(auditorRow).toHaveAttribute('data-visual', 'stuck');
    await expect(auditorRow.getByTestId('subagent-tree-action')).toHaveText('等待模型返回');
    await expect.poll(async () => {
      const stuckArc = await auditorRow.locator('.sa-arc').evaluate((el) => {
        const s = getComputedStyle(el);
        return { duration: Number.parseFloat(s.animationDuration), transition: s.transition };
      });
      expect(stuckArc.duration).toBeGreaterThan(2);
      expect(stuckArc.transition).toMatch(/stroke|opacity/);
      return stuckArc;
    }, { timeout: 2500 }).toBeTruthy();

    await expect(page.getByTestId('subagent-chip')).toHaveText('2/3');
    await expect(page.getByTestId('subagent-chip')).toHaveClass(/is-live/);
    const convDot = page.getByTestId('conversation-item').first().locator('.conv-status-dot');
    await expect(convDot).toHaveClass(/is-running/);
    const pulse = await convDot.evaluate((el) => getComputedStyle(el).animationName);
    expect(pulse).toMatch(/pulse/);

    await page.evaluate(() => { window.__WEFT_NOW += 1000; });
    await expect.poll(async () => testerRow.getByTestId('subagent-tree-time').textContent(), { timeout: 2500 }).toBe('00:06');
    await expect.poll(async () => auditorRow.getByTestId('subagent-tree-time').textContent(), { timeout: 2500 }).toBe('无动作 01:06');

    const rowText = await page.getByTestId('subagent-tree-row').allTextContents();
    for (const text of rowText) {
      expect(text).not.toMatch(/undefined|NaN/);
    }
  } finally {
    await srv?.kill();
  }
});

const DONE_AGENTS = RICH_AGENTS.map((item) => ({
  ...item,
  status: 'done',
  currentAction: undefined,
  lastActivityAt: FROZEN_NOW - 3_000,
  endedAt: FROZEN_NOW - 3_000,
}));

test('quiet list: all done chip, relative time, and no 完成', async ({ page }) => {
  const { srv } = await boot(page, {
    agents: DONE_AGENTS,
    now: FROZEN_NOW,
    status: 'idle',
    updatedAt: FROZEN_NOW - 30_000,
  });
  try {
    const conv = page.getByTestId('conversation-item').first();
    const chip = page.getByTestId('subagent-chip');
    await expect(chip).toHaveText('3');
    await expect(chip).not.toHaveClass(/is-live/);
    await expect(conv.locator('.conv-node-meta')).toContainText('秒前');
    await expect(conv.locator('.conv-status-dot')).toHaveCount(0);
    await expect(rowOf(page, TESTER).getByTestId('subagent-tree-time')).toHaveText('');
    await expect(rowOf(page, CODER).getByTestId('subagent-tree-time')).toHaveText('');
    await expect(rowOf(page, AUDITOR).getByTestId('subagent-tree-time')).toHaveText('');
    await expect(page.locator('.col-left')).not.toContainText('个完成');
    await expect(page.getByTestId('subagent-tree-row').last()).toHaveClass(/is-last/);
    await expect(page.getByTestId('subagent-tree-row').last()).toHaveAttribute('data-agent-id', AUDITOR);
  } finally {
    await srv?.kill();
  }
});

test('quiet list: status dots, failed row, chip toggle, and 200px sidebar', async ({ page }) => {
  const longTitle = '请派子代理来处理一个非常非常非常非常非常非常长的标题好截成省略号';
  const { srv, bag } = await boot(page, {
    agents: RICH_AGENTS,
    now: FROZEN_NOW,
    status: 'running',
    title: longTitle,
    updatedAt: FROZEN_NOW - 5_000,
  });
  try {
    const conv = page.getByTestId('conversation-item').first();
    const chip = page.getByTestId('subagent-chip');
    await expect(chip).toHaveText('2/3');
    await expect(conv.locator('.conv-status-dot')).toHaveClass(/is-running/);
    await expect(rowOf(page, AUDITOR).getByTestId('subagent-tree-time')).toHaveText('无动作 01:05');
    await expect(conv).toHaveClass(/conv-active/);

    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(chip).toHaveAttribute('aria-label', /展开/);
    await expect(page.getByTestId('subagent-pane')).toHaveCount(0);
    await expect(conv).toHaveClass(/conv-active/);
    await expect(page.getByTestId('subagent-tree-wrap')).not.toHaveClass(/is-open/);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('subagent-tree-row').first()).toBeVisible();

    bag.status = 'idle';
    await dispatchStatusEvent(page, { status: 'idle' });
    await expect(conv).toHaveAttribute('data-status', 'idle');
    await expect(conv.locator('.conv-status-dot')).toHaveCount(0);

    bag.status = 'waiting';
    await dispatchStatusEvent(page, { status: 'waiting' });
    await expect(conv.locator('.conv-status-dot')).toHaveClass(/is-waiting/);

    bag.status = 'failed';
    await dispatchStatusEvent(page, { status: 'failed' });
    await expect(conv.locator('.conv-status-dot')).toHaveClass(/is-failed/);

    bag.status = 'done';
    await dispatchStatusEvent(page, { status: 'done' });
    await expect(conv.locator('.conv-status-dot')).toHaveCount(0);

    const coder = bag.agents.find((item) => item.id === CODER);
    if (coder) coder.status = 'failed';
    await dispatchAgentEvent(page, { id: CODER, status: 'failed' });
    await expect(rowOf(page, CODER)).toHaveAttribute('data-visual', 'failed');
    await expect(rowOf(page, CODER).getByTestId('subagent-tree-time')).toHaveText('失败');

    await page.evaluate(() => {
      document.getElementById('app-shell').style.setProperty('--left-w', '200px');
    });
    const measured = await page.evaluate(() => {
      const left = document.querySelector('.col-left');
      const body = document.querySelector('.left-body');
      const header = document.querySelector('.conv-active .conv-node-header');
      const title = header.querySelector('.conv-node-title');
      const chipEl = header.querySelector('[data-testid=subagent-chip]');
      const meta = header.querySelector('.conv-node-meta');
      const leftBox = left.getBoundingClientRect();
      const chipBox = chipEl.getBoundingClientRect();
      const metaBox = meta.getBoundingClientRect();
      return {
        leftW: Math.round(leftBox.width),
        leftScroll: left.scrollWidth,
        leftClient: left.clientWidth,
        bodyScroll: body.scrollWidth,
        bodyClient: body.clientWidth,
        headerScroll: header.scrollWidth,
        headerClient: header.clientWidth,
        titleEllipsis: getComputedStyle(title).textOverflow,
        wrap: getComputedStyle(header).flexWrap,
        chipVisible: chipBox.width > 0 && chipBox.right <= leftBox.right + 1,
        metaVisible: metaBox.width > 0 && metaBox.right <= leftBox.right + 1,
      };
    });
    expect(measured.leftW).toBe(200);
    expect(measured.leftScroll).toBeLessThanOrEqual(measured.leftClient + 1);
    expect(measured.bodyScroll).toBeLessThanOrEqual(measured.bodyClient + 1);
    expect(measured.headerScroll).toBeLessThanOrEqual(measured.headerClient + 1);
    expect(measured.chipVisible).toBe(true);
    expect(measured.metaVisible).toBe(true);
    expect(measured.wrap).toBe('nowrap');
    expect(measured.titleEllipsis).toBe('ellipsis');
  } finally {
    await srv?.kill();
  }
});

const OTHER_AGENTS = [
  {
    id: TESTER,
    name: '测试',
    status: 'running',
    title: '写登录单测',
    brief: '写登录测试',
    startedAt: FROZEN_NOW - 5_000,
    lastActivityAt: FROZEN_NOW - 2_000,
    currentAction: '正在读 auth.test.js',
    mode: 'foreground',
  },
  {
    id: CODER,
    name: '编码',
    status: 'done',
    title: '改完 auth 模块',
    brief: '改完 auth 模块',
    startedAt: FROZEN_NOW - 120_000,
    endedAt: FROZEN_NOW - 3_000,
    lastText: '改完了 auth',
    mode: 'foreground',
  },
  {
    id: AUDITOR,
    name: '审计',
    status: 'stopped',
    title: '审查权限边界',
    brief: '审查权限边界',
    startedAt: FROZEN_NOW - 90_000,
    endedAt: FROZEN_NOW - 10_000,
    lastText: 'auditor',
    mode: 'foreground',
  },
];

function convNode(page, cid) {
  return page.locator(`[data-testid=conversation-item][data-id="${cid}"]`);
}

async function mockOtherSubagentApi(page, bag) {
  await page.route(/\/api\/workspaces\/[^/]+\/conversations(?:\?.*)?$/, async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'POST') {
      let res;
      try {
        res = await fetchRouted(route);
      } catch {
        await route.abort();
        return;
      }
      const body = await res.json();
      bag.created.push(body.id);
      if (bag.created.length === 1) {
        bag.aId = body.id;
        bag.agents[body.id] = [];
      } else if (bag.created.length === 2) {
        bag.bId = body.id;
        bag.subagents[body.id] = { total: 3, live: 1 };
        bag.agents[body.id] = OTHER_AGENTS.map((item) => ({ ...item }));
      }
      await route.fulfill({ status: res.status(), json: body });
      return;
    }
    if (method !== 'GET') {
      await route.continue();
      return;
    }
    let res;
    try {
      res = await fetchRouted(route);
    } catch {
      await route.fulfill({ json: [] });
      return;
    }
    const list = await res.json();
    if (!Array.isArray(list)) {
      await route.fulfill({ json: list });
      return;
    }
    await route.fulfill({
      json: list.map((item) => ({
        ...item,
        ...(bag.subagents[item.id] ? { subagents: { ...bag.subagents[item.id] } } : {}),
      })),
    });
  });
  await page.route(/\/api\/conversations\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const method = req.method();

    const convGet = pathname.match(/\/api\/conversations\/([^/]+)$/);
    if (method === 'GET' && convGet) {
      const cid = decodeURIComponent(convGet[1]);
      await route.fulfill({
        json: mockedConversation(cid, {
          title: cid === bag.bId ? '对话B' : '对话A',
          agents: (bag.agents[cid] || []).map((item) => ({ ...item })),
        }),
      });
      return;
    }

    const agentsList = pathname.match(/\/api\/conversations\/([^/]+)\/agents$/);
    if (method === 'GET' && agentsList) {
      const cid = decodeURIComponent(agentsList[1]);
      bag.agentListHits.push(cid);
      await route.fulfill({ json: { agents: (bag.agents[cid] || []).map((item) => ({ ...item })) } });
      return;
    }

    const msg = pathname.match(/\/api\/conversations\/([^/]+)\/agents\/([^/]+)\/messages$/);
    if (msg) {
      const aid = decodeURIComponent(msg[2]);
      if (method === 'GET') {
        await route.fulfill({ json: agentMessages(aid, {}, bag.agents[bag.bId] || OTHER_AGENTS) });
        return;
      }
    }

    await route.continue();
  });
}

async function bootTwoConversations(page) {
  const prepared = await prepareWorkspaces(['repo']);
  const scriptPath = path.join(prepared.root, 'sidebar-other.json');
  await fs.writeFile(scriptPath, JSON.stringify({ turns: [{ text: '主对话已收到。' }] }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  const bag = {
    created: [],
    aId: '',
    bId: '',
    subagents: {},
    agents: {},
    agentListHits: [],
  };
  await page.addInitScript(() => {
    const Orig = window.EventSource;
    window.EventSource = class extends Orig {
      constructor(url, config) {
        super(url, config);
        window.__testEventSources = window.__testEventSources || [];
        window.__testEventSources.push(this);
      }
    };
  });
  await mockOtherSubagentApi(page, bag);
  await openApp(page, srv);
  await createWorkspace(page, 'demo', prepared.dirs[0]);
  await newConversation(page);
  await send(page, '对话A');
  await expect.poll(() => bag.aId).toBeTruthy();
  await expect(page.getByTestId('conversation-item')).toHaveCount(1, { timeout: 20000 });
  await newConversation(page);
  await send(page, '对话B');
  await expect.poll(() => bag.bId).toBeTruthy();
  await expect(page.getByTestId('conversation-item')).toHaveCount(2, { timeout: 20000 });
  await expect(convNode(page, bag.bId)).toHaveClass(/conv-active/);
  await expect(convNode(page, bag.bId).getByTestId('subagent-tree-row')).toHaveCount(3, { timeout: 20000 });
  await convNode(page, bag.aId).locator('.conv-node-header').click();
  await expect(convNode(page, bag.aId)).toHaveClass(/conv-active/);
  await expect(convNode(page, bag.bId)).not.toHaveClass(/conv-active/);
  return { srv, bag };
}

async function shutdown(page, srv) {
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await srv?.kill();
}

test('other conversation chip stays collapsed until expanded, then opens pane', async ({ page }) => {
  const { srv, bag } = await bootTwoConversations(page);
  try {
    const convA = convNode(page, bag.aId);
    const convB = convNode(page, bag.bId);
    const chipB = convB.getByTestId('subagent-chip');

    await expect(convA).toHaveClass(/conv-active/);
    await expect(convA.getByTestId('subagent-chip')).toHaveCount(0);
    await expect(chipB).toBeVisible();
    await expect(chipB).toHaveText('1/3');
    await expect(chipB).toHaveClass(/is-live/);
    await expect(chipB).toHaveAttribute('aria-expanded', 'false');
    await expect(convB.getByTestId('subagent-tree-row')).toHaveCount(0);
    await expect(convB.getByTestId('subagent-tree-wrap')).toHaveCount(0);
    expect(bag.agentListHits).toEqual([]);

    await chipB.click();
    await expect(chipB).toHaveAttribute('aria-expanded', 'true');
    await expect(convA).toHaveClass(/conv-active/);
    await expect(convB).not.toHaveClass(/conv-active/);
    await expect(convB.getByTestId('subagent-tree-row')).toHaveCount(3);
    await expect(convB.getByTestId('subagent-tree-wrap')).toHaveClass(/is-open/);
    await expect(convB.getByTestId('subagent-tree-row').last()).toHaveClass(/is-last/);
    const connectors = await convB.getByTestId('subagent-tree-row').evaluateAll((rows) => rows.map((el, i, all) => {
      const before = getComputedStyle(el, '::before');
      const after = getComputedStyle(el, '::after');
      return {
        last: el.classList.contains('is-last'),
        isLastIndex: i === all.length - 1,
        afterW: parseFloat(after.width),
        beforeH: parseFloat(before.height),
      };
    }));
    expect(connectors.every((item) => item.isLastIndex === item.last)).toBe(true);
    expect(connectors.every((item) => item.afterW === 9)).toBe(true);
    expect(connectors.at(-1).beforeH).toBe(13);
    await expect.poll(() => bag.agentListHits.length).toBeGreaterThan(0);
    expect(bag.agentListHits[0]).toBe(bag.bId);

    const testerRow = convB.locator(`[data-testid=subagent-tree-row][data-agent-id="${TESTER}"]`);
    await expect(testerRow).toHaveAttribute('data-conv-id', bag.bId);
    await testerRow.click();
    await expect(convB).toHaveClass(/conv-active/);
    await expect(page.getByTestId('subagent-pane')).toBeVisible();
    await expect(page.getByTestId('subagent-banner')).toHaveAttribute('data-agent-id', TESTER);
    await expect(page.getByTestId('subagent-banner-text')).toContainText('写登录单测');
    await expect(convB.locator(`[data-testid=subagent-tree-row][data-agent-id="${TESTER}"]`)).toHaveClass(/is-active/);
  } finally {
    await shutdown(page, srv);
  }
});

test('expanded other conversation refreshes on the 2s poll until live is 0', async ({ page }) => {
  const { srv, bag } = await bootTwoConversations(page);
  try {
    const convB = convNode(page, bag.bId);
    const chipB = convB.getByTestId('subagent-chip');
    await chipB.click();
    await expect(convB.getByTestId('subagent-tree-row')).toHaveCount(3);
    await expect.poll(() => bag.agentListHits.length).toBeGreaterThan(0);
    await expect.poll(() => bag.agentListHits.length, { timeout: 8000 }).toBeGreaterThan(1);

    bag.subagents[bag.bId] = { total: 3, live: 0 };
    for (const agent of bag.agents[bag.bId] || []) {
      if (agent.status === 'running' || agent.status === 'waiting') agent.status = 'done';
    }
    await page.waitForTimeout(2500);
    const afterIdle = bag.agentListHits.length;
    await page.waitForTimeout(5000);
    expect(bag.agentListHits.length).toBe(afterIdle);

    await chipB.click();
    await expect(chipB).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(4500);
    expect(bag.agentListHits.length).toBe(afterIdle);
    expect(bag.agentListHits.every((cid) => cid === bag.bId)).toBe(true);
  } finally {
    await shutdown(page, srv);
  }
});

test('other tree expand set is independent of the current conversation', async ({ page }) => {
  const { srv, bag } = await bootTwoConversations(page);
  try {
    const convA = convNode(page, bag.aId);
    const convB = convNode(page, bag.bId);
    const chipB = convB.getByTestId('subagent-chip');

    await expect(chipB).toHaveAttribute('aria-expanded', 'false');
    await convB.locator('.conv-node-title').click();
    await expect(convB).toHaveClass(/conv-active/);
    await expect(chipB).toHaveAttribute('aria-expanded', 'true');
    await expect(convB.getByTestId('subagent-tree-row')).toHaveCount(3);

    await convA.locator('.conv-node-header').click();
    await expect(convA).toHaveClass(/conv-active/);
    await expect(chipB).toHaveAttribute('aria-expanded', 'false');
    await expect(convB.getByTestId('subagent-tree-row')).toHaveCount(0);

    await chipB.click();
    await expect(chipB).toHaveAttribute('aria-expanded', 'true');
    await expect(convB.getByTestId('subagent-tree-row')).toHaveCount(3);
    await expect(convA).toHaveClass(/conv-active/);

    await convB.locator('.conv-node-title').click();
    await expect(convB).toHaveClass(/conv-active/);
    await expect(chipB).toHaveAttribute('aria-expanded', 'true');

    await convA.locator('.conv-node-header').click();
    await expect(convA).toHaveClass(/conv-active/);
    await expect(chipB).toHaveAttribute('aria-expanded', 'true');
    await expect(convB.getByTestId('subagent-tree-wrap')).toHaveClass(/is-open/);
    await expect(convB.getByTestId('subagent-tree-row')).toHaveCount(3);
  } finally {
    await shutdown(page, srv);
  }
});
