import { test, expect } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function pasteImage(page, name = 'screenshot.png') {
  await page.getByTestId('next-composer-input').focus();
  await page.evaluate(async ({ name, b64 }) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const file = new File([bytes], name, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector('[data-testid="next-composer-input"]');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: dt });
    el.dispatchEvent(event);
  }, { name, b64: PNG_B64 });
}

test('prototype paste, send, and over-limit stay on file://', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  await expect(page.getByTestId('next-composer-input')).toBeVisible();
  await pasteImage(page);
  await expect(page.getByTestId('next-attach-image')).toContainText('screenshot.png');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-user-image')).toBeVisible();

  await pasteImage(page, 'second.png');
  await expect(page.getByTestId('next-attach-image')).toContainText('second.png');
  await page.getByTestId('next-attach-remove').click();
  await expect(page.getByTestId('next-attach-image')).toHaveCount(0);

  await page.evaluate(() => {
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 8)], 'huge.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector('[data-testid="next-composer-input"]');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: dt });
    el.dispatchEvent(event);
  });
  await expect(page.getByTestId('next-composer-hint')).toContainText('5MB');
  expectClean(state);
});

test('prototype drop overlay and project file tag', async ({ page }) => {
  const state = await openProto(page);
  await page.locator('[data-testid=next-conv-row][data-id="c-git"]').click();
  await expect(page.getByTestId('next-composer-input')).toBeVisible();
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="next-composer"]');
    const enter = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.defineProperty(enter, 'dataTransfer', { value: { types: ['Files'], files: [] } });
    el.dispatchEvent(enter);
  });
  await expect(page.getByTestId('next-composer-drop')).toBeVisible();
  await expect(page.getByTestId('next-composer-drop')).toContainText('松开鼠标');

  await page.evaluate(() => {
    const file = new File(['hello'], 'store.ts', { type: 'text/plain' });
    Object.defineProperty(file, 'path', { value: 'D:\\work\\weft\\web\\src\\data\\store.ts' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector('[data-testid="next-composer"]');
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        files: dt.files,
        types: ['Files'],
        getData: () => '',
      },
    });
    el.dispatchEvent(event);
  });
  await expect(page.getByTestId('next-attach-file')).toContainText('web/src/data/store.ts');
  await expect(page.getByTestId('next-composer-input')).toHaveValue(/@web\/src\/data\/store\.ts/);
  expectClean(state);
});
