import assert from 'node:assert/strict';
import test from 'node:test';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { providerBrand as webProviderBrand } from '../../web/src/data/providerBrand.ts';
import { providerBrand as serverProviderBrand } from '../../src/v2/views/providers.ts';

// The build only copies the brand icons the web table can name (web/src/data/brandIconManifest.ts),
// so the server table must never name a brand the web table does not.
test('server and web providerBrand agree on every built-in provider', () => {
  const ids = [...getBuiltinProviders(), 'kimi-coding', 'unknown-x', '', null];
  for (const id of ids) {
    assert.equal(serverProviderBrand(id), webProviderBrand(id), `provider ${id}`);
  }
});
