import { test, expect } from '@playwright/test';
import {
  apiV2,
  createProviderModels,
  loginNext,
  openNextChat,
  openWorkspaceConversation,
  sendNext,
  waitRunDone,
} from './helpers/next.mjs';
import { prepareWorkspaces, startServer } from './helpers/server.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

function modelOption(page, modelId) {
  return page.locator(`[data-testid=next-model-option][data-model="${modelId}"]`);
}

async function openModelMenu(page) {
  await page.getByTestId('next-model-chip').click();
  await expect(page.getByTestId('next-model-menu')).toBeVisible();
}

test('lists models by provider and switches the conversation model', async ({ page }) => {
  const prepared = await prepareWorkspaces(['dispatch']);
  const srv = await startServer({
    script: 'no-usage.json',
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      LLM_CONTEXT_WINDOW: '200000',
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'dispatch', prepared.dirs[0]);
    const { id: sourceId } = await createProviderModels(srv, { contextWindow: 200000 });
    await openNextChat(page, srv, conv.id);

    await expect(page.getByTestId('next-model-chip')).toContainText('Grok 4.6');
    await expect(page.getByTestId('next-context-chip')).toHaveText('0%');

    await openModelMenu(page);
    await expect(page.getByTestId('next-model-menu')).toContainText('只对这个对话生效 · 管理模型');
    await expect(page.getByTestId('next-model-menu')).toContainText('Chip');
    await expect(page.getByTestId('next-model-menu')).toContainText('Grok 4.6');
    await expect(page.getByTestId('next-model-menu')).toContainText('grok-4.6');
    await expect(page.getByTestId('next-model-menu')).toContainText('Grok 4');
    await expect(modelOption(page, 'grok-4.6')).toHaveAttribute('aria-selected', 'true');

    await modelOption(page, 'grok-4').click();
    await expect(page.getByTestId('next-model-menu')).toBeHidden();
    await expect(page.getByTestId('next-model-chip')).toContainText('Grok 4');

    await sendNext(page, 'hello');
    await waitRunDone(page);
    await expect(page.getByTestId('next-model-chip')).toContainText('Grok 4');

    const pinned = await apiV2(srv, 'GET', `/api/v2/conversations/${conv.id}`);
    expect(pinned.status).toBe(200);
    expect(pinned.body.conversation.model.sourceId).toBe(sourceId);
    expect(pinned.body.conversation.model.modelId).toBe('grok-4');
  } finally {
    await srv.kill();
  }
});

