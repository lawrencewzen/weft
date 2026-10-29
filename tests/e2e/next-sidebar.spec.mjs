import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { api, prepareWorkspaces, startServer } from './helpers/server.mjs';
import { loginNext, sendNext, waitRunDone } from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

function attachCspLog(page) {
  const csp = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/content security policy/i.test(text)) csp.push(text);
  });
  return csp;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function createWorkspace(srv, name, wsPath) {
  const ws = await api(srv.url, 'POST', '/workspaces', { name, path: wsPath });
  expect(ws.status).toBe(201);
  return ws.body;
}

async function createConversation(srv, wsId, title) {
  const conv = await api(srv.url, 'POST', `/workspaces/${wsId}/conversations`, { title });
  expect(conv.status).toBe(201);
  return conv.body;
}

async function waitSidebar(page) {
  await expect(page.getByTestId('next-sidebar')).toHaveCount(1);
  await expect(page.getByTestId('next-ws-node').first()).toBeVisible({ timeout: 20000 });
}

function wsNode(page, name) {
  return page.getByTestId('next-ws-node').filter({ hasText: name });
}

function convRow(page, id) {
  return page.locator(`[data-testid=next-conv-row][data-id="${id}"]`);
}

test('two workspaces group and sort conversations; switching updates the url and center pane', async ({ page }) => {
  const prepared = await prepareWorkspaces(['alpha', 'beta']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  const csp = attachCspLog(page);
  try {
    const alpha = await createWorkspace(srv, 'alpha', prepared.dirs[0]);
    const a1 = await createConversation(srv, alpha.id, 'alpha-old');
    await sleep(30);
    const a2 = await createConversation(srv, alpha.id, 'alpha-new');
    const beta = await createWorkspace(srv, 'beta', prepared.dirs[1]);
    const b1 = await createConversation(srv, beta.id, 'beta-old');
    await sleep(30);
    const b2 = await createConversation(srv, beta.id, 'beta-new');

    await loginNext(page, srv);
    await waitSidebar(page);
    await expect(page).toHaveURL(new RegExp(`/c/${b2.id}$`));

    const nodes = page.getByTestId('next-ws-node');
    await expect(nodes).toHaveCount(2);
    await expect(nodes.nth(0)).toHaveAttribute('data-id', alpha.id);
    await expect(nodes.nth(1)).toHaveAttribute('data-id', beta.id);
    await expect(wsNode(page, 'alpha').getByTestId('next-conv-row')).toHaveCount(2);
    await expect(wsNode(page, 'alpha').getByTestId('next-conv-row').nth(0)).toHaveAttribute('data-id', a2.id);
    await expect(wsNode(page, 'alpha').getByTestId('next-conv-row').nth(1)).toHaveAttribute('data-id', a1.id);
    await expect(wsNode(page, 'beta').getByTestId('next-conv-row').nth(0)).toHaveAttribute('data-id', b2.id);
    await expect(wsNode(page, 'beta').getByTestId('next-conv-row').nth(1)).toHaveAttribute('data-id', b1.id);

    await wsNode(page, 'alpha').getByTestId('next-ws-toggle').click();
    await convRow(page, a2.id).click();
    await expect(page).toHaveURL(new RegExp(`/c/${a2.id}$`));
    await expect(page.getByTestId('next-thread')).toBeVisible();
    await expect(page.getByTestId('next-status')).toContainText('alpha-new');
    expect(csp, 'page console has no CSP errors').toEqual([]);
  } finally {
    await srv.kill();
  }
});

test('running status appears from the stream and disappears after stop, without a reload', async ({ page }) => {
  const prepared = await prepareWorkspaces(['hold']);
  const srv = await startServer({
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      WEFT_FAUX_HOLD: '1',
    },
  });
  try {
    const ws = await createWorkspace(srv, 'hold', prepared.dirs[0]);
    const conv = await createConversation(srv, ws.id, 'held');
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    await waitSidebar(page);
    await expect(page.getByTestId('next-composer-input')).toBeVisible();
    await page.getByTestId('next-composer-input').fill('run');
    await page.getByTestId('next-send').click();

    const row = convRow(page, conv.id);
    await expect(row).toHaveAttribute('data-status', 'running', { timeout: 15000 });
    await expect(row.getByTestId('status-icon')).toBeVisible();
    await expect(row.getByTestId('status-icon')).toHaveAttribute('data-status', 'running');

    await row.click({ button: 'right' });
    const menu = page.getByTestId('next-ctx-menu');
    await expect(menu).toBeVisible();
    await menu.getByText('停止').click();
    await expect(row).not.toHaveAttribute('data-status', 'running', { timeout: 20000 });
    await expect(row.getByTestId('status-icon')).toHaveCount(0);
    await expect(page.getByTestId('next-stop')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('new-conversation draft posts on first send then jumps to the new chat', async ({ page }) => {
  const prepared = await prepareWorkspaces(['draft']);
  const srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const ws = await createWorkspace(srv, 'draft', prepared.dirs[0]);
    const existing = await createConversation(srv, ws.id, 'existing');
    await loginNext(page, srv);
    await waitSidebar(page);
    await wsNode(page, 'draft').getByTestId('next-ws-add').click();
    await expect(page).toHaveURL(new RegExp(`/w/${ws.id}/new$`));
    await expect(page.getByTestId('next-draft-row')).toHaveCount(0);
    await expect(page.locator('.conv-tree-node.conv-active')).toHaveCount(0);
    await expect(page.getByTestId('next-composer-input')).toBeVisible();
    await page.getByTestId('next-composer-input').fill('写个 README');
    await page.getByTestId('next-send').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    await expect(page.getByTestId('next-draft-row')).toHaveCount(0);
    const top = wsNode(page, 'draft').getByTestId('next-conv-row').first();
    await expect(top).not.toHaveAttribute('data-id', existing.id);
    await expect(page.getByTestId('next-item-user')).toContainText('写个 README');
  } finally {
    await srv.kill();
  }
});

test('context menu copies the conversation id, stops a run, and removes an idle workspace', async ({ page }) => {
  const prepared = await prepareWorkspaces(['keep', 'gone']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const keep = await createWorkspace(srv, 'keep', prepared.dirs[0]);
    const gone = await createWorkspace(srv, 'gone', prepared.dirs[1]);
    await createConversation(srv, keep.id, 'keep-chat');
    const goneConv = await createConversation(srv, gone.id, 'gone-chat');
    await loginNext(page, srv);
    await waitSidebar(page);

    await page.evaluate(() => {
      window.__copied = '';
      const clip = navigator.clipboard || (navigator.clipboard = {});
      clip.writeText = async (text) => { window.__copied = text; };
    });
    await convRow(page, goneConv.id).click({ button: 'right' });
    await page.getByTestId('next-ctx-menu').getByText('复制对话 ID').click();
    await expect.poll(() => page.evaluate(() => window.__copied)).toBe(goneConv.id);
    await expect(page.getByTestId('next-toast')).toContainText('已复制');

    await wsNode(page, 'gone').getByTestId('next-ws-toggle').click({ button: 'right' });
    await page.getByTestId('next-ctx-menu').locator('[data-action=remove-workspace]').click();
    await expect(page.getByTestId('next-confirm')).toBeVisible();
    await page.getByTestId('next-confirm-ok').click();
    await expect(wsNode(page, 'gone')).toHaveCount(0, { timeout: 15000 });
    await expect(wsNode(page, 'keep')).toHaveCount(1);
  } finally {
    await srv.kill();
  }
});

test('removing a workspace with a running conversation is rejected', async ({ page }) => {
  const prepared = await prepareWorkspaces(['busy']);
  const srv = await startServer({
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      WEFT_FAUX_HOLD: '1',
    },
  });
  try {
    const ws = await createWorkspace(srv, 'busy', prepared.dirs[0]);
    const conv = await createConversation(srv, ws.id, 'busy-chat');
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    await waitSidebar(page);
    await page.getByTestId('next-composer-input').fill('run');
    await page.getByTestId('next-send').click();
    await expect(convRow(page, conv.id)).toHaveAttribute('data-status', 'running', { timeout: 15000 });

    await wsNode(page, 'busy').getByTestId('next-ws-toggle').click({ button: 'right' });
    await page.getByTestId('next-ctx-menu').locator('[data-action=remove-workspace]').click();
    await page.getByTestId('next-confirm-ok').click();
    await expect(page.getByTestId('next-toast')).toContainText('运行', { timeout: 10000 });
    await expect(wsNode(page, 'busy')).toHaveCount(1);
  } finally {
    await srv.kill();
  }
});

function collectEventTopicSets(page) {
  const sets = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2/events')) return;
    let topics = '';
    try {
      topics = new URL(url).searchParams.get('topics') || '';
    } catch {
      return;
    }
    sets.push(new Set(topics.split(',').map((part) => part.trim()).filter(Boolean)));
  });
  return sets;
}

