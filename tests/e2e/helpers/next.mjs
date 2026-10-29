import { expect } from '@playwright/test';
import { api, readDiscovery } from './server.mjs';
import { startFakeOpenAIServer } from './fake-openai.mjs';

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
  apiKey = 'sk-chip-test-key1',
} = {}) {
  const modelEntries = models.map((m) => {
    if (typeof m === 'string') {
      let displayName = m;
      if (m === 'grok-4.6') displayName = 'Grok 4.6';
      else if (m === 'grok-4') displayName = 'Grok 4';
      return { id: m, name: displayName, context_window: contextWindow ?? 200000 };
    }
    return m;
  });

  const fake = await startFakeOpenAIServer({ models: modelEntries });
  if (srv && typeof srv.kill === 'function') {
    const origKill = srv.kill;
    srv.kill = async (...args) => {
      try { await fake.close(); } catch {}
      return origKill.apply(srv, args);
    };
  }

  const created = await apiV2(srv, 'POST', '/api/v2/providers/custom', {
    name,
    baseUrl: fake.baseUrl,
    api: 'openai-completions',
    apiKey,
  });
  expect(created.status, created.text).toBe(200);
  const id = created.body.provider.id;

  const patchBody = {};
  if (defaultModel) patchBody.defaultModel = defaultModel;
  if (contextWindow != null) {
    patchBody.overrides = {};
    const names = defaultModel ? [defaultModel] : models.map((m) => (typeof m === 'string' ? m : m.id));
    for (const modelId of names) {
      patchBody.overrides[modelId] = { contextWindow };
    }
  }
  if (Object.keys(patchBody).length > 0) {
    const bound = await apiV2(srv, 'PATCH', `/api/v2/providers/${id}`, patchBody);
    expect(bound.status, bound.text).toBe(200);
  }

  return { id, body: created.body.provider, fake, close: () => fake.close() };
}
