import { test, expect } from '@playwright/test';
import { readDiscovery, startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, statusText, openApp } from './helpers/ui.mjs';
import { loginNext } from './helpers/next.mjs';

test('GET / is the new UI', async ({ page }) => {
  const srv = await startServer();
  try {
    const res = await page.goto(`${srv.url}/`);
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId('next-app')).toBeVisible();
    await expect(page.getByTestId('new-chat-top')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('GET /next and /next/<path> 302 to the same path without the prefix', async () => {
  const srv = await startServer();
  try {
    const root = await fetch(`${srv.url}/next`, { redirect: 'manual' });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/');

    const nested = await fetch(`${srv.url}/next/c/abc?x=1`, { redirect: 'manual' });
    expect(nested.status).toBe(302);
    expect(nested.headers.get('location')).toBe('/c/abc?x=1');

    const slash = await fetch(`${srv.url}/next/settings/about`, { redirect: 'manual' });
    expect(slash.status).toBe(302);
    expect(slash.headers.get('location')).toBe('/settings/about');
  } finally {
    await srv.kill();
  }
});

test('GET /next/login?code= 302s to /auth?code=', async () => {
  const srv = await startServer();
  try {
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
    const res = await fetch(
      `${srv.url}/next/login?code=${encodeURIComponent(body.code)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/auth?code=${encodeURIComponent(body.code)}`);
  } finally {
    await srv.kill();
  }
});

test('GET /auth?code= logs into the new UI', async ({ page }) => {
  const srv = await startServer();
  try {
    await loginNext(page, srv);
    await expect(page.getByTestId('next-app')).toBeVisible();
    await expect(page.getByTestId('next-sidebar')).toBeVisible();
  } finally {
    await srv.kill();
  }
});

test('GET /legacy is the old UI and can chat', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    await openApp(page, srv);
    await expect(page.getByTestId('new-chat-top')).toBeVisible();
    await expect(page.getByTestId('next-app')).toHaveCount(0);
    await createWorkspace(page, 'demo', prepared.dirs[0]);
    await newConversation(page);
    await send(page, '写个 README');
    await expect(page.getByTestId('message').filter({ hasText: '写个 README' })).toBeVisible();
    await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  } finally {
    await srv.kill();
  }
});

test('GET /login?token= still sets the old cookie when WEFT_TOKEN is set', async ({ page }) => {
  const token = 'e2e-legacy-token';
  const srv = await startServer({ extraEnv: { WEFT_TOKEN: token } });
  try {
    const denied = await fetch(`${srv.url}/api/settings`);
    expect(denied.status).toBe(401);

    const login = await fetch(
      `${srv.url}/login?token=${encodeURIComponent(token)}`,
      { redirect: 'manual' },
    );
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/');
    const setCookie = login.headers.get('set-cookie') || '';
    expect(setCookie).toContain(`weft_token=${token}`);

    await page.goto(`${srv.url}/login?token=${encodeURIComponent(token)}`);
    await page.goto(`${srv.url}/legacy`);
    await expect(page.getByTestId('composer-agent')).toBeVisible();
  } finally {
    await srv.kill();
  }
});
