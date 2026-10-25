import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'public', 'vendor');
const require = createRequire(import.meta.url);

/** Exact browser ESM builds to copy. Do not add other node_modules files. */
const FILES = [
  ['marked', 'marked.esm.js'],
  ['dompurify', 'purify.es.mjs'],
];

mkdirSync(DEST, { recursive: true });
for (const [pkg, destName] of FILES) {
  const src = fileURLToPath(import.meta.resolve(pkg));
  let text = readFileSync(src, 'utf8');
  text = text.replace(/\n\/\/# sourceMappingURL=[^\n]*\n?/g, '\n');
  if (!text.endsWith('\n')) text += '\n';
  writeFileSync(path.join(DEST, destName), text);
  process.stdout.write(`copied ${pkg} -> public/vendor/${destName}\n`);
}

copyBrandIcons();

function copyBrandIcons() {
  const pkgJson = require.resolve('@lobehub/icons-static-svg/package.json');
  const srcDir = path.join(path.dirname(pkgJson), 'icons');
  const destDir = path.join(DEST, 'brand-icons');
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.svg')) continue;
    copyFileSync(path.join(srcDir, name), path.join(destDir, name));
    count += 1;
  }
  process.stdout.write(`copied @lobehub/icons-static-svg -> public/vendor/brand-icons/ (${count} svg)\n`);
}
