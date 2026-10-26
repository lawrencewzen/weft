import { test, expect } from '@playwright/test';
import { readDiscovery, startServer } from './helpers/server.mjs';

function attachCspLog(page) {
  const csp = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/content security policy/i.test(text)) csp.push(text);
  });
  return csp;
}

test('GET /next/ without a session prompts to use weft open', async ({ page }) => {
  const srv = await startServer();
  const csp = attachCspLog(page);
  try {
    await page.goto(`${srv.url}/next/`);
    await expect(page.getByTestId('next-app')).toBeVisible();
    await expect(page.getByText('Weft（新版，开发中）')).toBeVisible();
    await expect(page.getByTestId('next-error')).toHaveText('请用 weft open 打开新版网页端');
    expect(csp, 'page console has no CSP errors').toEqual([]);
  } finally {
    await srv.kill();
  }
});

test('GET /next/login?code= exchanges a web-code for a session and shows protocol 2.0.0', async ({ page }) => {
  const srv = await startServer({ extraEnv: { WEFT_V2_HEARTBEAT_MS: '500' } });
  const csp = attachCspLog(page);
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
    expect(body.code).toBeTruthy();

    await page.goto(`${srv.url}/next/login?code=${encodeURIComponent(body.code)}`);
    await expect(page).toHaveURL(/\/next\/$/);
    await expect(page.getByTestId('next-app')).toBeVisible();
    await expect(page.getByTestId('next-sidebar')).toBeVisible();
    await expect(page.getByTestId('next-home-hint')).toHaveText(/点左栏「项目」旁的 \+ 新建工作区|Use \+ next to Projects to add a workspace/);
    expect(csp, 'page console has no CSP errors').toEqual([]);
  } finally {
    await srv.kill();
  }
});

test('GET /next/some/deep/route falls back to the SPA shell', async ({ page }) => {
  const srv = await startServer();
  try {
    await page.goto(`${srv.url}/next/some/deep/route`);
    await expect(page.getByTestId('next-app')).toBeVisible();
    await expect(page.getByText('Weft（新版，开发中）')).toBeVisible();
  } finally {
    await srv.kill();
  }
});

test('GET /next/assets/not-exist.js returns 404', async ({ page }) => {
  const srv = await startServer();
  try {
    const res = await page.request.get(`${srv.url}/next/assets/not-exist.js`);
    expect(res.status()).toBe(404);
  } finally {
    await srv.kill();
  }
});

test('GET / still loads the old frontend', async ({ page }) => {
  const srv = await startServer();
  try {
    await page.goto(`${srv.url}/`);
    await expect(page.getByTestId('new-chat-top')).toBeVisible();
    await expect(page.getByTestId('next-app')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});