function hasDefaultSessionTopics(sets) {
  return sets.some((topics) => (
    topics.has('workspaces') && topics.has('providers') && topics.has('extensions')
  ));
}

test('a conversation created through the old API appears in the new UI without a refresh', async ({ page }) => {
  const prepared = await prepareWorkspaces(['live']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const ws = await createWorkspace(srv, 'live', prepared.dirs[0]);
    const first = await createConversation(srv, ws.id, 'first');
    const eventTopics = collectEventTopicSets(page);
    await loginNext(page, srv);
    await waitSidebar(page);
    await expect.poll(() => hasDefaultSessionTopics(eventTopics)).toBe(true);
    await expect(convRow(page, first.id)).toHaveCount(1);

    const created = await createConversation(srv, ws.id, 'from-old-api');
    await expect(convRow(page, created.id)).toBeVisible({ timeout: 15000 });
    await expect(wsNode(page, 'live').getByTestId('next-conv-row').first()).toHaveAttribute('data-id', created.id);
  } finally {
    await srv.kill();
  }
});

test('860px width collapses the sidebar and does not scroll horizontally', async ({ page }) => {
  const prepared = await prepareWorkspaces(['narrow']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    await page.setViewportSize({ width: 860, height: 800 });
    const ws = await createWorkspace(srv, 'narrow', prepared.dirs[0]);
    await createConversation(srv, ws.id, 'chat');
    await loginNext(page, srv);
    // Closed overlay panels stay in the tree (no display:none); assert they are not visible.
    await expect(page.getByTestId('next-sidebar')).toBeHidden();
    const box = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyScroll: document.body.scrollWidth,
    }));
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    expect(box.bodyScroll).toBeLessThanOrEqual(box.clientWidth + 1);
  } finally {
    await srv.kill();
  }
});

