import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_PRESETS,
  brandIconUrl,
  contextIsWarn,
  contextWindowOptions,
  conversationToResolved,
  findComposerModel,
  isColorBrand,
  groupComposerModels,
  hasAvailableModels,
  isSelectedOption,
  isValidContextWindow,
  modelAttribution,
  parseContextWindowInput,
  resolveComposerSelection,
  sameModel,
  type Provider,
} from './composerModel';

function model(id: string, extra?: Partial<Provider['models'][number]>): Provider['models'][number] {
  return {
    id,
    name: extra?.name ?? id,
    brand: extra?.brand ?? null,
    enabled: extra?.enabled ?? true,
    contextWindow: extra?.contextWindow ?? 128000,
    maxTokens: extra?.maxTokens ?? 16384,
    images: extra?.images ?? false,
    reasoning: extra?.reasoning ?? false,
    overridden: extra?.overridden ?? {},
  };
}

function provider(id: string, name: string, models: Provider['models'], extra?: Partial<Provider>): Provider {
  return {
    id,
    kind: extra?.kind ?? 'builtin',
    name,
    brand: extra?.brand ?? 'openai',
    auth: extra?.auth ?? { type: 'api_key', keyTail: 'ab12' },
    status: extra?.status ?? { state: 'ok' },
    models,
  };
}

describe('composer model grouping', () => {
  const chip = provider('src-chip', 'Chip', [
    model('grok-4.6', { name: 'Grok 4.6', brand: 'grok', contextWindow: 200000 }),
    model('grok-4', { name: 'Grok 4', brand: 'grok', contextWindow: 128000 }),
  ], { brand: 'xai' });
  const router = provider('src-or', 'OpenRouter', [
    model('openai/gpt-4o', { name: 'GPT 4o', brand: 'openai', contextWindow: 128000 }),
    model('anthropic/claude-sonnet-4', { name: 'Claude Sonnet 4', brand: 'claude', contextWindow: 200000 }),
  ], { brand: 'openrouter' });
  const empty = provider('src-empty', 'Empty', []);
  const defaultModel = { providerId: 'src-chip', modelId: 'grok-4.6' };

  it('groups models by provider, skips empty sources, and marks the default', () => {
    const groups = groupComposerModels([chip, empty, router], defaultModel);
    expect(groups.map((group) => group.providerId)).toEqual(['src-chip', 'src-or']);
    expect(groups[0].providerName).toBe('Chip');
    expect(groups[0].mixedBrands).toBe(false);
    expect(groups[0].models.map((item) => item.modelId)).toEqual(['grok-4.6', 'grok-4']);
    expect(groups[0].models[0].isDefault).toBe(true);
    expect(groups[0].models[0].displayName).toBe('Grok 4.6');
    expect(groups[0].models[0].images).toBe(false);
    expect(groups[0].models[1].isDefault).toBe(false);
    expect(groups[1].mixedBrands).toBe(true);
    expect(groups[1].providerBrand).toBe('openrouter');
    expect(hasAvailableModels([empty])).toBe(false);
    expect(hasAvailableModels([chip, empty])).toBe(true);
  });

  it('copies the catalog images flag onto composer options', () => {
    const vision = provider('src-v', 'Vision', [model('gpt-4o', { images: true })]);
    expect(groupComposerModels([vision], null)[0].models[0].images).toBe(true);
  });

  it('marks the selected option with provider + model id, not display name', () => {
    const groups = groupComposerModels([chip, router], defaultModel);
    const selected = findComposerModel([chip, router], { providerId: 'src-or', modelId: 'openai/gpt-4o' }, defaultModel);
    expect(selected?.displayName).toBe('GPT 4o');
    expect(groups[0].models.some((item) => isSelectedOption(item, selected))).toBe(false);
    expect(groups[1].models.filter((item) => isSelectedOption(item, selected)).map((item) => item.modelId))
      .toEqual(['openai/gpt-4o']);
  });
});

