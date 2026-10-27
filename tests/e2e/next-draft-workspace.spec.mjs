import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { api, prepareWorkspaces, startServer } from './helpers/server.mjs';
import { apiV2, loginNext, waitRunDone } from './helpers/next.mjs';

const execFileP = promisify(execFile);

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

function wsNode(page, name) {
  return page.getByTestId('next-ws-node').filter({ hasText: name });
}

async function createWorkspace(srv, name, wsPath) {
  const ws = await api(srv.url, 'POST', '/workspaces', { name, path: wsPath });
  expect(ws.status).toBe(201);
  return ws.body;
}

async function createConversation(srv, wsId, title) {
  const conv = await api(srv.url, 'POST', `/workspaces/${wsId}/conversations`, { title });
  expect(conv.status).toBe(201);
  return conv.body;
}

async function waitSidebar(page) {
  await expect(page.getByTestId('next-sidebar')).toHaveCount(1);
  await expect(page.getByTestId('next-ws-node').first()).toBeVisible({ timeout: 20000 });
}

async function gitInitRepo(dir) {
  await execFileP('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true, timeout: 15_000 });
  await fs.writeFile(path.join(dir, 'readme.txt'), 'hello\n');
  await execFileP('git', ['-c', 'user.name=weft', '-c', 'user.email=weft@test', 'add', 'readme.txt'], {
    cwd: dir, windowsHide: true, timeout: 15_000,
  });
  await execFileP('git', ['-c', 'user.name=weft', '-c', 'user.email=weft@test', 'commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: dir, windowsHide: true, timeout: 15_000,
  });
}

test('new chat does not add a sidebar row until the first message is sent', async ({ page }) => {
  const prepared = await prepareWorkspaces(['draft']);
  const srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const ws = await createWorkspace(srv, 'draft', prepared.dirs[0]);
    const existing = await createConversation(srv, ws.id, 'existing');
    await loginNext(page, srv);
    await waitSidebar(page);
    await expect(wsNode(page, 'draft').getByTestId('next-conv-row')).toHaveCount(1);
    await page.getByTestId('next-new-chat').click();
    await expect(page).toHaveURL(new RegExp(`/w/${ws.id}/new$`));
    await expect(page.getByTestId('next-draft-row')).toHaveCount(0);
    await expect(page.locator('.conv-tree-node.conv-active')).toHaveCount(0);
    await expect(wsNode(page, 'draft').getByTestId('next-conv-row')).toHaveCount(1);
    await expect(page.getByTestId('next-draft-hint')).toContainText('draft');
    await page.getByTestId('next-composer-input').fill('写个 README');
    await page.getByTestId('next-send').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    await expect(wsNode(page, 'draft').getByTestId('next-conv-row')).toHaveCount(2);
    const top = wsNode(page, 'draft').getByTestId('next-conv-row').first();
    await expect(top).not.toHaveAttribute('data-id', existing.id);
    await expect(page.locator('.conv-tree-node.conv-active')).toHaveCount(1);
    await expect(page.getByTestId('next-item-user')).toContainText('写个 README');
  } finally {
    await srv.kill();
  }
});

test('draft workspace chip switches the target project before the first send', async ({ page }) => {
  const prepared = await prepareWorkspaces(['alpha', 'beta']);
  const srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const alpha = await createWorkspace(srv, 'alpha', prepared.dirs[0]);
    const beta = await createWorkspace(srv, 'beta', prepared.dirs[1]);
    await createConversation(srv, alpha.id, 'alpha-chat');
    await loginNext(page, srv);
    await waitSidebar(page);
    await page.getByTestId('next-new-chat').click();
    await expect(page).toHaveURL(new RegExp(`/w/${beta.id}/new$|/w/${alpha.id}/new$`));
    await page.getByTestId('next-ws-chip').click();
    await expect(page.getByTestId('next-ws-chip-menu')).toBeVisible();
    await page.locator(`[data-testid=next-ws-chip-option][data-id="${beta.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/w/${beta.id}/new$`));
    await expect(page.getByTestId('next-ws-chip')).toContainText('beta');
    await expect(page.getByTestId('next-draft-hint')).toContainText('beta');
    await page.getByTestId('next-composer-input').fill('hello beta');
    await page.getByTestId('next-send').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    const cid = page.url().split('/c/')[1];
    await expect(wsNode(page, 'beta').getByTestId('next-conv-row')).toHaveCount(1);
    await expect(wsNode(page, 'beta').getByTestId('next-conv-row').first()).toHaveAttribute('data-id', decodeURIComponent(cid));
    await expect(wsNode(page, 'alpha').getByTestId('next-conv-row')).toHaveCount(1);
  } finally {
    await srv.kill();
  }
});

