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
  ],
  build: {
    outDir: path.resolve(repoRoot, 'public-next'),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: {
      '/api': process.env.WEFT_URL || 'http://127.0.0.1:3000',
    },
  },
});
