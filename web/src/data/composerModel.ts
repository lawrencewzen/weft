import type { components } from '../../../src/v2/contract.gen';
import type { Model, Provider } from './providerTypes';

export type { Provider, Model };
export type ResolvedModel = components['schemas']['ResolvedModel'];
export type ConversationModel = components['schemas']['ConversationModel'];
export type ContextUsage = components['schemas']['ContextUsage'];
export type ThinkingLevel = components['schemas']['ThinkingLevel'];

export const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export const CONTEXT_WINDOW_MIN = 1000;
export const CONTEXT_WINDOW_MAX = 10_000_000;
export const CONTEXT_WINDOW_PRESETS = [32_000, 64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000];

export type ComposerModelOption = {
  providerId: string;
  providerName: string;
  providerBrand: string | null;
  modelId: string;
  displayName: string;
  brand: string | null;
  contextWindow: number;
  contextWindowCustom: boolean;
  isDefault: boolean;
  images: boolean;
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel | null;
};

export type ComposerModelGroup = {
  providerId: string;
  providerName: string;
  providerBrand: string | null;
  mixedBrands: boolean;
  models: ComposerModelOption[];
};

export function sameModel(
  a: { providerId: string; modelId: string } | null | undefined,
  b: { providerId: string; modelId: string } | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

export function conversationToResolved(model: ConversationModel | null | undefined): ResolvedModel | null {
  const providerId = model?.sourceId?.trim() || '';
  const modelId = model?.modelId?.trim() || '';
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

function optionOf(
  provider: Provider,
  model: Model,
  defaultModel: ResolvedModel | null,
): ComposerModelOption {
  return {
    providerId: provider.id,
    providerName: provider.name,
    providerBrand: provider.brand,
    modelId: model.id,
    displayName: model.name || model.id,
    brand: model.brand,
    contextWindow: model.contextWindow ?? 128_000,
    contextWindowCustom: Boolean(model.overridden?.contextWindow),
    isDefault: sameModel(defaultModel, { providerId: provider.id, modelId: model.id }),
    images: Boolean(model.images),
    thinkingLevels: Array.isArray(model.thinkingLevels) ? model.thinkingLevels : [],
    defaultThinkingLevel: model.defaultThinkingLevel ?? null,
  };
}

export function groupComposerModels(
  providers: readonly Provider[],
  defaultModel: ResolvedModel | null,
): ComposerModelGroup[] {
  const groups: ComposerModelGroup[] = [];
  for (const provider of providers) {
    const listed = Array.isArray(provider.models) ? provider.models : [];
    const models = listed
      .filter((model) => typeof model?.id === 'string' && model.id.trim() && model.enabled)
      .map((model) => optionOf(provider, model, defaultModel));
    if (!models.length) continue;
    const brands = new Set(models.map((model) => model.brand || ''));
    groups.push({
      providerId: provider.id,
      providerName: provider.name || provider.id,
      providerBrand: provider.brand,
      mixedBrands: brands.size > 1,
      models,
    });
  }
  return groups;
}

export function hasAvailableModels(providers: readonly Provider[]): boolean {
  return groupComposerModels(providers, null).length > 0;
}

export function findComposerModel(
  providers: readonly Provider[],
  ref: ResolvedModel | null | undefined,
  defaultModel: ResolvedModel | null = null,
): ComposerModelOption | null {
  if (!ref?.providerId || !ref.modelId) return null;
  const provider = providers.find((item) => item.id === ref.providerId);
  const model = provider?.models.find((item) => item.id === ref.modelId);
  if (!provider || !model) return null;
  return optionOf(provider, model, defaultModel);
}

export function resolveComposerSelection(opts: {
  providers: readonly Provider[];
  conversationModel: ConversationModel | null;
  defaultModel: ResolvedModel | null;
  draft: ResolvedModel | null;
  isDraft: boolean;
}): ComposerModelOption | null {
  const ref = opts.isDraft
    ? (opts.draft || opts.defaultModel)
    : (conversationToResolved(opts.conversationModel) || opts.defaultModel);
  const found = findComposerModel(opts.providers, ref, opts.defaultModel);
  if (found) return found;
  if (!ref) return null;
  return {
    providerId: ref.providerId,
    providerName: '',
    providerBrand: null,
    modelId: ref.modelId,
    displayName: opts.conversationModel?.label || ref.modelId,
    brand: null,
    contextWindow: 0,
    contextWindowCustom: false,
    isDefault: sameModel(opts.defaultModel, ref),
    images: false,
    thinkingLevels: [],
    defaultThinkingLevel: null,
  };
}

export function isSelectedOption(
  option: ComposerModelOption,
  selected: ComposerModelOption | null,
): boolean {
  if (!selected) return false;
  return option.providerId === selected.providerId && option.modelId === selected.modelId;
}

export function isValidContextWindow(value: number): boolean {
  return Number.isInteger(value) && value >= CONTEXT_WINDOW_MIN && value <= CONTEXT_WINDOW_MAX;
}

export function parseContextWindowInput(raw: string): number | null {
  const text = String(raw || '').trim().replace(/[_,\s]/g, '');
  if (!text) return null;
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  if (!isValidContextWindow(n)) return null;
  return n;
}

export type ContextWindowOption = {
  tokens: number;
  selected: boolean;
  custom?: boolean;
};

export function contextWindowOptions(current: number): ContextWindowOption[] {
  const n = Number.isFinite(current) ? Math.trunc(current) : 0;
  const rows: ContextWindowOption[] = CONTEXT_WINDOW_PRESETS.map((tokens) => ({
    tokens,
    selected: n === tokens,
  }));
  if (n > 0 && !CONTEXT_WINDOW_PRESETS.includes(n)) {
    rows.push({ tokens: n, selected: true, custom: true });
  }
  return rows;
}

const BRAND_ICON_FILE: Record<string, string> = {
  claude: 'anthropic',
  xiaomi: 'xiaomimimo',
};

const BAKED_COLOR_BRANDS = new Set([
  'amdradeoncloud',
  'cogvideo',
  'cogview',
  'crewai-brand',
  'crusoe',
  'cybercut',
  'lobehub',
  'openclaw',
  'poolside',
  'rwkv',
]);

export function isColorBrand(brand: string | null | undefined): boolean {
  if (!brand) return false;
  const lower = brand.trim().toLowerCase();
  return lower.endsWith('-color') || BAKED_COLOR_BRANDS.has(lower);
}

export function brandIconUrl(brand: string | null | undefined): string | null {
  const id = typeof brand === 'string' ? brand.trim() : '';
  if (!id) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return null;
  const file = BRAND_ICON_FILE[id.toLowerCase()] || id.toLowerCase();
  return `/vendor/brand-icons/${file}.svg`;
}

export function modelAttribution(
  modelId: string | undefined,
  providers: readonly Provider[],
  conversationModel: ConversationModel | null,
): { brand: string | null; displayName: string } | null {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id) return null;
  const pinned = conversationToResolved(conversationModel);
  if (pinned && pinned.modelId === id) {
    const found = findComposerModel(providers, pinned);
    if (found) return { brand: found.brand, displayName: found.displayName };
  }
  for (const provider of providers) {
    const model = provider.models.find((item) => item.id === id);
    if (model) return { brand: model.brand, displayName: model.name || id };
  }
  return { brand: null, displayName: id };
}

export function contextRemainPercent(ctx: Pick<ContextUsage, 'percent'>): number {
  const used = Number(ctx.percent);
  if (!Number.isFinite(used)) return 100;
  return Math.max(0, 100 - Math.min(100, Math.round(used)));
}

export function contextIsWarn(level: ContextUsage['level'] | undefined): boolean {
  return level === 'warn' || level === 'full';
}

export function computeContextUsage(used: number, window: number): ContextUsage {
  const resolvedWindow = window > 0 && Number.isFinite(window) ? window : 128_000;
  const resolvedUsed = used > 0 && Number.isFinite(used) ? used : 0;
  const ratio = resolvedWindow > 0 ? Math.min(1, resolvedUsed / resolvedWindow) : 0;
  const percent = Math.min(100, Math.round(ratio * 100));
  const level: ContextUsage['level'] = percent >= 95 ? 'full' : percent >= 80 ? 'warn' : 'ok';
  return {
    used: resolvedUsed,
    window: resolvedWindow,
    percent,
    level,
  };
}

export function clampThinkingLevel(
  levels: readonly ThinkingLevel[] | undefined | null,
  requested: ThinkingLevel | string | null | undefined,
): ThinkingLevel | null {
  if (!levels || levels.length === 0) return null;
  if (!requested) return levels[0] ?? null;
  if (levels.includes(requested as ThinkingLevel)) return requested as ThinkingLevel;
  const wantIdx = THINKING_LEVEL_ORDER.indexOf(requested as ThinkingLevel);
  if (wantIdx === -1) return levels[0] ?? null;
  const up = levels.find((l) => THINKING_LEVEL_ORDER.indexOf(l) >= wantIdx);
  return up || levels[levels.length - 1] || null;
}

export type RecentModelItem = {
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel | null;
};

export const RECENT_MODELS_STORAGE_KEY = 'weft_recent_models';

export function readRecentModels(): RecentModelItem[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RECENT_MODELS_STORAGE_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is RecentModelItem => (
      Boolean(item) &&
      typeof item.providerId === 'string' &&
      typeof item.modelId === 'string' &&
      (item.thinkingLevel === null || (typeof item.thinkingLevel === 'string' && THINKING_LEVEL_ORDER.includes(item.thinkingLevel as ThinkingLevel)))
    ));
  } catch {
    return [];
  }
}

