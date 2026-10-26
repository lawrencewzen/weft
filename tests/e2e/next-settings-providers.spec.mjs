import { test, expect } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, prepareWorkspaces, ROOT } from './helpers/server.mjs';
import { loginNext, openWorkspaceConversation } from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

const WRONG_KEY = 'sk-e2e-wrong-key-9f3c';
const RIGHT_KEY = 'sk-e2e-right-key-7a1b';
const MOCK_GROK = pathToFileURL(path.join(ROOT, 'tests/e2e/helpers/mock-grok-oidc.mjs')).href;

let srv;
const closers = [];

test.afterEach(async () => {
  await srv?.kill();
  srv = null;
  while (closers.length) {
    const close = closers.pop();
    await new Promise((resolve) => close(resolve));
  }
});

function startFakeModels({ statusFor } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const authorization = String(req.headers.authorization || '');
      hits.push({ method: req.method, url: req.url, authorization });
      const key = authorization.replace(/^Bearer\s+/i, '');
      const status = statusFor ? statusFor(key) : 200;
      if (status === 401) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'alpha-one' }, { id: 'beta-two' }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      closers.push((done) => server.close(done));
      const { port } = server.address();
      resolve({
        hits,
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });
    });
  });
}

function attachCspLog(page) {
  const csp = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/content security policy/i.test(text)) csp.push(text);
  });
  return csp;
}

function watchSecrets(page, secrets) {
  const leaked = [];
  page.on('response', async (res) => {
    const type = res.headers()['content-type'] || '';
    if (!/json|text|xml|javascript/i.test(type)) return;
    let text = '';
    try { text = await res.text(); } catch { return; }
    for (const secret of secrets) {
      if (secret && text.includes(secret)) leaked.push(`${res.url()} :: ${secret}`);
    }
  });
  return leaked;
}

async function boot(page, extraEnv = {}) {
  const prepared = await prepareWorkspaces(['repo']);
  srv = await startServer({
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root, ...extraEnv },
  });
  await loginNext(page, srv);
  return { prepared, csp: attachCspLog(page) };
}

async function openProviders(page) {
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings')).toBeVisible();
  await page.getByTestId('next-settings-nav-providers').click();
  await expect(page.getByTestId('next-provider-add')).toBeVisible();
}

