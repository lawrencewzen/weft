import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: webRoot,
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
