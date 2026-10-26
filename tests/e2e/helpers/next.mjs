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
  await page.goto(`${srv.url}/auth?code=${encodeURIComponent(body.code)}`);
  await expect(page).not.toHaveURL(/\/auth(?:\?|$)/);
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
  await page.goto(`${srv.url}/c/${encodeURIComponent(convId)}`);
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

export async function apiV2(srv, method, apiPath, body) {
  const discovery = await readDiscovery(srv.dataDir);
  const res = await fetch(`${srv.url}${apiPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${discovery.token}`,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

export async function createProviderModels(srv, {
  name = 'Chip',
  models = ['grok-4.6', 'grok-4'],
  defaultModel = 'grok-4.6',
  contextWindow,
} = {}) {
  const created = await apiV2(srv, 'POST', '/api/v2/providers', {
    vendor: 'openai',
    name,
    apiKey: 'sk-chip-test-key1',
    models,
  });
  expect(created.status, created.text).toBe(201);
  const id = created.body.id;
  if (defaultModel) {
    const bound = await apiV2(srv, 'PATCH', `/api/v2/providers/${id}`, { defaultModel });
    expect(bound.status, bound.text).toBe(200);
  }
  if (contextWindow != null) {
    const names = defaultModel ? [defaultModel] : models;
    for (const modelId of names) {
      const win = await apiV2(
        srv,
        'PUT',
        `/api/v2/providers/${id}/models/${encodeURIComponent(modelId)}/context-window`,
        { window: contextWindow },
      );
      expect(win.status, win.text).toBe(200);
    }
  }
  return { id, body: created.body };
}
