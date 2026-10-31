import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';

/**
 * @typedef {import('@playwright/test').Page} Page
 * @typedef {{ method: string, url: string }} ProtoRequest
 * @typedef {{
 *   consoleErrors: string[],
 *   pageErrors: string[],
 *   external: string[],
 *   requests: () => Promise<ProtoRequest[]>,
 * }} ProtoWatch
 */

/**
 * Shared helpers for the `file://` prototype specs. Every spec asserts the same
 * three invariants: no console errors, no uncaught page errors, no network.
 */
export const protoFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'design',
  'prototype',
  'index.html',
);

export function watch(page) {
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const pageErrors = [];
  /** @type {string[]} */
  const external = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('request', (req) => {
    const url = req.url();
    if (!/^(file|data|blob):/i.test(url)) external.push(url);
  });
  return {
    consoleErrors,
    pageErrors,
    external,
    requests: () => page.evaluate(() => window.__protoRequests || []),
  };
}

export function expectClean(state) {
  expect(state.pageErrors, 'no uncaught errors').toEqual([]);
  expect(state.consoleErrors, 'no console errors').toEqual([]);
  expect(state.external, 'no external requests').toEqual([]);
}

export async function openProto(page, query = '') {
  expect(fs.existsSync(protoFile), 'prototype build missing: run `npm run build:proto`').toBe(true);
  const state = watch(page);
  const href = pathToFileURL(protoFile).href + (query ? (query.startsWith('?') ? query : `?${query}`) : '');
  await page.goto(href);
  await expect(page.getByTestId('next-app')).toBeVisible();
  return state;
}