export function saveRecentModel(item: RecentModelItem): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const existing = readRecentModels();
    const key = (x: RecentModelItem) => `${x.providerId}:${x.modelId}:${x.thinkingLevel ?? ''}`;
    const targetKey = key(item);
    const updated = [item, ...existing.filter((x) => key(x) !== targetKey)].slice(0, 10);
    localStorage.setItem(RECENT_MODELS_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Storage quota or security error, gracefully ignored
  }
}

export function getRecentModelEntries(
  recent: readonly RecentModelItem[],
  current: { providerId: string; modelId: string; thinkingLevel: ThinkingLevel | null } | null,
  groups: readonly ComposerModelGroup[],
): Array<{ option: ComposerModelOption; thinkingLevel: ThinkingLevel | null }> {
  const currentKey = current ? `${current.providerId}:${current.modelId}:${current.thinkingLevel ?? ''}` : '';
  const result: Array<{ option: ComposerModelOption; thinkingLevel: ThinkingLevel | null }> = [];
  const seenKeys = new Set<string>();

  for (const item of recent) {
    const group = groups.find((g) => g.providerId === item.providerId);
    const option = group?.models.find((m) => m.modelId === item.modelId);
    if (!option) continue;

    const clampedLevel = clampThinkingLevel(option.thinkingLevels, item.thinkingLevel);
    const itemKey = `${item.providerId}:${item.modelId}:${clampedLevel ?? ''}`;
    if (itemKey === currentKey) continue;
    if (seenKeys.has(itemKey)) continue;

    seenKeys.add(itemKey);
    result.push({ option, thinkingLevel: clampedLevel });
    if (result.length >= 3) break;
  }
  return result;
}
