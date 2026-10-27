// Page helpers: drive the real web app, then take a stable snapshot of #root.
import { loginNext } from '../../../tests/e2e/helpers/next.mjs';

/** Values that change between runs (clocks, timers, relative times) are pinned. */
const FROZEN_CLOCK = '00:07';
const FROZEN_SUBAGENT_CLOCK = '00:12';
const FROZEN_RELATIVE = '3 分钟前';
const FROZEN_TS = '1700000000000';

export const RUN_STATUS_DONE = /完成|Done/i;
export const RUN_STATUS_RUNNING = /运行|Running/i;

export function url(srv, p) {
  return `${srv.url}${p}`;
}

export function convUrl(srv, convId) {
  return url(srv, `/c/${encodeURIComponent(convId)}`);
}

export function draftUrl(srv, wsId) {
  return url(srv, `/w/${encodeURIComponent(wsId)}/new`);
}

export async function openPage(page, target) {
  await page.goto(target);
  await page.getByTestId('next-composer-input').waitFor({ timeout: 30000 });
  await ensurePanelsOpen(page);
}

/** 面板的收起状态记在本地，进每个状态前先把它展开。 */
export async function ensurePanelsOpen(page) {
  const shell = page.getByTestId('next-app');
  const cls = (await shell.getAttribute('class')) || '';
  if (cls.includes('left-closed')) {
    const open = page.getByTestId('next-left-open');
    if (await open.isVisible()) await open.click();
  }
  if (cls.includes('right-closed')) {
    const toggle = page.getByTestId('next-right-toggle');
    if (await toggle.isVisible()) await toggle.click();
  }
  await page.getByTestId('next-sidebar').waitFor({ state: 'visible', timeout: 30000 });
  // 右栏选中的标签也会记住，回到「变更」让每个状态从同一个默认页开始。
  const changes = page.getByTestId('next-right-tab-changes');
  if (!((await changes.getAttribute('class')) || '').includes('active')) await changes.click();
}

/** 提案注入的样式只在页面里用，截图时也要加进去才能量到真实布局。 */
export async function injectCss(page, id, css) {
  await page.evaluate(({ styleId, text }) => {
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = text;
    document.head.appendChild(style);
  }, { styleId: id, text: css });
}

export async function login(page, srv) {
  return loginNext(page, srv);
}

export async function typeAndSend(page, text) {
  await page.getByTestId('next-composer-input').fill(text);
  await page.getByTestId('next-send').click();
}

export async function waitDone(page, timeout = 60000) {
  await page.getByTestId('next-run-status').filter({ hasText: RUN_STATUS_DONE }).waitFor({ timeout });
  await page.getByTestId('next-stop').waitFor({ state: 'detached', timeout });
  await page.getByTestId('next-send').waitFor({ state: 'visible', timeout });
}

export async function waitRunning(page, timeout = 60000) {
  await page.getByTestId('next-run-status').filter({ hasText: RUN_STATUS_RUNNING }).waitFor({ timeout });
  await page.getByTestId('next-stop').waitFor({ state: 'visible', timeout });
}

/** Let React flush the last frame before reading the DOM. */
export async function settle(page, ms = 250) {
  await page.waitForTimeout(ms);
}

/**
 * Pin every clock-like text in the live page so the snapshot only reflects
 * layout changes between runs.
 */
export async function freezeVolatile(page) {
  await page.evaluate(({ clock, subClock, relative, ts }) => {
    for (const el of document.querySelectorAll('[data-testid=next-conv-meta][data-rel-time]')) {
      el.textContent = relative;
      el.setAttribute('data-ts', ts);
    }
    for (const el of document.querySelectorAll('.pending-elapsed')) el.textContent = clock;
    const subTime = '[data-testid=next-subagent-time]';
    for (const el of document.querySelectorAll(subTime)) {
      const text = (el.textContent || '').trim();
      if (/^无动作/.test(text)) el.textContent = `无动作 ${subClock}`;
      else if (/^\d{1,2}:\d{2}$/.test(text)) el.textContent = subClock;
    }
  }, {
    clock: FROZEN_CLOCK,
    subClock: FROZEN_SUBAGENT_CLOCK,
    relative: FROZEN_RELATIVE,
    ts: FROZEN_TS,
  });
}

/** Serialized DOM of the app root, after pinning volatile values. */
export async function readRoot(page) {
  await freezeVolatile(page);
  const html = await page.evaluate(() => {
    const root = document.getElementById('root');
    return root ? root.innerHTML : '';
  });
  if (!html.trim()) throw new Error('#root 是空的');
  return html;
}

function replaceSequential(text, pattern, prefix) {
  let n = 0;
  return text.replace(pattern, () => `${prefix}-${String((n += 1)).padStart(2, '0')}`);
}

/**
 * Make the snapshot independent of temp directories, random ids, and timers.
 * `roots` maps absolute paths to stable placeholders; `aliases` maps ids taken
 * from the fixtures (workspaces, conversations) to readable names.
 */
export function normalizeHtml(html, { roots = [], aliases = [] } = {}) {
  let out = html;
  const paths = [...roots].sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of paths) {
    if (!from) continue;
    out = out.split(from).join(to);
  }
  const sortedAliases = [...aliases].sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of sortedAliases) {
    if (!from) continue;
    out = out.split(from).join(to);
  }
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, () => 'uuid');
  out = replaceSequential(out, /uuid/g, 'uuid');
  const providers = new Map();
  out = out.replace(/data-provider="([^"]*)"/g, (_match, id) => {
    if (!providers.has(id)) providers.set(id, `provider-${String(providers.size + 1).padStart(2, '0')}`);
    return `data-provider="${providers.get(id)}"`;
  });
  out = replaceSequential(out, /tool:\d+:[a-z0-9]+/g, 'tool');
  out = out.replace(/\b1[0-9]{12}\b/g, '1700000000000');
  return out;
}
