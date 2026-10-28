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

test('prototype @ file popup, filter, keyboard/mouse pick, escape, and tag sync', async ({ page }) => {
  const state = await openProto(page);
  await page.locator('[data-testid=next-conv-row][data-id="c-git"]').click();
  const input = page.getByTestId('next-composer-input');
  await expect(input).toBeVisible();

  // 1. Type @ triggers popup with files
  await input.focus();
  await input.pressSequentially('@');
  const atMenu = page.getByTestId('next-composer-at-menu');
  await expect(atMenu).toBeVisible();
  const items = page.getByTestId('next-composer-at-item');
  await expect(items.first()).toBeVisible();

  // Esc closes the popup
  await input.press('Escape');
  await expect(atMenu).toHaveCount(0);

  // 2. Type @store to filter files
  await input.fill('请查看 @store');
  await expect(atMenu).toBeVisible();
  await expect(items).toHaveCount(2); // store.ts and store.test.ts

  // ArrowDown to move highlight to the second item and Enter to pick
  await input.press('ArrowDown');
  await expect(items.nth(1)).toHaveAttribute('data-active', 'true');
  await input.press('Enter');

  // Selected item inserted with trailing space and tag added
  await expect(input).toHaveValue('请查看 @web/src/data/store.test.ts ');
  const fileTags = page.getByTestId('next-attach-file');
  await expect(fileTags).toHaveCount(1);
  await expect(fileTags).toContainText('web/src/data/store.test.ts');

  // 3. Mouse pick: type @README and click
  await input.focus();
  await input.pressSequentially('@README');
  await expect(atMenu).toBeVisible();
  await items.first().click();
  await expect(input).toHaveValue('请查看 @web/src/data/store.test.ts @README.md ');
  await expect(fileTags).toHaveCount(2);

  // 4. Delete @README.md from text -> tag automatically disappears
  await input.fill('请查看 @web/src/data/store.test.ts ');
  await expect(fileTags).toHaveCount(1);
  await expect(fileTags).toContainText('web/src/data/store.test.ts');

  // 5. Click tag × -> removes @path from text and collapses spaces
  await page.getByTestId('next-attach-remove').click();
  await expect(fileTags).toHaveCount(0);
  await expect(input).toHaveValue('请查看');

  // 6. Test on new chat page (draft composer)
  await page.getByTestId('next-new-chat').click();
  const draftInput = page.getByTestId('next-composer-input');
  await expect(draftInput).toBeVisible();
  await draftInput.focus();
  await draftInput.pressSequentially('@pack');
  await expect(page.getByTestId('next-composer-at-menu')).toBeVisible();
  await draftInput.press('Enter');
  await expect(draftInput).toHaveValue('@package.json ');
  await expect(page.getByTestId('next-attach-file')).toContainText('package.json');

  expectClean(state);
});