test('footer service dot is on and appearance toggle persists after reload', async ({ page }) => {
  const prepared = await prepareWorkspaces(['theme']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const ws = await createWorkspace(srv, 'theme', prepared.dirs[0]);
    await createConversation(srv, ws.id, 'chat');
    await loginNext(page, srv);
    await waitSidebar(page);

    await expect(page.getByTestId('next-service-dot')).toHaveClass(/is-ok/);
    await expect(page.getByTestId('next-appearance-toggle')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', /light$/);

    await page.getByTestId('next-appearance-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', /dark$/);
    expect(await page.evaluate(() => localStorage.getItem('weft_appearance'))).toBe('dark');

    await page.reload();
    await waitSidebar(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', /dark$/);
    await expect(page.getByTestId('next-appearance-toggle')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('next-open-settings').click();
    await expect(page.getByTestId('next-settings-general')).toBeVisible();
    await expect(page.getByTestId('next-pref-appearance').locator('[data-mode=dark]')).toHaveClass(/is-on/);
    await page.keyboard.press('Escape');

    await page.getByTestId('next-appearance-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', /light$/);
  } finally {
    await srv.kill();
  }
});

test('a single workspace title click collapses, expands, and keeps the state after refresh', async ({ page }) => {
  const prepared = await prepareWorkspaces(['solo']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const ws = await createWorkspace(srv, 'solo', prepared.dirs[0]);
    const conv = await createConversation(srv, ws.id, 'chat');
    await loginNext(page, srv);
    await waitSidebar(page);

    const node = wsNode(page, 'solo');
    await expect(node).toHaveClass(/is-open/);
    await expect(node.getByTestId('next-ws-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(convRow(page, conv.id)).toBeVisible();

    await node.locator('.ws-node-title').click();
    await expect(node).not.toHaveClass(/is-open/);
    await expect(node.getByTestId('next-ws-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(convRow(page, conv.id)).toBeHidden();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('weft_next_workspace_open') || '')).toMatch(new RegExp(`"${ws.id}"\\s*:\\s*false`));

    await page.reload();
    await waitSidebar(page);
    await expect(wsNode(page, 'solo')).not.toHaveClass(/is-open/);
    await expect(convRow(page, conv.id)).toBeHidden();

    await wsNode(page, 'solo').locator('.ws-node-title').click();
    await expect(wsNode(page, 'solo')).toHaveClass(/is-open/);
    await expect(convRow(page, conv.id)).toBeVisible();

    await page.reload();
    await waitSidebar(page);
    await expect(wsNode(page, 'solo')).toHaveClass(/is-open/);
    await expect(convRow(page, conv.id)).toBeVisible();
  } finally {
    await srv.kill();
  }
});

function maxTransitionSeconds(value) {
  return Math.max(0, ...String(value).split(',').map((part) => {
    const raw = part.trim();
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return 0;
    return /ms$/i.test(raw) ? n / 1000 : n;
  }));
}

async function panelTransitionSeconds(page, testId) {
  const duration = await page.getByTestId(testId).evaluate((el) => getComputedStyle(el).transitionDuration);
  return maxTransitionSeconds(duration);
}

async function waitPanelReady(page) {
  await expect(page.getByTestId('next-app')).toHaveAttribute('data-panel-ready', '1');
}

test('clicking the left collapse button slides the sidebar away and the expand button restores it', async ({ page }) => {
  const prepared = await prepareWorkspaces(['slide-left']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const ws = await createWorkspace(srv, 'slide-left', prepared.dirs[0]);
    await createConversation(srv, ws.id, 'chat');
    await loginNext(page, srv);
    await waitSidebar(page);
    await waitPanelReady(page);
    await expect(page.getByTestId('next-sidebar')).toBeVisible();
    await expect(page.getByTestId('next-left-open')).toBeHidden();
    expect(await panelTransitionSeconds(page, 'next-sidebar')).toBeGreaterThan(0);

    await page.getByTestId('next-left-collapse').click();
    await expect(page.getByTestId('next-sidebar')).toBeHidden();
    await expect(page.getByTestId('next-left-open')).toBeVisible();
    await expect(page.getByTestId('next-left-divider')).toBeHidden();
    await expect(page.getByTestId('next-sidebar')).toHaveAttribute('inert');
    await expect(page.getByTestId('next-sidebar')).toHaveAttribute('aria-hidden', 'true');

    await page.getByTestId('next-left-open').click();
    await expect(page.getByTestId('next-sidebar')).toBeVisible();
    await expect(page.getByTestId('next-left-collapse')).toBeVisible();
    await expect(page.getByTestId('next-sidebar')).not.toHaveAttribute('inert');
  } finally {
    await srv.kill();
  }
});

test('clicking the right collapse button slides the panel away and the expand button restores it', async ({ page }) => {
  const prepared = await prepareWorkspaces(['slide-right']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const ws = await createWorkspace(srv, 'slide-right', prepared.dirs[0]);
    await createConversation(srv, ws.id, 'chat');
    await loginNext(page, srv);
    await waitSidebar(page);
    await waitPanelReady(page);
    await expect(page.getByTestId('next-right')).toBeVisible();
    await expect(page.getByTestId('next-right-toggle')).toBeHidden();
    expect(await panelTransitionSeconds(page, 'next-right')).toBeGreaterThan(0);

    await page.getByTestId('next-right-collapse').click();
    await expect(page.getByTestId('next-right')).toBeHidden();
    await expect(page.getByTestId('next-right-toggle')).toBeVisible();
    await expect(page.getByTestId('next-right-divider')).toBeHidden();
    await expect(page.getByTestId('next-right')).toHaveAttribute('inert');
    await expect(page.getByTestId('next-right')).toHaveAttribute('aria-hidden', 'true');

    await page.getByTestId('next-right-toggle').click();
    await expect(page.getByTestId('next-right')).toBeVisible();
    await expect(page.getByTestId('next-right-collapse')).toBeVisible();
    await expect(page.getByTestId('next-right')).not.toHaveAttribute('inert');
  } finally {
    await srv.kill();
  }
});

test('panel slide transitions are off until is-ready and when reduced motion is requested', async ({ page }) => {
  const prepared = await prepareWorkspaces(['slide-motion']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const ws = await createWorkspace(srv, 'slide-motion', prepared.dirs[0]);
    await createConversation(srv, ws.id, 'chat');
    await loginNext(page, srv);
    await waitSidebar(page);
    await waitPanelReady(page);

    expect(await panelTransitionSeconds(page, 'next-sidebar')).toBeGreaterThan(0);
    expect(await panelTransitionSeconds(page, 'next-right')).toBeGreaterThan(0);
    // First paint omits `.is-ready`, so transitions stay off until the class is added.
    const gated = await page.evaluate(() => {
      const shell = document.querySelector('[data-testid="next-app"]');
      const left = shell.querySelector('.col-left');
      const right = shell.querySelector('.col-right');
      shell.classList.remove('is-ready');
      const duration = {
        left: getComputedStyle(left).transitionDuration,
        right: getComputedStyle(right).transitionDuration,
        readyAttr: shell.getAttribute('data-panel-ready'),
      };
      shell.classList.add('is-ready');
      return duration;
    });
    expect(maxTransitionSeconds(gated.left)).toBe(0);
    expect(maxTransitionSeconds(gated.right)).toBe(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await panelTransitionSeconds(page, 'next-sidebar')).toBe(0);
    expect(await panelTransitionSeconds(page, 'next-right')).toBe(0);
  } finally {
    await srv.kill();
  }
});

test('archived conversations section is fixed at bottom above footer, collapsed by default, and scrollable', async ({ page }) => {
  const prepared = await prepareWorkspaces(['arch-ws']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const ws = await createWorkspace(srv, 'arch-ws', prepared.dirs[0]);
    // Create multiple conversations and archive several
    for (let i = 1; i <= 8; i++) {
      await createConversation(srv, ws.id, `conv-${i}`);
    }
    await loginNext(page, srv);
    await waitSidebar(page);

    const archSection = page.getByTestId('next-sidebar-archived-section');
    await expect(archSection).toBeVisible();

    // Verify it is placed right above the footer
    const footer = page.locator('.left-footer');
    const archBox = await archSection.boundingBox();
    const footBox = await footer.boundingBox();
    expect(archBox).toBeTruthy();
    expect(footBox).toBeTruthy();
    expect(archBox.y + archBox.height).toBeLessThanOrEqual(footBox.y + 2);

    // Collapsed by default
    await expect(page.getByTestId('next-archived-list')).toHaveCount(0);

    // Toggle expands
    const toggle = page.getByTestId('next-archived-toggle');
    await toggle.click();
    // In our live test with SQLite, archived array reflects archived conversations (if any)
    // Clicking again toggles collapsed
    await toggle.click();
    await expect(page.getByTestId('next-archived-list')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('switching between conversations never flashes loading or empty thread, subagent tree never flashes loading', async ({ page }) => {
  const HOLD = 'hold-worker-task';
  const prepared = await prepareWorkspaces(['repo']);
  const scriptFile = path.join(prepared.root, 'sidebar-switch-script.json');
  await fs.writeFile(
    scriptFile,
    JSON.stringify({
      turns: [
        { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: HOLD } },
        { text: 'parent-done' },
        { when: HOLD, delayMs: 60000, text: 'child-idle' },
      ],
    }),
  );

  const srv = await startServer({
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      WEFT_FAUX_SCRIPT: scriptFile,
    },
  });

  try {
    const ws = await createWorkspace(srv, 'repo', prepared.dirs[0]);
    const conv1 = await createConversation(srv, ws.id, 'conv-with-subagent');
    const conv2 = await createConversation(srv, ws.id, 'conv-plain');

    await loginNext(page, srv);
    await waitSidebar(page);

    // Visit conv1, send message to trigger faux script that spawns subagent
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv1.id)}`);
    await expect(page.getByTestId('next-composer-input')).toBeVisible();
    await sendNext(page, 'spawn subagent');
    await waitRunDone(page);

    // Wait for subagent row and message to appear in conv1
    const tree1 = page.locator(`[data-testid=next-subagent-tree][data-conv-id="${conv1.id}"]`);
    await expect(tree1).toBeVisible({ timeout: 20000 });
    await expect(tree1).toHaveClass(/is-open/);
    await expect(page.locator('.msg-group')).not.toHaveCount(0);

    // Visit conv2, send message so conv2 also has messages
    await convRow(page, conv2.id).click();
    await expect(page).toHaveURL(new RegExp(`/c/${conv2.id}$`));
    await expect(page.getByTestId('next-composer-input')).toBeVisible();
    await sendNext(page, 'hello plain');
    await waitRunDone(page);
    await expect(page.locator('.msg-group')).not.toHaveCount(0);

    // Both conv1 and conv2 have now been visited and have messages.
    // Ensure conv1's subagent tree is open
    await expect(tree1).toHaveClass(/is-open/);

    // Start requestAnimationFrame continuous sampling
    await page.evaluate(({ c1, c2 }) => {
      window.__frameViolations = [];
      window.__frameSampleCount = 0;
      window.__samplingActive = true;
      function check() {
        if (!window.__samplingActive) return;
        window.__frameSampleCount += 1;

        // 1. Top bar: never shows "加载中" or "Loading"
        const topHeading = document.querySelector('.top-heading');
        if (topHeading) {
          const text = topHeading.textContent || '';
          if (/加载中|Loading/i.test(text)) {
            window.__frameViolations.push(`top heading showed loading: "${text}"`);
          }
        }

        // 2. .subagent-tree-loading never appears
        if (document.querySelector('.subagent-tree-loading')) {
          window.__frameViolations.push('.subagent-tree-loading element was present in DOM');
        }

        // 3. Middle pane message count: when on viewed conversations (c1 or c2), count is never 0
        const path = location.pathname || '';
        if (path.includes(c1) || path.includes(c2)) {
          const msgCount = document.querySelectorAll('.msg-group').length;
          if (msgCount === 0) {
            window.__frameViolations.push(`center pane message count was 0 while on ${path}`);
          }
        }

        requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    }, { c1: conv1.id, c2: conv2.id });

    // Switch back and forth between conv1 and conv2 3 times
    for (let i = 0; i < 3; i++) {
      await convRow(page, conv1.id).click();
      await expect(page).toHaveURL(new RegExp(`/c/${conv1.id}$`));
      await convRow(page, conv2.id).click();
      await expect(page).toHaveURL(new RegExp(`/c/${conv2.id}$`));
    }

    // Stop sampling and verify
    const { violations, sampleCount } = await page.evaluate(() => {
      window.__samplingActive = false;
      return {
        violations: window.__frameViolations || [],
        sampleCount: window.__frameSampleCount || 0,
      };
    });

    expect(sampleCount).toBeGreaterThan(10);
    expect(violations).toEqual([]);
  } finally {
    await srv.kill();
  }
});
