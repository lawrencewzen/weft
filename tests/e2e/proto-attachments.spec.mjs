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
  await expect(items).toHaveCount(2); // store.test.ts and store.ts

  const secondDir = await items.nth(1).locator('.composer-at-dir').innerText();
  const secondName = await items.nth(1).locator('.composer-at-name').innerText();
  const secondPath = `${secondDir}${secondName}`;

  // ArrowDown to move highlight to the second item and Enter to pick
  await input.press('ArrowDown');
  await expect(items.nth(1)).toHaveAttribute('data-active', 'true');
  await input.press('Enter');

  // Selected item inserted with trailing space and tag added
  await expect(input).toHaveValue(`请查看 @${secondPath} `);
  const fileTags = page.getByTestId('next-attach-file');
  await expect(fileTags).toHaveCount(1);
  await expect(fileTags).toContainText(secondPath);

  // 3. Mouse pick: type @README and click
  await input.focus();
  await input.pressSequentially('@README');
  await expect(atMenu).toBeVisible();
  await items.first().click();
  await expect(input).toHaveValue(`请查看 @${secondPath} @README.md `);
  await expect(fileTags).toHaveCount(2);

  // 4. Delete @README.md from text -> tag automatically disappears
  await input.fill(`请查看 @${secondPath} `);
  await expect(fileTags).toHaveCount(1);
  await expect(fileTags).toContainText(secondPath);

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
  await expect(page.getByTestId('next-composer-at-item').first()).toContainText('package.json');
  await draftInput.press('Enter');
  await expect(draftInput).toHaveValue('@package.json ');
  await expect(page.getByTestId('next-attach-file')).toContainText('package.json');

  expectClean(state);
});

test('prototype non-image file upload via file input and send', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  await expect(page.getByTestId('next-composer-input')).toBeVisible();

  await page.evaluate(() => {
    const file = new File(['mock content here'], 'sample.pdf', { type: 'application/pdf' });
    const input = document.querySelector('[data-testid="next-composer-file-input"]');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const uploadTag = page.getByTestId('next-attach-upload');
  await expect(uploadTag).toBeVisible();
  await expect(uploadTag).toContainText('sample.pdf');
  await expect(uploadTag).toHaveAttribute('data-status', 'done');

  await page.getByTestId('next-send').click();
  const userMsg = page.getByTestId('next-item-user').first();
  await expect(userMsg).toBeVisible();
  const userFile = userMsg.getByTestId('next-user-file');
  await expect(userFile).toBeVisible();
  await expect(userFile).toContainText('sample.pdf');

  expectClean(state);
});

test('prototype long paste folds into tag, peeks, restores, sends, and expands in thread', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  const input = page.getByTestId('next-composer-input');
  await expect(input).toBeVisible();

  const lines128 = Array.from({ length: 128 }, (_, i) => `proto line ${i + 1}: ${'text'.repeat(5)}`).join('\n');

  await input.focus();
  await page.evaluate((val) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', val);
    const el = document.querySelector('[data-testid="next-composer-input"]');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: dt });
    el.dispatchEvent(event);
  }, lines128);

  await expect(input).toHaveValue('');
  const pasteTag = page.getByTestId('next-attach-paste');
  await expect(pasteTag).toBeVisible();
  await expect(pasteTag).toContainText('128 行');

  // Peek
  await pasteTag.click();
  await expect(page.getByTestId('next-paste-peek')).toBeVisible();
  await expect(page.getByTestId('next-paste-peek-head')).toContainText('proto line 1:');

  // Click tag again to close peek
  await pasteTag.click();
  await expect(page.getByTestId('next-paste-peek')).toHaveCount(0);

  // Re-open peek to test restore
  await pasteTag.click();
  await expect(page.getByTestId('next-paste-peek')).toBeVisible();

  // Restore
  await page.getByTestId('next-paste-peek-restore').click();
  await expect(pasteTag).toHaveCount(0);
  await expect(input).toHaveValue(lines128);

  // Clear and paste again
  await input.fill('');
  await page.evaluate((val) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', val);
    const el = document.querySelector('[data-testid="next-composer-input"]');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: dt });
    el.dispatchEvent(event);
  }, lines128);
  await expect(pasteTag).toBeVisible();

  // Send
  await page.getByTestId('next-send').click();

  const userMsg = page.getByTestId('next-item-user').first();
  await expect(userMsg).toBeVisible();
  const pasteBlock = userMsg.getByTestId('next-user-paste');
  await expect(pasteBlock).toBeVisible();
  await expect(pasteBlock).toContainText('128 行');

  const pasteText = pasteBlock.getByTestId('next-user-paste-text');
  await expect(pasteText).toHaveClass(/is-collapsed/);

  // Toggle expand
  await pasteBlock.getByTestId('next-user-paste-toggle').click();
  await expect(pasteText).toHaveClass(/is-expanded/);
  await expect(pasteText).toContainText('proto line 128:');

  // Toggle collapse
  await pasteBlock.getByTestId('next-user-paste-toggle').click();
  await expect(pasteText).toHaveClass(/is-collapsed/);

  expectClean(state);
});