test('draft model choice is saved on the conversation', async ({ page }) => {
  const prepared = await prepareWorkspaces(['draft-model']);
  const srv = await startServer({
    script: 'no-usage.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { ws } = await openWorkspaceConversation(srv, 'draft-model', prepared.dirs[0], 'existing');
    const { id: sourceId } = await createProviderModels(srv);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/w/${encodeURIComponent(ws.id)}/new`);
    await expect(page.getByTestId('next-composer-input')).toBeVisible();
    await expect(page.getByTestId('next-model-chip')).toContainText('Grok 4.6');

    await openModelMenu(page);
    await modelOption(page, 'grok-4').click();
    await expect(page.getByTestId('next-model-chip')).toContainText('Grok 4');

    await sendNext(page, 'hello');
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    await waitRunDone(page);
    await expect(page.getByTestId('next-model-chip')).toContainText('Grok 4');

    const cid = page.url().split('/c/')[1];
    const created = await apiV2(srv, 'GET', `/api/v2/conversations/${decodeURIComponent(cid)}`);
    expect(created.status).toBe(200);
    expect(created.body.conversation.model.sourceId).toBe(sourceId);
    expect(created.body.conversation.model.modelId).toBe('grok-4');

    await page.reload();
    await expect(page.getByTestId('next-model-chip')).toContainText('Grok 4');
  } finally {
    await srv.kill();
  }
});

test('model chip stays usable while a run is busy', async ({ page }) => {
  const prepared = await prepareWorkspaces(['busy']);
  const srv = await startServer({
    script: 'slow.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'busy', prepared.dirs[0]);
    await createProviderModels(srv);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, 'run');
    await expect(page.getByTestId('next-stop')).toBeVisible();

    await openModelMenu(page);
    await modelOption(page, 'grok-4').click();
    await expect(page.getByTestId('next-model-chip')).toContainText('Grok 4');

    const switched = await apiV2(srv, 'GET', `/api/v2/conversations/${conv.id}`);
    expect(switched.body.conversation.model.modelId).toBe('grok-4');
  } finally {
    await srv.kill();
  }
});

test('context chip shows reported usage and stays at 0% without usage', async ({ page }) => {
  const prepared = await prepareWorkspaces(['usage', 'plain']);
  const usageSrv = await startServer({
    script: 'usage.json',
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      LLM_CONTEXT_WINDOW: '200000',
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(usageSrv, 'usage', prepared.dirs[0]);
    await createProviderModels(usageSrv, { contextWindow: 200000 });
    await openNextChat(page, usageSrv, conv.id);
    await expect(page.getByTestId('next-context-chip')).toHaveText('0%');
    await sendNext(page, 'count tokens');
    await expect(page.getByTestId('next-context-chip')).toHaveText('8%', { timeout: 20000 });
    await waitRunDone(page);
    await page.reload();
    await expect(page.getByTestId('next-context-chip')).toHaveText('8%');
  } finally {
    await usageSrv.kill();
  }

  const plain = await startServer({
    script: 'no-usage.json',
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      LLM_CONTEXT_WINDOW: '200000',
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(plain, 'plain', prepared.dirs[1]);
    await createProviderModels(plain, { contextWindow: 200000 });
    await openNextChat(page, plain, conv.id);
    await sendNext(page, 'hello');
    await waitRunDone(page);
    await expect(page.getByTestId('next-context-chip')).toHaveText('0%');
    await page.reload();
    await expect(page.getByTestId('next-context-chip')).toHaveText('0%');
  } finally {
    await plain.kill();
  }
});

test('context menu sets the model window and keeps it after refresh', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ctx-window']);
  const srv = await startServer({
    script: 'usage.json',
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      LLM_CONTEXT_WINDOW: '200000',
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'ctx-window', prepared.dirs[0]);
    const { id: sourceId } = await createProviderModels(srv, {
      models: ['grok-4.6'],
      defaultModel: 'grok-4.6',
      contextWindow: 200000,
    });
    const puts = [];
    page.on('request', (req) => {
      if (req.method() === 'PUT' && /\/api\/v2\/providers\//.test(req.url()) && /context-window/.test(req.url())) {
        puts.push({ url: req.url(), body: JSON.parse(req.postData() || '{}') });
      }
    });
    await openNextChat(page, srv, conv.id);
    await expect(page.getByTestId('next-context-chip')).toHaveText('0%');

    await sendNext(page, 'count tokens');
    await expect(page.getByTestId('next-context-chip')).toHaveText('8%', { timeout: 20000 });
    await waitRunDone(page);

    await page.getByTestId('next-context-chip').click();
    const menu = page.getByTestId('next-context-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText(/已用\s+16\.4k · 8%|Used\s+16\.4k · 8%/);
    await expect(menu).toContainText(/剩余\s+(184k|183\.6k) · 92%|Left\s+(184k|183\.6k) · 92%/);
    const putDone = page.waitForResponse((res) => (
      res.request().method() === 'PUT'
      && /\/api\/v2\/providers\//.test(res.url())
      && /context-window/.test(res.url())
      && res.ok()
    ));
    await menu.locator('[data-testid=next-context-option][data-tokens="256000"]').click();
    await putDone;
    await expect(menu).toBeHidden();
    await expect(page.getByTestId('next-context-chip')).toHaveText('6%');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain(`/api/v2/providers/${sourceId}/models/grok-4.6/context-window`);
    expect(puts[0].body).toEqual({ window: 256000 });

    await page.reload();
    await expect(page.getByTestId('next-context-chip')).toHaveText('6%');
    const listed = await apiV2(srv, 'GET', '/api/v2/providers');
    const saved = (listed.body.providers || []).find((item) => item.id === sourceId);
    const row = (saved?.models || []).find((item) => item.id === 'grok-4.6');
    expect(row?.contextWindow).toBe(256000);
    expect(row?.contextWindowCustom).toBe(true);
  } finally {
    await srv.kill();
  }
});

test('context at 80% shows an orange banner', async ({ page }) => {
  const prepared = await prepareWorkspaces(['warn']);
  const srv = await startServer({
    script: 'usage.json',
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      LLM_CONTEXT_WINDOW: '20000',
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'warn', prepared.dirs[0]);
    const { id } = await createProviderModels(srv, { models: ['grok-4.6'], defaultModel: 'grok-4.6' });
    const win = await apiV2(srv, 'PUT', `/api/v2/providers/${id}/models/grok-4.6/context-window`, { window: 20000 });
    expect(win.status, win.text).toBe(200);
    await openNextChat(page, srv, conv.id);
    await expect(page.getByTestId('next-context-banner')).toHaveCount(0);
    await sendNext(page, 'count tokens');
    await expect(page.getByTestId('next-context-chip')).toHaveText('82%', { timeout: 20000 });
    await expect(page.getByTestId('next-context-chip')).toHaveClass(/is-warn/);
    await expect(page.getByTestId('next-context-banner')).toBeVisible();
    await expect(page.getByTestId('next-context-banner')).toContainText('82%');
    await expect(page.getByTestId('next-context-new')).toBeVisible();
  } finally {
    await srv.kill();
  }
});

test('composer is disabled with a connect-model prompt when no model is available', async ({ page }) => {
  const prepared = await prepareWorkspaces(['none']);
  const srv = await startServer({
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      WEFT_LLM: '',
      LLM_API: '',
      WEFT_FAUX_SCRIPT: '',
    },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'none', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await expect(page.getByTestId('next-no-model')).toBeVisible();
    await expect(page.getByTestId('next-no-model-connect')).toHaveText(/接入模型|Connect a model/);
    await expect(page.getByTestId('next-composer-input')).toBeDisabled();
    await expect(page.getByTestId('next-composer-input')).toHaveAttribute(
      'placeholder',
      /先接入一个模型|Connect a model/,
    );
    await expect(page.getByTestId('next-send')).toBeDisabled();
    await expect(page.getByTestId('next-model-chip')).toHaveCount(0);
    await page.getByTestId('next-no-model-connect').click();
    await expect(page.getByTestId('next-settings')).toBeVisible();
    await expect(page.getByTestId('next-settings-nav-providers')).toHaveClass(/is-on/);
  } finally {
    await srv.kill();
  }
});

test('manage models opens the Provider settings overlay', async ({ page }) => {
  const prepared = await prepareWorkspaces(['manage']);
  const srv = await startServer({
    script: 'no-usage.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'manage', prepared.dirs[0]);
    await createProviderModels(srv);
    await openNextChat(page, srv, conv.id);

    await openModelMenu(page);
    await page.getByTestId('next-model-manage').click();
    await expect(page.getByTestId('next-model-menu')).toBeHidden();
    await expect(page.getByTestId('next-settings')).toBeVisible();
    await expect(page.getByTestId('next-settings-nav-providers')).toHaveClass(/is-on/);
    await expect(page).toHaveURL(/\/settings\/providers$/);
  } finally {
    await srv.kill();
  }
});
