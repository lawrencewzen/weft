import { test, expect } from '@playwright/test';
import http from 'node:http';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { loginNext, openWorkspaceConversation } from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

const WRONG_KEY = 'sk-e2e-wrong-key-9f3c';
const RIGHT_KEY = 'sk-e2e-right-key-7a1b';

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
      if (req.url.includes('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }));
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
  await expect(page).toHaveURL(/http:\/\/127\.0\.0\.1:\d+\/$/);
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/general/);
  await expect(page.getByTestId('next-settings-general')).toBeVisible();
  await expect(page.getByTestId('next-pref-lang')).toBeVisible();
  await page.getByTestId('next-settings-nav-git').click();
  await expect(page).toHaveURL(/\/settings\/git/);
  await expect(page.getByTestId('next-settings-git')).toBeVisible();
  await expect(page.getByTestId('next-git-add')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toHaveCount(0);
  await expect(page).toHaveURL(/http:\/\/127\.0\.0\.1:\d+\/$/);
});

test('opening /settings/providers keeps the overlay on the Provider page', async ({ page }) => {
  const { prepared } = await boot(page);
  await openWorkspaceConversation(srv, 'repo', prepared.dirs[0]);
  await expect(page.getByTestId('next-new-chat')).toBeEnabled();
  await page.goto(new URL('/settings/providers', page.url()).href);
  await expect(page.getByTestId('next-settings')).toBeVisible();
  await expect(page.getByTestId('next-settings-nav-providers')).toHaveClass(/is-on/);
  await expect(page.getByTestId('next-provider-add')).toBeVisible();
  await expect(page.getByTestId('next-provider-add')).not.toHaveClass(/ns-btn-primary/);
  await expect(page).toHaveURL(/\/settings\/providers$/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toHaveCount(0);
  await expect(page).toHaveURL(/\/(c|w)\//);
});

test('add provider: failed 401, then pass, pick two models, default, rename, delete; key never leaks', async ({ page }) => {
  const fake = await startFakeModels({
    statusFor: (key) => (key === RIGHT_KEY ? 200 : 401),
  });
  await boot(page);
  const leaked = watchSecrets(page, [WRONG_KEY, RIGHT_KEY]);
  await openProviders(page);

  await page.getByTestId('next-provider-add').click();
  await expect(page.locator('.mp-dlg')).toBeVisible();

  // Step 0: click Custom card
  await page.locator('[data-testid=next-vendor-card][data-vendor="custom"]').click();
  await expect(page.getByTestId('next-custom-name')).toBeVisible();

  // Step 1: fill form with wrong key -> 401 error
  await page.getByTestId('next-custom-name').fill('Local Fake');
  await page.getByTestId('next-custom-url').fill(fake.baseUrl);
  await page.getByTestId('next-key-input').fill(WRONG_KEY);
  await page.locator('.mp-dlg .mp-df .mp-btn.mp-pri').click();
  await expect(page.getByTestId('next-test-result')).toBeVisible();
  await expect(page.getByTestId('next-test-result')).toContainText(/401|鉴权失败|失败|unauthorized/i);

  // Step 1: fix key -> pass to step 2
  await page.getByTestId('next-key-input').fill(RIGHT_KEY);
  await page.locator('.mp-dlg .mp-df .mp-btn.mp-pri').click();

  // Step 2: select both models and finish
  await expect(page.getByTestId('next-provider-finish')).toBeVisible();
  const checkboxes = page.locator('.mp-pickm input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(2);
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await page.getByTestId('next-provider-finish').click();
  await expect(page.locator('.mp-dlg')).toHaveCount(0);

  // Provider list: row exists and models enabled
  const row = page.getByTestId('next-provider-row').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Local Fake');
  await expect(row).toContainText(/2\s*\/\s*2|启用 2/);

  // Set default model
  await page.getByTestId('next-default-model').click();
  await expect(page.locator('.mp-menu')).toBeVisible();
  await page.locator('.mp-menu-i').first().click();
  await expect(page.getByTestId('next-default-model')).toContainText(/alpha-one|beta-two/);

  // In-place edit context window
  const modelRow = page.locator('[data-testid=next-model-row][data-model="alpha-one"]');
  await expect(modelRow).toBeVisible();
  const ctxVal = modelRow.locator('.mp-num .mp-v').first();
  await ctxVal.click();
  const ctxInput = page.getByTestId('next-ctx-input');
  await expect(ctxInput).toBeVisible();
  await ctxInput.fill('256K');
  await ctxInput.press('Enter');
  await expect(modelRow.locator('.mp-num .mp-v').first()).toHaveText('256K');

  // Remove provider
  await row.getByTestId('next-provider-more').click();
  await page.getByTestId('next-provider-delete').click();
  await page.getByTestId('next-confirm-ok').click();
  await expect(page.getByTestId('next-provider-row')).toHaveCount(0);

  const html = await page.content();
  expect(html.includes(WRONG_KEY), 'page html has no wrong key').toBe(false);
  expect(html.includes(RIGHT_KEY), 'page html has no right key').toBe(false);
  expect(leaked, 'network responses never include the key').toEqual([]);
  expect(fake.hits.some((hit) => String(hit.url).endsWith('/models'))).toBe(true);
});

test('add provider dialog back, cancel and close navigation', async ({ page }) => {
  await boot(page);
  await openProviders(page);

  await page.getByTestId('next-provider-add').click();
  await expect(page.locator('.mp-dlg')).toBeVisible();
  await expect(page.locator('[data-testid=next-vendor-card][data-vendor="custom"]')).toBeVisible();

  await page.locator('[data-testid=next-vendor-card][data-vendor="custom"]').click();
  await expect(page.getByTestId('next-custom-name')).toBeVisible();

  await page.locator('.mp-df .mp-btn').filter({ hasText: '上一步' }).click();
  await expect(page.locator('[data-testid=next-vendor-card][data-vendor="custom"]')).toBeVisible();

  await page.locator('.mp-dh .mp-x').click();
  await expect(page.locator('.mp-dlg')).toHaveCount(0);

  await page.getByTestId('next-provider-add').click();
  await expect(page.locator('.mp-dlg')).toBeVisible();
  await page.locator('[data-testid=next-vendor-card][data-vendor="custom"]').click();
  await expect(page.getByTestId('next-custom-name')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mp-dlg')).toHaveCount(0);
});
