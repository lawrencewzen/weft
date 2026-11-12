import brandData from '../../../src/v2/views/brand-data.json';
import { BAKED_COLOR_BRANDS, BRAND_ICON_FILE } from './composerModel';
import { PROVIDER_BRAND_IDS } from './providerBrand';

/**
 * Which files under /vendor/brand-icons the app can request. Derived from the
 * data that decides the requests (brand-data.json, providerBrand.ts,
 * composerModel.ts); the build copies exactly these from @lobehub/icons-static-svg.
 */

type BrandRow = { id: string };

/** Brand ids that models and custom endpoints can resolve to (any brand-data.json brand). */
function dataBrandIds(): string[] {
  const rows = (brandData as { brands: BrandRow[] }).brands;
  return rows.map((row) => row.id.toLowerCase());
}

/** Brand ids the client names explicitly (provider table and baked-in colour brands). */
function explicitBrandIds(): string[] {
  return [...PROVIDER_BRAND_IDS, ...BAKED_COLOR_BRANDS].map((id) => id.toLowerCase());
}

/** brandIconUrl() requests the alias file for aliased ids (claude, xiaomi), never the id itself. */
function stemsOf(id: string): string[] {
  return [BRAND_ICON_FILE[id] ?? id];
}

/** Files that must exist in the svg package. */
export function requiredBrandIconFiles(): string[] {
  const stems = new Set<string>();
  // brand-data brands: the server's iconUrl() uses the id itself, the client the alias.
  for (const id of dataBrandIds()) {
    stems.add(id);
    for (const stem of stemsOf(id)) stems.add(stem);
  }
  for (const id of explicitBrandIds()) {
    for (const stem of stemsOf(id)) stems.add(stem);
  }
  return [...stems].map((stem) => `${stem}.svg`).sort();
}

/** Colour variants of explicitly named brands; copied when the package has them. */
export function optionalBrandIconFiles(): string[] {
  const stems = new Set<string>();
  for (const id of explicitBrandIds()) {
    for (const stem of stemsOf(id)) stems.add(`${stem}-color`);
  }
  return [...stems].map((stem) => `${stem}.svg`).sort();
}