describe('composer selection', () => {
  const chip = provider('src-chip', 'Chip', [
    model('grok-4.6', { name: 'Grok 4.6', brand: 'grok' }),
    model('grok-4', { name: 'Grok 4', brand: 'grok' }),
  ]);
  const defaultModel = { providerId: 'src-chip', modelId: 'grok-4.6' };

  it('uses the conversation model when present, otherwise the default', () => {
    const pinned = resolveComposerSelection({
      providers: [chip],
      conversationModel: { sourceId: 'src-chip', modelId: 'grok-4', label: 'grok-4' },
      defaultModel,
      draft: null,
      isDraft: false,
    });
    expect(pinned).toMatchObject({ modelId: 'grok-4', displayName: 'Grok 4', isDefault: false });

    const fallback = resolveComposerSelection({
      providers: [chip],
      conversationModel: null,
      defaultModel,
      draft: null,
      isDraft: false,
    });
    expect(fallback).toMatchObject({ modelId: 'grok-4.6', displayName: 'Grok 4.6', isDefault: true });
  });

  it('lets a draft pick override the default before the conversation exists', () => {
    const picked = resolveComposerSelection({
      providers: [chip],
      conversationModel: null,
      defaultModel,
      draft: { providerId: 'src-chip', modelId: 'grok-4' },
      isDraft: true,
    });
    expect(picked).toMatchObject({ modelId: 'grok-4', displayName: 'Grok 4' });

    const untouched = resolveComposerSelection({
      providers: [chip],
      conversationModel: null,
      defaultModel,
      draft: null,
      isDraft: true,
    });
    expect(untouched).toMatchObject({ modelId: 'grok-4.6', isDefault: true });
  });
});

describe('context window range', () => {
  it('accepts integers in the server range and rejects everything else', () => {
    expect(isValidContextWindow(CONTEXT_WINDOW_MIN)).toBe(true);
    expect(isValidContextWindow(CONTEXT_WINDOW_MAX)).toBe(true);
    expect(isValidContextWindow(256000)).toBe(true);
    expect(isValidContextWindow(12)).toBe(false);
    expect(isValidContextWindow(CONTEXT_WINDOW_MIN - 1)).toBe(false);
    expect(isValidContextWindow(CONTEXT_WINDOW_MAX + 1)).toBe(false);
    expect(isValidContextWindow(128000.5)).toBe(false);
    expect(isValidContextWindow(Number.NaN)).toBe(false);

    expect(parseContextWindowInput('256000')).toBe(256000);
    expect(parseContextWindowInput(' 1_000_000 ')).toBe(1_000_000);
    expect(parseContextWindowInput('12')).toBeNull();
    expect(parseContextWindowInput('10000001')).toBeNull();
    expect(parseContextWindowInput('128000.2')).toBeNull();
    expect(parseContextWindowInput('abc')).toBeNull();
    expect(parseContextWindowInput('')).toBeNull();
  });

  it('lists presets and inserts a custom current value', () => {
    const preset = contextWindowOptions(200000);
    expect(preset.map((item) => item.tokens)).toEqual(CONTEXT_WINDOW_PRESETS);
    expect(preset.find((item) => item.tokens === 200000)?.selected).toBe(true);
    expect(preset.some((item) => item.custom)).toBe(false);

    const custom = contextWindowOptions(180000);
    expect(custom.some((item) => item.custom && item.tokens === 180000 && item.selected)).toBe(true);
    expect(contextIsWarn('ok')).toBe(false);
    expect(contextIsWarn('warn')).toBe(true);
    expect(contextIsWarn('full')).toBe(true);
  });
});

describe('brand helpers', () => {
  it('builds a same-origin icon url and falls back attribution to the raw id', () => {
    expect(brandIconUrl('grok')).toBe('/vendor/brand-icons/grok.svg');
    expect(brandIconUrl('Claude')).toBe('/vendor/brand-icons/anthropic.svg');
    expect(brandIconUrl(null)).toBeNull();
    expect(brandIconUrl('../etc/passwd')).toBeNull();
    expect(isColorBrand('grok')).toBe(false);
    expect(isColorBrand('openai')).toBe(false);
    expect(isColorBrand('claude-color')).toBe(true);
    expect(isColorBrand('lobehub')).toBe(true);
    expect(conversationToResolved({ sourceId: 'p', modelId: 'm', label: 'm' })).toEqual({
      providerId: 'p',
      modelId: 'm',
    });
    expect(sameModel({ providerId: 'a', modelId: 'b' }, { providerId: 'a', modelId: 'b' })).toBe(true);

    const chip = provider('src-chip', 'Chip', [
      model('grok-4', { name: 'Grok 4', brand: 'grok' }),
    ]);
    expect(modelAttribution('grok-4', [chip], { sourceId: 'src-chip', modelId: 'grok-4', label: 'grok-4' }))
      .toEqual({ brand: 'grok', displayName: 'Grok 4' });
    expect(modelAttribution('unknown', [chip], null)).toEqual({ brand: null, displayName: 'unknown' });
  });
});
