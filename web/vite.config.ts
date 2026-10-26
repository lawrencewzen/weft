import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, '..');

const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i;

export default defineConfig({
  root: webRoot,
  base: '/next/',
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
        const src = path.resolve(repoRoot, 'public/vendor/brand-icons');
        const dest = path.resolve(repoRoot, 'public-next/vendor/brand-icons');
        if (!existsSync(src)) return;
        cpSync(src, dest, { recursive: true });
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
