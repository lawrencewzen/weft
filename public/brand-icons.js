/** Brand lookup for model / provider ids. Data is passed in (no fetch required). */

const ICON_PREFIX = 'vendor/brand-icons';
const ACRONYMS = new Set(['ai', 'api', 'cli', 'gpt', 'glm', 'llm', 'tts', 'vl']);

function asText(value) {
  return value == null ? '' : String(value).trim();
}

function iconStem(brandId) {
  return String(brandId || '').toLowerCase();
}

function compileRules(models) {
  const rules = [];
  for (const row of models || []) {
    const patterns = [];
    for (const keyword of row.keywords || []) {
      try {
        patterns.push(new RegExp(keyword, 'i'));
      } catch {
        // skip malformed keywords from the source table
      }
    }
    if (patterns.length) rules.push({ brand: row.brand, patterns });
  }
  return rules;
}

function prettyToken(token) {
  if (/^\d+(?:\.\d+)*$/.test(token)) return token;
  const lower = token.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  if (/^v\d/i.test(token)) return `V${token.slice(1)}`;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

function brandWords(brand) {
  const words = new Set();
  for (const value of [brand.id, brand.title]) {
    for (const part of String(value || '').split(/[\s/_-]+/)) {
      const key = part.toLowerCase();
      if (key.length > 1) words.add(key);
    }
  }
  return words;
}

function modelLeaf(modelId) {
  const text = asText(modelId);
  if (!text) return '';
  const parts = text.split('/').filter(Boolean);
  return parts[parts.length - 1] || text;
}

/**
 * @param {object} data parsed public/brand-data.json
 */
export function createBrandIcons(data) {
  const brands = Array.isArray(data?.brands) ? data.brands : [];
  const byId = new Map();
  const byIdLower = new Map();
  for (const brand of brands) {
    byId.set(brand.id, brand);
    byIdLower.set(String(brand.id).toLowerCase(), brand);
  }
  const rules = compileRules(data?.models);
  const providers = data?.providers && typeof data.providers === 'object' ? data.providers : {};

  function resolveBrand(name) {
    if (!name) return null;
    if (typeof name === 'object' && name.id) return byId.get(name.id) || name;
    return byId.get(name) || byIdLower.get(String(name).toLowerCase()) || null;
  }

  function brandForModel(modelId) {
    const model = asText(modelId).toLowerCase();
    if (!model) return null;
    for (const rule of rules) {
      if (rule.patterns.some((re) => re.test(model))) return resolveBrand(rule.brand);
    }
    return null;
  }

  function brandForProvider(providerId) {
    const key = asText(providerId).toLowerCase();
    if (!key) return null;
    const mapped = providers[key];
    if (mapped) {
      const brand = resolveBrand(mapped);
      if (brand) return brand;
    }
    return resolveBrand(key);
  }

  function iconUrl(brand, options = {}) {
    const resolved = resolveBrand(brand);
    if (!resolved) return null;
    const stem = iconStem(resolved.id);
    const wantColor = Boolean(options && options.color);
    const variants = Array.isArray(resolved.variants) ? resolved.variants : [];
    const file = wantColor && variants.includes('color') ? `${stem}-color.svg` : `${stem}.svg`;
    return `${ICON_PREFIX}/${file}`;
  }

  function displayName(modelId) {
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
    return rest ? `${name} ${rest}` : name;
  }

  return { brandForModel, brandForProvider, iconUrl, displayName };
}
