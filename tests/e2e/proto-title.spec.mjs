import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

const ZH_MSG = '帮我写一个用户登录页面';
const ZH_TITLE = '登录功能';
const EN_MSG = 'Help me write a login page';
const EN_TITLE = 'Login form';

function convTitle(page, id) {
  return page.locator(`[data-testid=next-conv-row][data-id="${id}"] .sb-conv-title`);
}

test('prototype Chinese chat: temp title then generated title after the first run', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  await page.getByTestId('next-composer-input').fill(ZH_MSG);
  await page.getByTestId('next-send').click();
  await expect(page).toHaveURL(/#\/c\/c-\d+$/);
  const cid = page.url().split('/c/')[1];
  await expect(convTitle(page, cid)).toHaveText(ZH_MSG);
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 40_000 });
  await expect(convTitle(page, cid)).toHaveText(ZH_TITLE, { timeout: 10_000 });
  await expect(page.getByTestId('next-status')).toContainText(ZH_TITLE);
  expectClean(state);
});

test('prototype English chat: temp title then generated title after the first run', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('weft_lang', 'en'));
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  await page.getByTestId('next-composer-input').fill(EN_MSG);
  await page.getByTestId('next-send').click();
  await expect(page).toHaveURL(/#\/c\/c-\d+$/);
  const cid = page.url().split('/c/')[1];
  await expect(convTitle(page, cid)).toHaveText(EN_MSG);
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 40_000 });
  await expect(convTitle(page, cid)).toHaveText(EN_TITLE, { timeout: 10_000 });
  expectClean(state);
});
