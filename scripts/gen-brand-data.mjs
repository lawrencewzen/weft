/**
 * Extract brand / model / provider metadata from @lobehub/icons (MIT).
 * Fetches the pinned tarball into a temp dir; does not add the React package
 * as a project dependency. SVG variants come from @lobehub/icons-static-svg.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS_PACKAGE = '@lobehub/icons';
const ICONS_VERSION = '5.23.0';
const SVG_PACKAGE = '@lobehub/icons-static-svg';
const SVG_VERSION = '1.95.1';
const OUT = path.join(ROOT, 'public', 'brand-data.json');
const require = createRequire(import.meta.url);

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function packExtract(spec) {
  const dir = mkdtempSync(path.join(tmpdir(), 'weft-brand-'));
  execFileSync(npmCmd(), ['pack', spec, '--pack-destination', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tgz = readdirSync(dir).find((name) => name.endsWith('.tgz'));
  if (!tgz) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`npm pack ${spec} produced no tarball`);
  }
  execFileSync('tar', ['-xzf', tgz], { cwd: dir, stdio: 'pipe' });
  return { dir, root: path.join(dir, 'package') };
}

function readUtf8(file) {
  return readFileSync(file, 'utf8');
}

function parseEnum(src) {
  const map = new Map();
  const re = /ModelProvider\["(\w+)"\]\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(src))) map.set(match[1], match[2]);
  if (map.size === 0) throw new Error('no ModelProvider entries');
  return map;
}

function parseJsStringArray(literal) {
  return new Function(`"use strict"; return (${literal});`)();
}

function extractModelMappings(src) {
  const start = src.indexOf('export var modelMappings');
  if (start < 0) throw new Error('modelMappings not found');
  const body = src.slice(start);
  const re = /Icon:\s*([A-Za-z0-9_]+),\s*keywords:\s*(\[[^\]]*\])/g;
  const out = [];
  let match;
  while ((match = re.exec(body))) {
    out.push({ keywords: parseJsStringArray(match[2]), brand: match[1] });
  }
  if (out.length === 0) throw new Error('no modelMappings extracted');
  return out;
}

function parseKeywordItems(inner, enumMap) {
  const items = [];
  const re = /ModelProvider\.([A-Za-z0-9_]+)|'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(inner))) {
    if (match[1]) {
      const value = enumMap.get(match[1]);
      if (value == null) throw new Error(`unknown ModelProvider.${match[1]}`);
      items.push({ providerId: value, enumKey: match[1] });
    } else {
      const raw = match[2] != null ? match[2] : match[3];
      items.push({ providerId: parseJsStringArray(`'${raw}'`), enumKey: null });
    }
  }
  return items;
}

function extractProviderMappings(src, enumMap) {
  const start = src.indexOf('export var providerMappings');
  if (start < 0) throw new Error('providerMappings not found');
  const body = src.slice(start);
  const re = /Icon:\s*([A-Za-z0-9_]+),[\s\S]*?keywords:\s*\[([^\]]*)\]/g;
  const out = [];
  let match;
  while ((match = re.exec(body))) {
    out.push({ icon: match[1], items: parseKeywordItems(match[2], enumMap) });
  }
  if (out.length === 0) throw new Error('no providerMappings extracted');
  return out;
}

function brandLookup(brands) {
  const exact = new Map();
  const lower = new Map();
  for (const brand of brands) {
    exact.set(brand.id, brand.id);
    lower.set(brand.id.toLowerCase(), brand.id);
  }
  return function resolve(name) {
    if (!name) return null;
    return exact.get(name) || lower.get(String(name).toLowerCase()) || null;
  };
}

function resolveProviderBrand(enumKey, iconName, lookup) {
  return lookup(enumKey) || lookup(iconName) || iconName;
}

function svgVariants(stem, files) {
  const variants = [];
  if (files.has(`${stem}.svg`)) variants.push('mono');
  if (files.has(`${stem}-color.svg`)) variants.push('color');
  if (files.has(`${stem}-text.svg`)) variants.push('text');
  return variants;
}

function svgFileSet() {
  const pkgJson = require.resolve(`${SVG_PACKAGE}/package.json`);
  const dir = path.join(path.dirname(pkgJson), 'icons');
  if (!existsSync(dir)) throw new Error(`missing ${SVG_PACKAGE} icons at ${dir}`);
  return new Set(readdirSync(dir).filter((name) => name.endsWith('.svg')));
}

function main() {
  const packed = packExtract(`${ICONS_PACKAGE}@${ICONS_VERSION}`);
  try {
    const toc = JSON.parse(readUtf8(path.join(packed.root, 'es', 'toc.json')));
    if (!Array.isArray(toc) || toc.length === 0) throw new Error('toc.json is empty');
    const svgFiles = svgFileSet();
    const brands = toc.map((item) => {
      const id = item.id;
      const stem = String(id).toLowerCase();
      return {
        id,
        title: item.title,
        color: item.color,
        group: item.group,
        variants: svgVariants(stem, svgFiles),
      };
    });
    const lookup = brandLookup(brands);
    for (const brand of brands) {
      if (!brand.variants.includes('mono')) {
        throw new Error(`brand ${brand.id} has no mono svg`);
      }
    }

    // 5.23.0 es/features/modelConfig.js has 103 modelMappings (the task sheet said 104).
    const models = extractModelMappings(readUtf8(path.join(packed.root, 'es', 'features', 'modelConfig.js')));
    for (const row of models) {
      if (!lookup(row.brand)) throw new Error(`model brand ${row.brand} not in toc`);
    }

    const enumMap = parseEnum(readUtf8(path.join(packed.root, 'es', 'features', 'providerEnum.js')));
    const providerRows = extractProviderMappings(
      readUtf8(path.join(packed.root, 'es', 'features', 'providerConfig.js')),
      enumMap,
    );
    const providers = {};
    for (const row of providerRows) {
      for (const item of row.items) {
        const key = String(item.providerId).toLowerCase();
        if (!key || Object.prototype.hasOwnProperty.call(providers, key)) continue;
        providers[key] = resolveProviderBrand(item.enumKey, row.icon, lookup);
      }
    }

    const data = {
      source: {
        package: ICONS_PACKAGE,
        version: ICONS_VERSION,
        license: 'MIT',
        notice: `Brand metadata extracted from ${ICONS_PACKAGE}@${ICONS_VERSION} (MIT). SVG files copied from ${SVG_PACKAGE}@${SVG_VERSION} (MIT). https://github.com/lobehub/lobe-icons`,
      },
      brands,
      models,
      providers,
    };
    const text = `${JSON.stringify(data, null, 2)}\n`;
    writeFileSync(OUT, text);
    process.stdout.write(
      `wrote ${path.relative(ROOT, OUT)} brands=${brands.length} models=${models.length} providers=${Object.keys(providers).length}\n`,
    );
  } finally {
    rmSync(packed.dir, { recursive: true, force: true });
  }
}

main();
