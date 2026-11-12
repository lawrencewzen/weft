import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { describe, expect, it } from 'vitest';
import brandData from '../../../src/v2/views/brand-data.json';
import { brandIcons, brandIdOf } from '../../../src/v2/views/brand';
import { ACP_CATALOG } from '../components/settings/AddProviderDialog';
import { optionalBrandIconFiles, requiredBrandIconFiles } from './brandIconManifest';
import { BAKED_COLOR_BRANDS, brandIconUrl } from './composerModel';
import { PROVIDER_BRAND_IDS, providerBrand } from './providerBrand';

const required = new Set(requiredBrandIconFiles());
const PREFIX = '/vendor/brand-icons/';

function fileOf(url: string | null): string {
  expect(url).not.toBeNull();
  expect(url!.startsWith(PREFIX)).toBe(true);
  return url!.slice(PREFIX.length);
}

describe('brand icon manifest', () => {
  it('is a strict subset of the svg package, not all of it', () => {
    const iconsDir = path.join(
      path.dirname(createRequire(import.meta.url).resolve('@lobehub/icons-static-svg/package.json')),
      'icons',
    );
    for (const file of required) expect(existsSync(path.join(iconsDir, file)), file).toBe(true);
    expect(required.size).toBeGreaterThan(300);
    expect(required.size).toBeLessThan(500);
    expect(optionalBrandIconFiles().length).toBeLessThan(100);
  });

  it('covers every brand in brand-data.json (model, custom endpoint and server iconUrl)', () => {
    const icons = brandIcons();
    for (const brand of brandData.brands) {
      expect(required.has(fileOf(brandIconUrl(brand.id))), brand.id).toBe(true);
      expect(required.has(fileOf(`/${icons.iconUrl(brand.id)}`)), brand.id).toBe(true);
    }
  });

  it('covers every provider brand the client can name', () => {
    for (const id of PROVIDER_BRAND_IDS) expect(required.has(fileOf(brandIconUrl(id))), id).toBe(true);
    for (const id of BAKED_COLOR_BRANDS) expect(required.has(fileOf(brandIconUrl(id))), id).toBe(true);
    for (const acp of ACP_CATALOG) expect(required.has(fileOf(brandIconUrl(acp.brand))), acp.id).toBe(true);
  });

  it('covers every built-in provider and model pi-ai ships', () => {
    const icons = brandIcons();
    const providers = getBuiltinProviders() as readonly string[];
    expect(providers.length).toBeGreaterThan(10);
    let checked = 0;
    for (const provider of providers) {
      const id = provider;
      for (const brand of [providerBrand(id), brandIdOf(icons.brandForProvider(id))]) {
        if (brand) {
          expect(required.has(fileOf(brandIconUrl(brand))), `${id} -> ${brand}`).toBe(true);
          checked += 1;
        }
      }
      for (const model of getBuiltinModels(id as never)) {
        const brand = brandIdOf(icons.brandForModel(model.id));
        if (brand) {
          expect(required.has(fileOf(brandIconUrl(brand))), `${id}/${model.id} -> ${brand}`).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('random brandIconUrl results are all in the manifest', () => {
    const ids = [
      ...brandData.brands.map((b) => b.id),
      ...PROVIDER_BRAND_IDS,
      'Claude',
      'xiaomi',
    ];
    let seed = 143;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 200; i += 1) {
      const id = ids[Math.floor(next() * ids.length)];
      expect(required.has(fileOf(brandIconUrl(id))), id).toBe(true);
    }
  });
});
