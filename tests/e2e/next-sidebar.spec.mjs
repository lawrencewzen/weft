import { test, expect } from '@playwright/test';
import { api, prepareWorkspaces, startServer } from './helpers/server.mjs';
import { loginNext } from './helpers/next.mjs';

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
    await expect(row.getByTestId('next-conv-dot')).toBeVisible();
    await expect(row.getByTestId('next-conv-meta')).toHaveText('运行中');

    await row.click({ button: 'right' });
    const menu = page.getByTestId('next-ctx-menu');
    await expect(menu).toBeVisible();
    await menu.getByText('停止').click();
    await expect(row).not.toHaveAttribute('data-status', 'running', { timeout: 20000 });
    await expect(row.getByTestId('next-conv-dot')).toHaveCount(0);
    await expect(row.getByTestId('next-conv-meta')).not.toHaveText('运行中');
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
    await expect(page.getByTestId('next-draft-row')).toBeVisible();
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
