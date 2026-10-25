import { expect } from '@playwright/test';
import { api, readDiscovery } from './server.mjs';

export async function loginNext(page, srv) {
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
  await expect(page).toHaveURL(/\/next\//);
  await expect(page.getByTestId('next-app')).toBeVisible();
  await expect(page.getByTestId('next-sidebar')).toHaveCount(1);
  return discovery;
}

export async function openWorkspaceConversation(srv, name, wsPath, title = 'chat') {
  const ws = await api(srv.url, 'POST', '/workspaces', { name, path: wsPath });
  expect(ws.status).toBe(201);
  const conv = await api(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, { title });
  expect(conv.status).toBe(201);
  return { ws: ws.body, conv: conv.body };
}

export async function openNextChat(page, srv, convId) {
  await loginNext(page, srv);
  await page.goto(`${srv.url}/next/c/${encodeURIComponent(convId)}`);
  await expect(page.getByTestId('next-thread')).toBeVisible();
  await expect(page.getByTestId('next-composer-input')).toBeVisible();
}

export async function sendNext(page, text) {
  await page.getByTestId('next-composer-input').fill(text);
  await page.getByTestId('next-send').click();
}

export function runStatus(page) {
  return page.getByTestId('next-run-status');
}

export async function waitRunDone(page, timeout = 30000) {
  await expect(runStatus(page)).toHaveText(/完成|Done/i, { timeout });
  await expect(page.getByTestId('next-stop')).toHaveCount(0);
  await expect(page.getByTestId('next-send')).toBeVisible();
}

export async function waitRunStopped(page, timeout = 20000) {
  await expect(runStatus(page)).toHaveText(/已停止|Stopped/i, { timeout });
  await expect(page.getByTestId('next-stop')).toHaveCount(0);
}
