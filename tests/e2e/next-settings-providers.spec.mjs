import { test, expect } from '@playwright/test';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { loginNext, openWorkspaceConversation } from './helpers/next.mjs';
import { startFakeOpenAIServer } from './helpers/fake-openai.mjs';

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

async function startFakeModels({ statusFor } = {}) {
  const fake = await startFakeOpenAIServer({
    statusFor,
    models: [
      { id: 'alpha-one', name: 'alpha-one' },
      { id: 'beta-two', name: 'beta-two' },
    ],
  });
  closers.push((done) => fake.close().then(done, done));
  return fake;
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
  await expect(page.getByTestId('next-provider-page')).not.toContainText('接入 Provider');
  await expect(page.getByTestId('next-provider-page')).not.toContainText('点一行展开');
  await expect(page.getByTestId('next-provider-page')).not.toContainText('新对话使用');
  await expect(page.getByTestId('next-provider-page')).not.toContainText('只保存在本机');
}

test('settings overlay opens from the sidebar, Esc returns, and other tabs are placeholders', async ({ page }) => {
  await boot(page);
  await expect(page).toHaveURL(/\/new$/);
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
  await expect(page).toHaveURL(/\/new$/);
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
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();

  await page.locator('[data-testid=next-vendor-card][data-vendor="custom"]').click();
  await expect(page.getByTestId('next-custom-name')).toBeVisible();

  await page.getByTestId('next-custom-name').fill('Local Fake');
  await page.getByTestId('next-custom-url').fill(fake.baseUrl);
  await page.getByTestId('next-custom-key').fill(WRONG_KEY);
  await page.getByTestId('next-add-test').click();
  await expect(page.getByTestId('next-test-result')).toBeVisible();
  await expect(page.getByTestId('next-test-result')).toContainText(/401|鉴权失败|失败|unauthorized/i);

  await page.getByTestId('next-custom-key').fill(RIGHT_KEY);
  await page.getByTestId('next-add-test').click();
  await expect(page.getByTestId('next-add-model-dropdown')).toBeEnabled();
  await page.getByTestId('next-provider-finish').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);

  // Provider list: row exists and models enabled
  const row = page.getByTestId('next-provider-row').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Local Fake');
  await expect(row).toContainText(/2\s*\/\s*2|启用 2/);

  // Set default model
  await page.getByTestId('next-provider-default-picker').click();
  await expect(page.locator('.mp-menu')).toBeVisible();
  await page.locator('.mp-menu-i').first().click();
  await expect(page.getByTestId('next-provider-default-picker')).toContainText(/alpha-one|beta-two/);

  // In-place edit context window
  const modelRow = page.locator('[data-testid=next-model-row][data-model="alpha-one"]');
  await expect(modelRow).toBeVisible();
  await expect(modelRow.locator('.mp-mt-name')).toHaveText('alpha-one');
  await expect(modelRow.locator('.mp-mt-name')).toHaveAttribute('title', 'alpha-one');
  await expect(modelRow.locator('.mp-mt-id')).toHaveCount(0);
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

test('add provider dialog cancel, close and Escape; cancel rolls back a tested custom', async ({ page }) => {
  const fake = await startFakeModels();
  await boot(page);
  await openProviders(page);

  await page.getByTestId('next-provider-add').click();
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();
  await expect(page.locator('[data-testid=next-vendor-card][data-vendor="custom"]')).toBeVisible();

  await page.locator('[data-testid=next-vendor-card][data-vendor="custom"]').click();
  await expect(page.getByTestId('next-custom-name')).toBeVisible();
  await page.getByTestId('next-add-close').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);

  await page.getByTestId('next-provider-add').click();
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();
  await page.locator('[data-testid=next-vendor-card][data-vendor="custom"]').click();
  await expect(page.getByTestId('next-custom-name')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);

  await page.getByTestId('next-provider-add').click();
  await page.locator('[data-testid=next-vendor-card][data-vendor="custom"]').click();
  await page.getByTestId('next-custom-name').fill('Temp Fake');
  await page.getByTestId('next-custom-url').fill(fake.baseUrl);
  await page.getByTestId('next-custom-key').fill(RIGHT_KEY);
  await page.getByTestId('next-add-test').click();
  await expect(page.getByTestId('next-add-model-dropdown')).toBeEnabled();
  await page.getByTestId('next-add-cancel').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);
  await expect(page.getByTestId('next-provider-row')).toHaveCount(0);
});
