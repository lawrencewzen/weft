/** Brand lookup for model / provider ids. Port of public/brand-icons.js; data from public/brand-data.json. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICON_PREFIX = 'vendor/brand-icons';
const ACRONYMS = new Set(['ai', 'api', 'cli', 'gpt', 'glm', 'llm', 'tts', 'vl']);

export type BrandRecord = {
  id: string;
  title?: string;
  variants?: string[];
  [key: string]: unknown;
};

export type BrandData = {
  brands?: BrandRecord[];
  models?: Array<{ brand?: unknown; keywords?: unknown[] }>;
  providers?: Record<string, unknown>;
};

export type BrandIcons = {
  brandForModel: (modelId: unknown) => BrandRecord | null;
  brandForProvider: (providerId: unknown) => BrandRecord | null;
  iconUrl: (brand: unknown, options?: { color?: boolean }) => string | null;
  displayName: (modelId: unknown) => string;
};

const BRAND_DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../public/brand-data.json');

let cachedIcons: BrandIcons | null = null;

function asText(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function iconStem(brandId: unknown): string {
  return String(brandId || '').toLowerCase();
}

function compileRules(models: BrandData['models']): Array<{ brand: unknown; patterns: RegExp[] }> {
  const rules: Array<{ brand: unknown; patterns: RegExp[] }> = [];
  for (const row of models || []) {
    const patterns: RegExp[] = [];
    for (const keyword of row.keywords || []) {
      try {
        patterns.push(new RegExp(String(keyword), 'i'));
      } catch {
        // skip malformed keywords from the source table
      }
    }
    if (patterns.length) rules.push({ brand: row.brand, patterns });
  }
  return rules;
}

function prettyToken(token: string): string {
  if (/^\d+(?:\.\d+)*$/.test(token)) return token;
  const lower = token.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  if (/^v\d/i.test(token)) return `V${token.slice(1)}`;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

function brandWords(brand: BrandRecord): Set<string> {
  const words = new Set<string>();
  for (const value of [brand.id, brand.title]) {
    for (const part of String(value || '').split(/[\s/_-]+/)) {
      const key = part.toLowerCase();
      if (key.length > 1) words.add(key);
    }
  }
  return words;
}

function modelLeaf(modelId: unknown): string {
  const text = asText(modelId);
  if (!text) return '';
  const parts = text.split('/').filter(Boolean);
  return parts[parts.length - 1] || text;
}

/**
 * True when pretty-printed remainder already begins with the brand id or title
 * (e.g. "Qwen3" starts with "Qwen"). Exact brand tokens are stripped earlier
 * and still get the official title prepended ("DeepSeek Chat").
 */
function restStartsWithBrand(rest: string, brand: BrandRecord): boolean {
  const first = (rest.split(/\s+/)[0] || '').toLowerCase();
  if (!first) return false;
  for (const value of [brand.id, brand.title]) {
    const key = String(value || '').trim().toLowerCase();
    if (key.length > 1 && first.startsWith(key)) return true;
  }
  return false;
}

/** Same matching rules as public/brand-icons.js `createBrandIcons`. */
export function createBrandIcons(data: BrandData | null | undefined): BrandIcons {
  const brands = Array.isArray(data?.brands) ? data.brands : [];
  const byId = new Map<unknown, BrandRecord>();
  const byIdLower = new Map<string, BrandRecord>();
  for (const brand of brands) {
    byId.set(brand.id, brand);
    byIdLower.set(String(brand.id).toLowerCase(), brand);
  }
  const rules = compileRules(data?.models);
  const providers = data?.providers && typeof data.providers === 'object' ? data.providers : {};

  function resolveBrand(name: unknown): BrandRecord | null {
    if (!name) return null;
    if (typeof name === 'object' && name && 'id' in name && (name as { id?: unknown }).id) {
      return byId.get((name as { id: unknown }).id) || (name as BrandRecord);
    }
    return byId.get(name) || byIdLower.get(String(name).toLowerCase()) || null;
  }

  function brandForModel(modelId: unknown): BrandRecord | null {
    const model = asText(modelId).toLowerCase();
    if (!model) return null;
    for (const rule of rules) {
      if (rule.patterns.some((re) => re.test(model))) return resolveBrand(rule.brand);
    }
    return null;
  }

  function brandForProvider(providerId: unknown): BrandRecord | null {
    const key = asText(providerId).toLowerCase();
    if (!key) return null;
    const mapped = providers[key];
    if (mapped) {
      const brand = resolveBrand(mapped);
      if (brand) return brand;
    }
    return resolveBrand(key);
  }

  function iconUrl(brand: unknown, options: { color?: boolean } = {}): string | null {
    const resolved = resolveBrand(brand);
    if (!resolved) return null;
    const stem = iconStem(resolved.id);
    const wantColor = Boolean(options && options.color);
    const variants = Array.isArray(resolved.variants) ? resolved.variants : [];
    const file = wantColor && variants.includes('color') ? `${stem}-color.svg` : `${stem}.svg`;
    return `${ICON_PREFIX}/${file}`;
  }

  function displayName(modelId: unknown): string {
    const raw = modelId == null ? '' : String(modelId);
    if (!raw.trim()) return raw;
    const brand = brandForModel(raw);
    if (!brand) return raw;
    const leaf = modelLeaf(raw);
    const skip = brandWords(brand);
    const rest = leaf
      .split(/[-_]+/)
      .filter(Boolean)
      .filter((token) => !skip.has(token.toLowerCase()))
      .map(prettyToken)
      .join(' ');
    const name = brand.title || brand.id;
    if (!rest) return name;
    if (restStartsWithBrand(rest, brand)) return rest;
    return `${name} ${rest}`;
  }

  return { brandForModel, brandForProvider, iconUrl, displayName };
}

export function loadBrandData(path = BRAND_DATA_PATH): BrandData {
  return JSON.parse(readFileSync(path, 'utf8')) as BrandData;
}

/** Shared server-side brand table. Reads public/brand-data.json once. */
export function brandIcons(): BrandIcons {
  if (!cachedIcons) cachedIcons = createBrandIcons(loadBrandData());
  return cachedIcons;
}

export function brandIdOf(brand: BrandRecord | null | undefined): string | null {
  if (!brand || brand.id == null || String(brand.id) === '') return null;
  return String(brand.id);
}
