import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, '..');
const require = createRequire(import.meta.url);

const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i;

export default defineConfig({
  root: webRoot,
  base: '/',
  plugins: [
    react(),
    {
      name: 'weft-no-inline-scripts',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          if (INLINE_SCRIPT_RE.test(html)) {
            throw new Error('built HTML contains an inline script; that violates CSP script-src \'self\'');
          }
          return html;
        },
      },
    },
    {
      name: 'copy-brand-icons',
      apply: 'build',
      closeBundle() {
        const src = path.resolve(
          path.dirname(require.resolve('@lobehub/icons-static-svg/package.json')),
          'icons',
        );
        const dest = path.resolve(repoRoot, 'public-next/vendor/brand-icons');
        if (!existsSync(src)) return;
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(dest, { recursive: true });
        for (const name of readdirSync(src)) {
          if (!name.endsWith('.svg')) continue;
          copyFileSync(path.join(src, name), path.join(dest, name));
        }
      },
    },
  ],
  build: {
    outDir: path.resolve(repoRoot, 'public-next'),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: {
      '/api': process.env.WEFT_URL || 'http://127.0.0.1:3000',
      '/vendor': process.env.WEFT_URL || 'http://127.0.0.1:3000',
    },
  },
});
