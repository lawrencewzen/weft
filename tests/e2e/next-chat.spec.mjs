import { test, expect } from '@playwright/test';
import { readDiscovery, startServer, prepareWorkspaces, api } from './helpers/server.mjs';

function attachCspLog(page) {
  const csp = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/content security policy/i.test(text)) csp.push(text);
  });
  return csp;
}

async function loginNext(page, srv) {
  const discovery = await readDiscovery(srv.dataDir);
  const issued = await fetch(`${srv.url}/api/v2/auth/web-code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${discovery.token}`,
    },
    body: '{}',
  });
  expect(issued.status).toBe(200);
  const body = await issued.json();
  await page.goto(`${srv.url}/next/login?code=${encodeURIComponent(body.code)}`);
  await expect(page).toHaveURL(/\/next\/$/);
}

async function openWorkspaceConversation(srv, name, wsPath, title = 'chat') {
  const ws = await api(srv.url, 'POST', '/workspaces', { name, path: wsPath });
  expect(ws.status).toBe(201);
  const conv = await api(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, { title });
  expect(conv.status).toBe(201);
  return { ws: ws.body, conv: conv.body };
}

test('sends a message and the live assistant item becomes the final one', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  const csp = attachCspLog(page);
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/next/c/${encodeURIComponent(conv.id)}`);
    await expect(page.getByTestId('next-thread')).toBeVisible();
    await page.getByTestId('next-composer-input').fill('写个 README');
    await page.getByTestId('next-send').click();
    await expect(page.getByTestId('next-item-user')).toContainText('写个 README');
    const assistant = page.getByTestId('next-item-assistant').first();
    await expect(assistant).toBeVisible({ timeout: 20000 });
    await expect(assistant).toHaveAttribute('data-streaming', 'false', { timeout: 20000 });
    await expect(assistant).not.toHaveAttribute('data-id', /^live:/);
    await expect(page.getByTestId('next-tool-group')).toBeVisible({ timeout: 20000 });
    await page.getByTestId('next-tool-group-summary').click();
    await expect(page.getByTestId('next-tool-row').first()).toBeVisible();
    expect(csp, 'page console has no CSP errors').toEqual([]);
  } finally {
    await srv.kill();
  }
});

test('a tool-script conversation shows the group summary and rows when expanded', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const ws = prepared.dirs[0];
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
    await fs.writeFile(path.join(ws, name), `${name}\n`);
  }
  await fs.writeFile(path.join(ws, 'long.txt'), 'L01\n');
  const srv = await startServer({
    script: 'tool-collapse.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  const csp = attachCspLog(page);
  try {
    const { conv } = await openWorkspaceConversation(srv, 'tools', ws);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/next/c/${encodeURIComponent(conv.id)}`);
    await page.getByTestId('next-composer-input').fill('看看');
    await page.getByTestId('next-send').click();
    await expect(page.getByTestId('next-tool-group-text')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('next-tool-group-text')).toContainText(/读了|Read/);
    await page.getByTestId('next-tool-group-summary').click();
    await expect(page.getByTestId('next-tool-row').first()).toBeVisible();
    expect(csp, 'page console has no CSP errors').toEqual([]);
  } finally {
    await srv.kill();
  }
});

test('the send button becomes stop while WEFT_FAUX_HOLD=1 and stop ends the run', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const srv = await startServer({
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      WEFT_FAUX_HOLD: '1',
    },
  });
  const csp = attachCspLog(page);
  try {
    const { conv } = await openWorkspaceConversation(srv, 'hold', prepared.dirs[0]);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/next/c/${encodeURIComponent(conv.id)}`);
    await page.getByTestId('next-composer-input').fill('run');
    await page.getByTestId('next-send').click();
    await expect(page.getByTestId('next-item-user')).toContainText('run');
    await expect(page.getByTestId('next-stop')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('next-stop').click();
    await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 20000 });
    await expect(page.getByTestId('next-send')).toBeVisible();
    expect(csp, 'page console has no CSP errors').toEqual([]);
  } finally {
    await srv.kill();
  }
});
