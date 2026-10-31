import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('Grok login opens sign-in page in a new browser tab with verification code', async ({ page, context }) => {
  await context.route('https://accounts.x.ai/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>ok</body></html>' }),
  );

  const state = await openProto(page, '?grok=oauth');
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-providers').click();
  await page.getByTestId('next-provider-add').click();
  await page.locator('[data-testid=next-vendor-card][data-vendor="xai"]').click();

  const [newPage] = await Promise.all([
    context.waitForEvent('page'),
    page.getByTestId('next-grok-login').click(),
  ]);

  await newPage.waitForURL((url) => url.toString().startsWith('https://accounts.x.ai/oauth2/device'), { timeout: 15_000 });
  expect(newPage.url()).toMatch(/^https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=WFT-7Q2K/);

  await expect(page.locator('.mp-oauth-code')).toHaveText('WFT-7Q2K');
  const verifyLink = page.getByTestId('next-oauth-verify-link');
  await expect(verifyLink).toBeVisible();
  await expect(verifyLink).toHaveAttribute('href', 'https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K');
  await expect(verifyLink).toHaveText('https://accounts.x.ai/oauth2/device?user_code=WFT-7Q2K');

  await newPage.close();
  expectClean(state);
});
