/** Provider views. HTTP is 503 until T59-4b rewrites this layer. */

import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from '../../core/model-sources.mjs';
import type { components } from '../contract.gen.ts';
import type { Lang } from '../phrases/index.ts';

export type Provider = components['schemas']['Provider'];
export type ProviderModel = components['schemas']['ProviderModel'];
export type Vendor = components['schemas']['Vendor'];
export type ProvidersSnapshot = components['schemas']['ProvidersSnapshot'];
export type ResolvedModel = components['schemas']['ResolvedModel'];
export type ProviderDefaults = components['schemas']['ProviderDefaults'];
export type ProviderProbeResult = components['schemas']['ProviderProbeResult'];
export type ProviderAccess = components['schemas']['ProviderAccess'];
export type ProviderStatus = components['schemas']['ProviderStatus'];

export type SettingsLike = {
  providers?: unknown;
  defaultModel?: unknown;
  [key: string]: unknown;
};

export { CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX };

export function providersSnapshot(_opts?: {
  settings?: SettingsLike | null;
  lang?: Lang;
}): ProvidersSnapshot {
  return { providers: [], vendors: [], defaultModel: null };
}