test('the sidebar new-chat button keeps the second draft in its own conversation', async ({ page }) => {
  const prepared = await prepareWorkspaces(['again']);
  const srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const ws = await createWorkspace(srv, 'again', prepared.dirs[0]);
    const existing = await createConversation(srv, ws.id, 'existing');
    await loginNext(page, srv);
    await waitSidebar(page);
    await expect(wsNode(page, 'again').getByTestId('next-conv-row')).toHaveCount(1);

    await page.getByTestId('next-new-chat').click();
    await expect(page).toHaveURL(new RegExp(`/w/${ws.id}/new$`));
    await page.getByTestId('next-composer-input').fill('A');
    await page.getByTestId('next-send').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    await waitRunDone(page);
    const firstCid = decodeURIComponent(page.url().split('/c/')[1]);
    expect(firstCid).not.toBe(existing.id);
    await expect(page.getByTestId('next-item-user')).toHaveCount(1);
    await expect(page.getByTestId('next-item-user')).toContainText('A');
    await expect(wsNode(page, 'again').getByTestId('next-conv-row')).toHaveCount(2);

    await page.getByTestId('next-new-chat').click();
    await expect(page).toHaveURL(new RegExp(`/w/${ws.id}/new$`));
    await page.getByTestId('next-composer-input').fill('B');
    await page.getByTestId('next-send').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    await waitRunDone(page);
    const secondCid = decodeURIComponent(page.url().split('/c/')[1]);
    expect(secondCid).not.toBe(firstCid);
    expect(secondCid).not.toBe(existing.id);
    await expect(page.getByTestId('next-item-user')).toHaveCount(1);
    await expect(page.getByTestId('next-item-user')).toContainText('B');
    await expect(wsNode(page, 'again').getByTestId('next-conv-row')).toHaveCount(3);

    await page.goto(`${srv.url}/c/${encodeURIComponent(firstCid)}`);
    await expect(page.getByTestId('next-item-user')).toHaveCount(1);
    await expect(page.getByTestId('next-item-user')).toContainText('A');
    await expect(page.getByTestId('next-item-user')).not.toContainText('B');
  } finally {
    await srv.kill();
  }
});

test('a draft started in another workspace sends into that workspace', async ({ page }) => {
  const prepared = await prepareWorkspaces(['one', 'two']);
  const srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const one = await createWorkspace(srv, 'one', prepared.dirs[0]);
    const two = await createWorkspace(srv, 'two', prepared.dirs[1]);
    await loginNext(page, srv);
    await waitSidebar(page);

    await wsNode(page, 'one').getByTestId('next-ws-add').click();
    await expect(page).toHaveURL(new RegExp(`/w/${one.id}/new$`));
    await page.getByTestId('next-composer-input').fill('A');
    await page.getByTestId('next-send').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    await waitRunDone(page);
    const firstCid = decodeURIComponent(page.url().split('/c/')[1]);

    await wsNode(page, 'two').getByTestId('next-ws-add').click();
    await expect(page).toHaveURL(new RegExp(`/w/${two.id}/new$`));
    await expect(page.getByTestId('next-ws-chip')).toContainText('two');
    await page.getByTestId('next-composer-input').fill('B');
    await page.getByTestId('next-send').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 20000 });
    await waitRunDone(page);
    const secondCid = decodeURIComponent(page.url().split('/c/')[1]);
    expect(secondCid).not.toBe(firstCid);
    await expect(page.getByTestId('next-item-user')).toHaveCount(1);
    await expect(page.getByTestId('next-item-user')).toContainText('B');

    await expect(wsNode(page, 'two').getByTestId('next-conv-row')).toHaveCount(1);
    await expect(wsNode(page, 'two').getByTestId('next-conv-row').first()).toHaveAttribute('data-id', secondCid);
    await expect(wsNode(page, 'one').getByTestId('next-conv-row')).toHaveCount(1);
    await expect(wsNode(page, 'one').getByTestId('next-conv-row').first()).toHaveAttribute('data-id', firstCid);
    const created = await apiV2(srv, 'GET', `/api/v2/conversations/${encodeURIComponent(secondCid)}`);
    expect(created.status, created.text).toBe(200);
    expect(created.body.conversation.workspaceId).toBe(two.id);
  } finally {
    await srv.kill();
  }
});

test('creating a workspace from the chip menu selects it for the draft', async ({ page }) => {
  const prepared = await prepareWorkspaces(['alpha', 'gamma']);
  const srv = await startServer({
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    await createWorkspace(srv, 'alpha', prepared.dirs[0]);
    await loginNext(page, srv);
    await waitSidebar(page);
    await page.getByTestId('next-new-chat').click();
    await expect(page.getByTestId('next-ws-chip')).toBeVisible();
    await page.getByTestId('next-ws-chip').click();
    await page.getByTestId('next-ws-chip-new').click();
    await expect(page.getByTestId('next-ws-dialog')).toBeVisible();
    const gamma = page.getByTestId('next-dir-row').filter({ hasText: 'gamma' });
    await expect(gamma).toBeVisible();
    await gamma.getByTestId('next-dir-choose').click();
    await page.getByTestId('next-ws-name').fill('gamma');
    await page.getByTestId('next-ws-create').click();
    await expect(page.getByTestId('next-ws-dialog')).toHaveCount(0);
    await expect(wsNode(page, 'gamma')).toBeVisible();
    await expect(page).toHaveURL(/\/w\/[^/]+\/new/);
    await expect(page.getByTestId('next-ws-chip')).toContainText('gamma');
    await expect(page.getByTestId('next-draft-hint')).toContainText('gamma');
  } finally {
    await srv.kill();
  }
});

test('status bar shows the git branch and +/- after a refresh', async ({ page }) => {
  const prepared = await prepareWorkspaces(['gitws']);
  await gitInitRepo(prepared.dirs[0]);
  const srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const ws = await createWorkspace(srv, 'gitws', prepared.dirs[0]);
    const conv = await createConversation(srv, ws.id, 'git-chat');
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    await expect(page.getByTestId('next-status-git')).toContainText('gitws');
    await expect(page.getByTestId('next-status-git-branch')).toHaveText(/main|master/);
    await fs.writeFile(path.join(prepared.dirs[0], 'readme.txt'), 'hello\nworld\n');
    await page.getByTestId('next-composer-input').fill('改一下');
    await page.getByTestId('next-send').click();
    await waitRunDone(page);
    await expect(page.getByTestId('next-status-git-diff')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('next-status-git-diff')).toContainText('+');
    const refreshed = await apiV2(srv, 'POST', `/api/v2/workspaces/${ws.id}/git/refresh`, {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.git?.insertions).toBeGreaterThan(0);
  } finally {
    await srv.kill();
  }
});
