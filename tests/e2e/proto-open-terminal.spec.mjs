import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 60_000 });

async function clickOpenTerminal(page) {
  const item = page.getByTestId('next-ctx-menu').locator('[data-action=open-terminal]');
  await expect(item).toBeVisible();
  await item.click();
}

test('prototype: three entries open the system-terminal action and refuse traversal', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.getByTestId('next-ws-node').first()).toBeVisible();

  await page.getByTestId('next-ws-toggle').first().click({ button: 'right' });
  await clickOpenTerminal(page);
  await expect(page.getByTestId('next-toast')).toContainText('已在系统终端中打开（原型不会真的打开）');

  await page.getByTestId('next-right-tab-files').click();
  const dir = page.locator('[data-testid=next-file-node][data-path="docs"]');
  await expect(dir).toBeVisible();
  await dir.click({ button: 'right' });
  await clickOpenTerminal(page);
  await expect(page.getByTestId('next-toast')).toContainText('已在系统终端中打开（原型不会真的打开）');

  const file = page.locator('[data-testid=next-file-node][data-path="README.md"]');
  await expect(file).toBeVisible();
  await file.click({ button: 'right' });
  await expect(page.getByTestId('next-ctx-menu')).toHaveCount(0);

  await page.getByTestId('next-ws-chip').click({ button: 'right' });
  await clickOpenTerminal(page);
  await expect(page.getByTestId('next-toast')).toContainText('已在系统终端中打开（原型不会真的打开）');

  const reqs = await state.requests();
  const opens = reqs.filter((row) => row.method === 'POST' && row.url.includes('/open-terminal'));
  expect(opens.length).toBe(3);

  const escaped = await page.evaluate(async () => {
    const res = await fetch('/api/v2/workspaces/ws-weft/open-terminal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../secret' }),
    });
    return { status: res.status, body: await res.json() };
  });
  expect(escaped.status).toBe(400);
  expect(escaped.body.code).toBe('E_PATH');

  expectClean(state);
});