test('settings overlay opens from the sidebar, Esc returns, and other tabs are placeholders', async ({ page }) => {
  await boot(page);
  await expect(page).toHaveURL(/\/next\//);
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings')).toBeVisible();
  await expect(page).toHaveURL(/\/next\/settings\/general/);
  await expect(page.getByTestId('next-settings-general')).toBeVisible();
  await expect(page.getByTestId('next-pref-lang')).toBeVisible();
  await page.getByTestId('next-settings-nav-git').click();
  await expect(page).toHaveURL(/\/next\/settings\/git/);
  await expect(page.getByTestId('next-settings-git')).toBeVisible();
  await expect(page.getByTestId('next-git-add')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toHaveCount(0);
  await expect(page).toHaveURL(/\/next\//);
});

test('opening /next/settings/providers keeps the overlay on the Provider page', async ({ page }) => {
  const { prepared } = await boot(page);
  await openWorkspaceConversation(srv, 'repo', prepared.dirs[0]);
  await expect(page.getByTestId('next-new-chat')).toBeEnabled();
  await page.goto(new URL('/next/settings/providers', page.url()).href);
  await expect(page.getByTestId('next-settings')).toBeVisible();
  await expect(page.getByTestId('next-settings-nav-providers')).toHaveClass(/is-on/);
  await expect(page.getByTestId('next-provider-add')).toBeVisible();
  await expect(page.getByTestId('next-provider-add')).not.toHaveClass(/ns-btn-primary/);
  await expect(page).toHaveURL(/\/next\/settings\/providers$/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toHaveCount(0);
  await expect(page).toHaveURL(/\/next\/(c|w)\//);
});

test('add provider: failed 401, then pass, pick two models, default, rename, delete; key never leaks', async ({ page }) => {
  const fake = await startFakeModels({
    statusFor: (key) => (key === RIGHT_KEY ? 200 : 401),
  });
  await boot(page);
  const leaked = watchSecrets(page, [WRONG_KEY, RIGHT_KEY]);
  await openProviders(page);

  await page.getByTestId('next-provider-add').click();
  await page.locator('[data-testid=next-vendor-card][data-vendor=custom]').click();
  await expect(page.getByTestId('next-settings')).toContainText('已选');
  await page.getByRole('button', { name: '下一步' }).click();

  await expect(page.getByTestId('next-way-custom_endpoint')).toBeVisible();
  await expect(page.getByTestId('next-way-custom_endpoint')).toContainText('兼容 OpenAI 协议的网关');
  await expect(page.getByTestId('next-way-custom_endpoint')).not.toContainText('兼容 OpenAI 兼容');
  await expect(page.getByTestId('next-way-agent')).toBeDisabled();
  await expect(page.getByTestId('next-way-agent')).toContainText('即将支持');

  await page.getByTestId('next-provider-url').fill(fake.baseUrl);
  await page.getByTestId('next-key-input').fill(WRONG_KEY);
  await page.getByTestId('next-provider-test').click();
  await expect(page.getByTestId('next-test-result')).toContainText(/鉴权失败/);
  await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();

  await page.getByTestId('next-key-input').fill(RIGHT_KEY);
  await page.getByTestId('next-provider-test').click();
  await expect(page.getByTestId('next-test-result')).toContainText(/连接成功，找到 2 个模型/);
  await page.getByRole('button', { name: '下一步' }).click();

  const rows = page.getByTestId('next-model-row');
  await expect(rows).toHaveCount(2, { timeout: 15000 });
  await expect(page.getByTestId('next-model-filter').first()).toBeVisible();
  await expect(page.getByPlaceholder('搜索模型名或 ID')).toBeVisible();
  await expect(page.getByPlaceholder('列表里没有？手动加一个模型 ID')).toBeVisible();
  await expect(page.getByText('已选 0 个')).toBeVisible();
  await rows.nth(0).locator('.ns-switch').click();
  await rows.nth(1).locator('.ns-switch').click();
  await expect(page.getByText('已选 2 个')).toBeVisible();
  await expect(page.getByText('只看已选')).toBeVisible();
  await page.getByTestId('next-provider-finish').click();

  const row = page.getByTestId('next-provider-row').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('测试通过');
  await expect(row).toContainText('启用 2 个模型');

  await page.getByTestId('next-default-model').click();
  await page.locator('.ns-pop-item').first().click();
  await expect(page.getByTestId('next-default-model')).toContainText(/alpha-one|beta-two/);

  await page.getByTestId('next-provider-edit').click();
  await page.getByTestId('next-provider-name').fill('Lab Key');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByTestId('next-provider-finish').click();
  await expect(page.getByTestId('next-provider-row')).toContainText('Lab Key');

  await page.getByTestId('next-provider-delete').click();
  await page.getByTestId('next-confirm-ok').click();
  await expect(page.getByTestId('next-provider-row')).toHaveCount(0);

  const html = await page.content();
  expect(html.includes(WRONG_KEY), 'page html has no wrong key').toBe(false);
  expect(html.includes(RIGHT_KEY), 'page html has no right key').toBe(false);
  expect(leaked, 'network responses never include the key').toEqual([]);
  expect(fake.hits.some((hit) => String(hit.url).endsWith('/models'))).toBe(true);
});

test('Grok device-code login uses the test double and reaches the model step', async ({ page }) => {
  const extraEnv = {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${MOCK_GROK}`].filter(Boolean).join(' '),
    WEFT_GROK_AUTH: '',
  };
  const prepared = await prepareWorkspaces(['repo']);
  extraEnv.WEFT_WORKSPACE_ROOT = prepared.root;
  extraEnv.WEFT_GROK_AUTH = path.join(prepared.root, 'grok-auth.json');
  srv = await startServer({ extraEnv });
  await loginNext(page, srv);
  await openProviders(page);
  await page.getByTestId('next-provider-add').click();
  await page.locator('[data-testid=next-vendor-card][data-vendor=grok]').click();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByTestId('next-grok-code')).toHaveText('WXYZ-1234', { timeout: 15000 });
  await expect(page.getByText('①')).toBeVisible();
  await expect(page.getByText('已在浏览器打开')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新打开 ↗' })).toBeVisible();
  await expect(page.getByText('②')).toBeVisible();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await expect(page.getByText('③')).toBeVisible();
  await expect(page.getByText('等你确认，这里会自动往下走')).toBeVisible();
  await expect(page.getByText('登录后')).toBeVisible();
  await expect(page.getByText('遇到问题')).toBeVisible();
  await expect(page.getByRole('button', { name: /等待登录/ })).toBeDisabled();
  await expect(page.getByTestId('next-model-row')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('next-model-row').locator('.ns-switch').click();
  await page.getByTestId('next-provider-finish').click();
  const grokRow = page.getByTestId('next-provider-row').filter({ hasText: /Grok|账号/ });
  await expect(grokRow).toBeVisible();
  await expect(grokRow.getByTestId('next-provider-delete')).toHaveCount(0);
});
