/** Provider views: brand, localized names, and lastTest → status. */

import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from '../../core/model-sources.mjs';
import type { components } from '../contract.gen.ts';
import { hasPhrase, localizedProviderName, phrase, type Lang } from '../phrases/index.ts';
import { formatProbeFailureForLang } from './probe-error.ts';
import { brandIcons, brandIdOf } from './brand.ts';

export type Provider = components['schemas']['Provider'];
export type ProviderModel = components['schemas']['ProviderModel'];
export type ProviderAuth = components['schemas']['ProviderAuth'];
export type ProviderStatus = components['schemas']['ProviderStatus'];
export type ProvidersSnapshot = components['schemas']['ProvidersSnapshot'];
export type AvailableProvider = components['schemas']['AvailableProvider'];
export type AvailableProvidersSnapshot = components['schemas']['AvailableProvidersSnapshot'];
export type ResolvedModel = components['schemas']['ResolvedModel'];
export type ProviderDefaults = components['schemas']['ProviderDefaults'];
export type LoginSession = components['schemas']['LoginSession'];
export type ProviderEnvelope = components['schemas']['ProviderEnvelope'];
export type LoginSessionEnvelope = components['schemas']['LoginSessionEnvelope'];

export { CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX };

export const POPULAR_PROVIDER_IDS = Object.freeze([
  'deepseek',
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'moonshotai-cn',
  'zai',
  'qwen-token-plan-cn',
  'minimax-cn',
  'xiaomi',
]);

export const EXCLUDED_PROVIDER_IDS = Object.freeze(['xai', 'openai-codex', 'radius', 'typesafe']);

/**
 * Maps a provider id to a brand-data.json icon id.
 * Same table as T59-3 `web/src/data/providerBrand.ts`.
 */
export function providerBrand(providerId: string | null | undefined): string | null {
  if (!providerId) return null;
  const id = providerId.trim().toLowerCase();
  if (!id) return null;

  if (id.startsWith('qwen-token-plan')) return 'qwen';
  if (id === 'zai' || id === 'zai-coding-cn') return 'zhipu';
  if (id === 'kimi-coding') return 'kimi';
  if (id.startsWith('moonshotai')) return 'moonshot';
  if (id.startsWith('minimax')) return 'minimax';
  if (id.startsWith('xiaomi')) return 'xiaomi';
  if (id === 'amazon-bedrock') return 'aws';
  if (id === 'azure') return 'azure';
  if (id === 'google-vertex') return 'googlecloud';
  if (id === 'ant-ling') return 'antgroup';
  if (id === 'baseten') return 'baseten';
  if (id === 'cerebras') return 'cerebras';
  if (id.startsWith('cloudflare')) return 'cloudflare';
  if (id === 'fireworks') return 'fireworks';
  if (id === 'github-copilot') return 'githubcopilot';
  if (id === 'groq') return 'groq';
  if (id === 'huggingface') return 'huggingface';
  if (id === 'meta') return 'meta';
  if (id === 'mistral') return 'mistral';
  if (id === 'nvidia') return 'nvidia';
  if (id.startsWith('opencode')) return 'opencode';
  if (id === 'together') return 'together';
  if (id.startsWith('vercel')) return 'vercel';
  if (id === 'deepseek') return 'deepseek';
  if (id === 'anthropic') return 'anthropic';
  if (id === 'openai') return 'openai';
  if (id === 'google') return 'google';
  if (id === 'openrouter') return 'openrouter';

  return null;
}

export function displayProviderName(id: string, fallback: string, lang: Lang): string {
  return localizedProviderName(id, fallback, lang);
}

export type RawLastTest = {
  ok?: unknown;
  at?: unknown;
  code?: unknown;
  error?: unknown;
  status?: unknown;
} | null | undefined;

export type RawModel = {
  id: string;
  name: string;
  enabled: boolean;
  contextWindow: number | null;
  maxTokens: number | null;
  images: boolean;
  reasoning: boolean;
  thinkingLevels?: string[];
  defaultThinkingLevel?: string | null;
  overridden: { contextWindow?: boolean; maxTokens?: boolean };
};

export type RawProvider = {
  id: string;
  kind: 'builtin' | 'custom';
  name: string;
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  baseUrl?: string;
  auth: ProviderAuth;
  lastTest?: RawLastTest;
  status?: ProviderStatus;
  models: RawModel[];
};

export type RawAvailable = {
  id: string;
  name: string;
  authMethods: Array<'api_key' | 'oauth'>;
  modelCount: number;
  popular: boolean;
  envVar?: string;
  envDetected: boolean;
  connected: boolean;
};

export type RawLoginSession = {
  id: string;
  providerId: string;
  state: LoginSession['state'];
  events: LoginSession['events'];
  prompt?: LoginSession['prompt'];
  error?: string;
  errorPhrase?: string;
  provider?: RawProvider;
};

