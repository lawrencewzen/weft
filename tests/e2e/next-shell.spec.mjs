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

test('GET / without a session prompts to use weft open', async ({ page }) => {
  const srv = await startServer();
  const csp = attachCspLog(page);
  try {
    await page.goto(`${srv.url}/`);
    await expect(page.getByTestId('next-app')).toBeVisible();
    await expect(page.locator('.next-home h1')).toHaveText('Weft');
    await expect(page.getByTestId('next-error')).toHaveText('请用 weft open 打开新版网页端');
    expect(csp, 'page console has no CSP errors').toEqual([]);
  } finally {
    await srv.kill();
  }
});

test('GET /auth?code= exchanges a web-code for a session and shows protocol 2.0.0', async ({ page }) => {
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

    await page.goto(`${srv.url}/auth?code=${encodeURIComponent(body.code)}`);
    await expect(page).toHaveURL(/http:\/\/127\.0\.0\.1:\d+\/$/);
    await expect(page.getByTestId('next-app')).toBeVisible();
    await expect(page.getByTestId('next-sidebar')).toBeVisible();
    await expect(page.getByTestId('next-home-title')).toHaveText(/还没有项目|No projects yet/);
    await expect(page.getByTestId('next-home-desc')).toHaveText(/添加一个本地目录或 Git 仓库后就可以开始对话|Add a local folder or a Git repository to start chatting/);
    await expect(page.getByTestId('next-home-add')).toBeVisible();
    await page.getByTestId('next-home-add').click();
    await expect(page.getByTestId('next-ws-dialog')).toBeVisible();
    expect(csp, 'page console has no CSP errors').toEqual([]);
  } finally {
    await srv.kill();
  }
});

test('GET /some/deep/route falls back to the SPA shell', async ({ page }) => {
  const srv = await startServer();
  try {
    await page.goto(`${srv.url}/some/deep/route`);
    await expect(page.getByTestId('next-app')).toBeVisible();
    await expect(page.locator('.next-home h1')).toHaveText('Weft');
  } finally {
    await srv.kill();
  }
});

test('GET /assets/not-exist.js returns 404', async ({ page }) => {
  const srv = await startServer();
  try {
    const res = await page.request.get(`${srv.url}/assets/not-exist.js`);
    expect(res.status()).toBe(404);
  } finally {
    await srv.kill();
  }
});

test('GET /legacy 302s to the new frontend', async () => {
  const srv = await startServer();
  try {
    for (const path of ['/legacy', '/legacy/', '/legacy/c/abc?x=1']) {
      const res = await fetch(`${srv.url}${path}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    }
  } finally {
    await srv.kill();
  }
});
