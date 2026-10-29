import { expect } from '@playwright/test';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
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
  const url = page.url();
  const match = url.match(/\/c\/([^/?#]+)/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    return page.locator(`[data-testid="next-conv-row"][data-id="${id}"]`);
  }
  return page.locator('[data-testid="next-conv-row"].conv-active, [data-testid="next-conv-row"]').first();
}

export async function waitRunDone(page, timeout = 30000) {
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout });
  await expect(page.getByTestId('next-send')).toBeVisible();
  const row = runStatus(page);
  if (await row.count() > 0) {
    await expect(row).not.toHaveAttribute('data-status', 'running', { timeout });
  }
  // 避免断流重试期间短暂变为 done 又变回 running 的抖动
  await page.waitForTimeout(300);
  await expect(page.getByTestId('next-stop')).toHaveCount(0);
  await expect(page.getByTestId('next-send')).toBeVisible();
  if (await row.count() > 0) {
    await expect(row).not.toHaveAttribute('data-status', 'running');
  }
}

export async function waitRunStopped(page, timeout = 20000) {
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout });
  const row = runStatus(page);
  if (await row.count() > 0) {
    await expect(row).toHaveAttribute('data-status', /stopped|idle/, { timeout });
  }
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
  const id = 'custom-chip0001';
  const store = createSqliteStore(srv.dataDir);
  let savedProvider;
  try {
    const cur = await store.getSettings();
    const modelList = models.map((m) => {
      let displayName = m;
      if (m === 'grok-4.6') displayName = 'Grok 4.6';
      else if (m === 'grok-4') displayName = 'Grok 4';
      return { id: m, name: displayName };
    });
    const overrides = {};
    if (contextWindow != null) {
      const names = defaultModel ? [defaultModel] : models;
      for (const m of names) {
        overrides[m] = { contextWindow };
      }
    }
    const entry = {
      id,
      kind: 'custom',
      name,
      baseUrl: 'http://127.0.0.1:9099/v1',
      api: 'openai-completions',
      enabled: models,
      overrides,
      lastTest: { ok: true, at: Date.now() },
    };
    const nextProviders = (cur.providers || []).filter((p) => p.id !== id).concat(entry);
    const nextSettings = {
      ...cur,
      providers: nextProviders,
      defaultModel: defaultModel ? { providerId: id, modelId: defaultModel } : cur.defaultModel,
    };
    await store.replaceSettings(nextSettings);
    await store.putProviderModels(id, { models: modelList });
    await store.putProviderCredential(id, { type: 'api_key', key: 'sk-chip-test-key1' });
    savedProvider = entry;
  } finally {
    store.close();
  }
  return { id, body: savedProvider };
}
