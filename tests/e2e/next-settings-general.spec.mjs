import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { loginNext, openWorkspaceConversation } from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

let srv;

test.afterEach(async () => {
  await srv?.kill();
  srv = null;
});

async function boot(page, extra = {}) {
  const prepared = await prepareWorkspaces(['repo']);
  srv = await startServer({
    script: extra.script || 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  await loginNext(page, srv);
  return prepared;
}

async function lumaOf(locator) {
  return locator.evaluate((el) => {
    const raw = getComputedStyle(el).backgroundColor;
    const m = raw.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (!m) return 1;
    const r = Number(m[1]) / 255;
    const g = Number(m[2]) / 255;
    const b = Number(m[3]) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
}

async function expectDark(locator, label) {
  const luma = await lumaOf(locator);
  expect(luma, label).toBeLessThan(0.45);
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const shell = document.querySelector('.next-shell');
    const overlay = document.querySelector('.next-settings');
    const tooWide = (el) => el && el.scrollWidth > el.clientWidth + 1;
    return {
      document: root.scrollWidth <= root.clientWidth + 1,
      shell: !tooWide(shell),
      overlay: !overlay || !tooWide(overlay),
    };
  });
}

test('switching language updates UI and server phrases, persists, and old UI follows', async ({ page }) => {
  const prepared = await boot(page, { script: 'tool-collapse.json' });
  const ws = prepared.dirs[0];
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
    await fs.writeFile(path.join(ws, name), `${name}\n`);
  }
  const { conv } = await openWorkspaceConversation(srv, 'repo', ws);
  await page.goto(new URL(`/next/c/${encodeURIComponent(conv.id)}`, page.url()).href);
  await expect(page.getByTestId('next-composer-input')).toBeVisible();
  await page.getByTestId('next-composer-input').fill('看看');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-tool-group-text')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('next-tool-group-text')).toContainText(/读了/);

  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings-general')).toBeVisible();
  await expect(page.getByTestId('next-settings')).toContainText('系统设置');
  const savedLang = page.waitForResponse((res) => (
    /\/api\/settings$/.test(new URL(res.url()).pathname)
    && res.request().method() === 'PUT'
    && res.ok()
  ));
  await page.getByTestId('next-pref-lang').locator('[data-lang=en]').click();
  await savedLang;
  await expect(page.getByTestId('next-settings')).toContainText('Settings');
  await expect(page.getByTestId('next-settings-nav-general')).toHaveText('General');
  await expect(page.getByTestId('next-open-settings')).toHaveText('Settings');
  await expect(page.getByTestId('next-tool-group-text')).toContainText(/read/i, { timeout: 15000 });

  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('next-open-settings')).toHaveText('Settings');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const stored = await page.evaluate(() => localStorage.getItem('weft_lang'));
  expect(stored).toBe('en');

  await page.goto(new URL('/', page.url()).href);
  await expect(page.locator('[data-action=open-settings]')).toHaveText('Settings');
});

test('dark appearance darkens panes without horizontal scroll; old UI appearance is shared', async ({ page }) => {
  await boot(page);
  await page.goto(new URL('/', page.url()).href);
  await page.locator('[data-action=open-settings]').click();
  await expect(page.locator('.sm')).toBeVisible();
  await page.locator('[data-action=switch-appearance][data-mode=dark]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark$/);
  expect(await page.evaluate(() => localStorage.getItem('weft_appearance'))).toBe('dark');

  await page.goto(new URL('/next/', page.url()).href);
  await expect(page.getByTestId('next-sidebar')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark$/);
  await expectDark(page.getByTestId('next-sidebar'), 'sidebar');
  await expectDark(page.getByTestId('next-center'), 'center');
  await expectDark(page.getByTestId('next-right'), 'right');

  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings')).toBeVisible();
  await expectDark(page.locator('.next-settings'), 'settings overlay');
  const scroll = await noHorizontalScroll(page);
  expect(scroll.document, 'document horizontal scroll').toBe(true);
  expect(scroll.shell, 'shell horizontal scroll').toBe(true);
  expect(scroll.overlay, 'settings overlay horizontal scroll').toBe(true);

  await page.getByTestId('next-pref-appearance').locator('[data-mode=light]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light$/);
  const lightLuma = await lumaOf(page.getByTestId('next-sidebar'));
  expect(lightLuma, 'sidebar after light').toBeGreaterThan(0.7);
});

test('about page shows the service version, protocol version, and demo flag', async ({ page }) => {
  await boot(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-about').click();
  await expect(page.getByTestId('next-settings-about')).toBeVisible();
  const info = await page.evaluate(async () => {
    const res = await fetch('/api/v2/service');
    return res.json();
  });
  expect(info.serviceVersion).toMatch(/\d/);
  await expect(page.getByTestId('next-about-name')).toHaveText('Weft');
  await expect(page.getByTestId('next-about-version')).toHaveText(info.serviceVersion);
  await expect(page.getByTestId('next-about-protocol')).toHaveText(info.protocolVersion);
  await expect(page.getByTestId('next-about-demo')).toHaveText('已开启');
});