function testedAtOf(lastTest: RawLastTest): number | undefined {
  if (!lastTest || typeof lastTest !== 'object') return undefined;
  if (typeof lastTest.at === 'number' && Number.isFinite(lastTest.at) && lastTest.at > 0) {
    return Math.round(lastTest.at);
  }
  if (typeof lastTest.at === 'string') {
    const parsed = Date.parse(lastTest.at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function probeKindOf(code: unknown): string {
  const text = String(code || '').trim().toUpperCase();
  if (text === 'E_AUTH' || text === 'AUTH') return 'auth';
  if (text === 'E_NETWORK' || text === 'NETWORK' || text === 'TIMEOUT') return 'network';
  if (text === 'E_HTTP' || text === 'HTTP' || text === 'NOT_FOUND' || text === 'BAD_JSON') return 'http';
  return '';
}

export function statusView(lastTest: RawLastTest, lang: Lang): ProviderStatus {
  if (!lastTest || typeof lastTest !== 'object') return { state: 'untested' };
  const testedAt = testedAtOf(lastTest);
  if (lastTest.ok === true) {
    const status: ProviderStatus = { state: 'ok' };
    if (testedAt != null) status.testedAt = testedAt;
    return status;
  }
  const status: ProviderStatus = { state: 'error' };
  if (testedAt != null) status.testedAt = testedAt;
  const kind = probeKindOf(lastTest.code);
  const error = formatProbeFailureForLang({
    error: lastTest.error,
    code: kind || undefined,
    status: lastTest.status,
  }, lang);
  if (error) status.error = error;
  return status;
}

export function modelView(model: RawModel): ProviderModel {
  const thinkingLevels = Array.isArray(model.thinkingLevels)
    ? model.thinkingLevels.filter((item): item is NonNullable<ProviderModel['thinkingLevels']>[number] => typeof item === 'string')
    : [];
  return {
    id: model.id,
    name: model.name || model.id,
    brand: brandIdOf(brandIcons().brandForModel(model.id)),
    enabled: model.enabled === true,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    images: model.images === true,
    reasoning: model.reasoning === true,
    thinkingLevels,
    defaultThinkingLevel: typeof model.defaultThinkingLevel === 'string'
      ? model.defaultThinkingLevel as NonNullable<ProviderModel['defaultThinkingLevel']>
      : null,
    overridden: {
      ...(model.overridden?.contextWindow ? { contextWindow: true } : {}),
      ...(model.overridden?.maxTokens ? { maxTokens: true } : {}),
    },
  };
}

export function providerView(raw: RawProvider, lang: Lang): Provider {
  const item: Provider = {
    id: raw.id,
    kind: raw.kind,
    brand: raw.kind === 'custom' ? null : providerBrand(raw.id),
    name: raw.kind === 'custom' ? raw.name : displayProviderName(raw.id, raw.name, lang),
    auth: raw.auth,
    status: raw.status?.state === 'testing'
      ? { state: 'testing', ...(typeof raw.status.testedAt === 'number' ? { testedAt: raw.status.testedAt } : {}) }
      : statusView(raw.lastTest, lang),
    models: raw.models.map(modelView),
  };
  if (raw.kind === 'custom') {
    if (raw.api) item.api = raw.api;
    if (raw.baseUrl) item.baseUrl = raw.baseUrl;
  }
  return item;
}

export function availableView(raw: RawAvailable, lang: Lang): AvailableProvider {
  const item: AvailableProvider = {
    id: raw.id,
    name: displayProviderName(raw.id, raw.name, lang),
    authMethods: raw.authMethods,
    modelCount: raw.modelCount,
    popular: raw.popular === true,
    envDetected: raw.envDetected === true,
    connected: raw.connected === true,
  };
  const brand = providerBrand(raw.id);
  if (brand) item.brand = brand;
  else item.brand = null;
  if (raw.envVar) item.envVar = raw.envVar;
  return item;
}

export function loginSessionView(raw: RawLoginSession, lang: Lang): LoginSession {
  const session: LoginSession = {
    id: raw.id,
    providerId: raw.providerId,
    state: raw.state,
    events: raw.events || [],
  };
  if (raw.prompt) session.prompt = raw.prompt;
  if (raw.state === 'error') {
    if (raw.errorPhrase && hasPhrase(lang, raw.errorPhrase)) {
      session.error = phrase(lang, raw.errorPhrase);
    } else if (raw.error) {
      session.error = formatProbeFailureForLang({ error: raw.error }, lang) || raw.error;
    }
  }
  if (raw.state === 'cancelled' && !session.error && hasPhrase(lang, 'src_err_cancelled')) {
    // cancelled does not require error; omit
  }
  if (raw.provider) session.provider = providerView(raw.provider, lang);
  return session;
}

export function providersSnapshotFrom(raw: {
  providers: RawProvider[];
  defaultModel: ResolvedModel | null;
}, lang: Lang): ProvidersSnapshot {
  return {
    providers: raw.providers.map((item) => providerView(item, lang)),
    defaultModel: raw.defaultModel,
  };
}

export type ServiceErrorLike = {
  code?: unknown;
  message?: unknown;
  phrase?: unknown;
  params?: Record<string, unknown>;
  status?: unknown;
};

export function serviceErrorBody(err: ServiceErrorLike | null | undefined, lang: Lang): {
  error: string;
  code: string;
} {
  const code = err?.code != null && String(err.code).trim() ? String(err.code).trim() : 'E_INTERNAL';
  if (code === 'E_AUTH' || code === 'E_NETWORK' || code === 'E_HTTP') {
    return {
      error: formatProbeFailureForLang({
        error: err?.message,
        code: probeKindOf(code) || undefined,
        status: err?.status,
      }, lang),
      code,
    };
  }
  const key = err?.phrase != null ? String(err.phrase) : '';
  if (key && hasPhrase(lang, key)) {
    return { error: phrase(lang, key, err?.params), code };
  }
  const message = err?.message != null ? String(err.message).trim() : '';
  if (code === 'E_NOT_FOUND') return { error: phrase(lang, 'src_err_missing'), code };
  return { error: message || phrase(lang, 'src_err_missing'), code };
}
