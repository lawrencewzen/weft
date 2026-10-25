import { test, expect } from '@playwright/test';
import { startServer } from './helpers/server.mjs';

function attachCspLog(page) {
  const csp = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/content security policy/i.test(text)) csp.push(text);
  });
  return csp;
}

test('GET /next/ renders the next-app shell', async ({ page }) => {
  const srv = await startServer();
  const csp = attachCspLog(page);
  try {
    await page.goto(`${srv.url}/next/`);
    await expect(page.getByTestId('next-app')).toBeVisible();
    await expect(page.getByText('Weft（新版，开发中）')).toBeVisible();
    await expect(page.locator('[data-testid="next-protocol"], [data-testid="next-error"]')).toBeVisible();
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
