import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_PRESETS,
  RECENT_MODELS_STORAGE_KEY,
  brandIconUrl,
  clampThinkingLevel,
  computeContextUsage,
  contextIsWarn,
  contextWindowOptions,
  conversationToResolved,
  findComposerModel,
  getRecentModelEntries,
  isColorBrand,
  groupComposerModels,
  hasAvailableModels,
  isSelectedOption,
  isValidContextWindow,
  modelAttribution,
  parseContextWindowInput,
  readRecentModels,
  resolveComposerSelection,
  sameModel,
  saveRecentModel,
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
    thinkingLevels: extra?.thinkingLevels ?? [],
    defaultThinkingLevel: extra?.defaultThinkingLevel ?? null,
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

describe('clampThinkingLevel', () => {
  it('returns null for models that do not support thinking', () => {
    expect(clampThinkingLevel([], 'high')).toBeNull();
    expect(clampThinkingLevel(undefined, 'high')).toBeNull();
  });

  it('keeps the level if directly supported', () => {
    const flashLevels = ['off', 'low', 'high', 'max'] as const;
    expect(clampThinkingLevel(flashLevels, 'low')).toBe('low');
    expect(clampThinkingLevel(flashLevels, 'high')).toBe('high');
    expect(clampThinkingLevel(flashLevels, 'off')).toBe('off');
  });

  it('clamps upward to nearest supported level, or to highest if none higher', () => {
    const proLevels = ['off', 'high', 'max'] as const;
    // requested 'low' (want=2) -> 'high' (order=4)
    expect(clampThinkingLevel(proLevels, 'low')).toBe('high');
    // requested 'medium' (want=3) -> 'high' (order=4)
    expect(clampThinkingLevel(proLevels, 'medium')).toBe('high');

    const sonnetLevels = ['off', 'minimal', 'low', 'medium', 'high'] as const;
    // requested 'xhigh' -> highest supported which is 'high'
    expect(clampThinkingLevel(sonnetLevels, 'xhigh')).toBe('high');
    expect(clampThinkingLevel(sonnetLevels, 'max')).toBe('high');
  });

  it('falls back to first level when requested is null or unknown', () => {
    const levels = ['low', 'high', 'max'] as const;
    expect(clampThinkingLevel(levels, null)).toBe('low');
    expect(clampThinkingLevel(levels, 'unknown_level')).toBe('low');
  });
});

describe('recent models storage and deduplication', () => {
  const chip = provider('src-chip', 'Chip', [
    model('grok-4.6', { name: 'Grok 4.6', thinkingLevels: ['off', 'low', 'high', 'max'] }),
    model('grok-4', { name: 'Grok 4', thinkingLevels: ['off', 'high', 'max'] }),
    model('qwen', { name: 'Qwen', thinkingLevels: [] }),
  ]);
  const groups = groupComposerModels([chip], null);

  it('filters out current combination, clamps levels, limits to 3, and excludes unknown models', () => {
    const recent = [
      { providerId: 'src-chip', modelId: 'grok-4.6', thinkingLevel: 'high' as const },
      { providerId: 'src-chip', modelId: 'grok-4', thinkingLevel: 'low' as const }, // clamps to high
      { providerId: 'src-chip', modelId: 'qwen', thinkingLevel: 'high' as const }, // clamps to null
      { providerId: 'src-chip', modelId: 'grok-4.6', thinkingLevel: 'off' as const },
      { providerId: 'unknown', modelId: 'm1', thinkingLevel: null },
    ];

    const current = { providerId: 'src-chip', modelId: 'grok-4.6', thinkingLevel: 'high' as const };
    const entries = getRecentModelEntries(recent, current, groups);

    expect(entries.length).toBe(3);
    expect(entries[0].option.modelId).toBe('grok-4');
    expect(entries[0].thinkingLevel).toBe('high'); // clamped from low
    expect(entries[1].option.modelId).toBe('qwen');
    expect(entries[1].thinkingLevel).toBeNull();
    expect(entries[2].option.modelId).toBe('grok-4.6');
    expect(entries[2].thinkingLevel).toBe('off');
  });

  it('reads and writes localStorage gracefully with deduplication and error tolerance', () => {
    const storage: Record<string, string> = {};
    const fakeLocalStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, val: string) => { storage[key] = val; },
    };
    vi.stubGlobal('localStorage', fakeLocalStorage);

    expect(readRecentModels()).toEqual([]);

    saveRecentModel({ providerId: 'src-chip', modelId: 'grok-4', thinkingLevel: 'high' });
    saveRecentModel({ providerId: 'src-chip', modelId: 'grok-4.6', thinkingLevel: 'off' });
    saveRecentModel({ providerId: 'src-chip', modelId: 'grok-4', thinkingLevel: 'high' }); // dup

    const stored = readRecentModels();
    expect(stored.length).toBe(2);
    expect(stored[0]).toEqual({ providerId: 'src-chip', modelId: 'grok-4', thinkingLevel: 'high' });
    expect(stored[1]).toEqual({ providerId: 'src-chip', modelId: 'grok-4.6', thinkingLevel: 'off' });

    // Corrupt data test
    storage[RECENT_MODELS_STORAGE_KEY] = 'not-valid-json';
    expect(readRecentModels()).toEqual([]);

    vi.unstubAllGlobals();
  });

  describe('computeContextUsage', () => {
    it('computes correct percent and ok level for lower usage', () => {
      const res = computeContextUsage(48_200, 64_000);
      expect(res.used).toBe(48_200);
      expect(res.window).toBe(64_000);
      expect(res.percent).toBe(75);
      expect(res.level).toBe('ok');
    });

    it('computes warn level at 80% and above', () => {
      const res = computeContextUsage(52_000, 64_000);
      expect(res.percent).toBe(81);
      expect(res.level).toBe('warn');
    });

    it('computes full level at 95% and above', () => {
      const res = computeContextUsage(62_000, 64_000);
      expect(res.percent).toBe(97);
      expect(res.level).toBe('full');
    });

    it('handles zero used and invalid window fallback', () => {
      const zero = computeContextUsage(0, 64_000);
      expect(zero.percent).toBe(0);
      expect(zero.level).toBe('ok');

      const fallback = computeContextUsage(0, 0);
      expect(fallback.window).toBe(128_000);
      expect(fallback.percent).toBe(0);
    });
  });
});
