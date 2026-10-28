import { describe, expect, it } from 'vitest';
import type { Vendor } from './providerWizard';
import {
  blankWizard,
  brandChipLabel,
  brandFilters,
  buildCreateBody,
  buildPatchBody,
  buildTestDraftBody,
  canAdvance,
  canFinish,
  COMING_SOON_VENDOR_IDS,
  defaultWay,
  filterVendors,
  formatContextWindow,
  GROK_VENDOR,
  GROK_VENDOR_ID,
  hostOf,
  isComingSoonVendor,
  isMaskedApiKey,
  presentVendors,
  shouldDiscardDraftOnCancel,
  vendorProtocolName,
  waysForVendor,
  withGrokVendor,
  wizardFromProvider,
} from './providerWizard';

const deepseek: Vendor = {
  id: 'deepseek',
  name: 'DeepSeek',
  access: 'api_key',
  needsKey: true,
  baseUrl: 'https://api.deepseek.com/v1',
  brand: 'DeepSeek',
};

const custom: Vendor = {
  id: 'custom',
  name: '自定义 API',
  access: 'custom_endpoint',
  needsKey: true,
  baseUrl: '',
  brand: null,
};

const ollama: Vendor = {
  id: 'ollama',
  name: '本地 Ollama',
  access: 'local',
  needsKey: false,
  baseUrl: 'http://127.0.0.1:11434/v1',
  brand: 'Ollama',
};

describe('provider wizard', () => {
  it('adds Grok Build in front of server vendors', () => {
    const list = withGrokVendor([deepseek, custom]);
    expect(list[0]).toEqual(GROK_VENDOR);
    expect(list.map((item) => item.id)).toEqual(['grok', 'deepseek', 'custom']);
    expect(withGrokVendor([GROK_VENDOR, deepseek])[0].id).toBe('grok');
  });

  it('offers account login only for Grok, and ACP as disabled', () => {
    expect(waysForVendor(GROK_VENDOR)).toEqual([
      { id: 'account', enabled: true, product: 'Grok Build' },
      { id: 'agent', enabled: false, product: 'Grok' },
    ]);
    expect(defaultWay(GROK_VENDOR)).toBe('account');
    expect(waysForVendor(deepseek).map((item) => item.id)).toEqual([
      'account', 'api_key', 'agent', 'custom_endpoint',
    ]);
    expect(waysForVendor(deepseek).find((item) => item.id === 'account')).toEqual({
      id: 'account', enabled: false, product: null,
    });
    expect(waysForVendor(deepseek).find((item) => item.id === 'agent')?.enabled).toBe(false);
    expect(waysForVendor({ ...deepseek, id: 'anthropic', name: 'Anthropic' }).find((item) => item.id === 'account')).toEqual({
      id: 'account', enabled: false, product: 'Claude Code',
    });
    expect(waysForVendor(custom).find((item) => item.id === 'custom_endpoint')).toEqual({
      id: 'custom_endpoint', enabled: true,
    });
    expect(defaultWay(custom)).toBe('custom_endpoint');
    expect(defaultWay(ollama)).toBe('api_key');
  });

  it('presents 14 design vendors plus Grok Build, with coming-soon extras', () => {
    const list = presentVendors([deepseek, custom]);
    expect(list.find((item) => item.id === GROK_VENDOR_ID)?.name).toBe('Grok Build');
    expect(list.map((item) => item.id)).toEqual([
      'anthropic', 'openai', 'gemini', 'xai', 'grok', 'qwen',
      'github-copilot', 'kiro', 'deepseek', 'moonshot', 'zhipu',
      'openrouter', 'ollama', 'lmstudio', 'custom',
    ]);
    expect(list.find((item) => item.id === 'gemini')?.name).toBe('Google');
    expect(list.find((item) => item.id === 'qwen')?.name).toBe('阿里云 · 通义');
    expect(list.find((item) => item.id === 'custom')?.name).toBe('自定义地址');
    expect(list.find((item) => item.id === 'deepseek')?.baseUrl).toBe(deepseek.baseUrl);
    expect([...COMING_SOON_VENDOR_IDS]).toEqual(['github-copilot', 'kiro', 'lmstudio']);
    expect(isComingSoonVendor('kiro')).toBe(true);
    expect(isComingSoonVendor(deepseek)).toBe(false);
    expect(vendorProtocolName({ ...deepseek, id: 'anthropic' })).toBe('Anthropic 协议');
    expect(brandChipLabel('OpenAI')).toBe('GPT');
  });

  it('blocks next until the current step is satisfied', () => {
    let state = blankWizard('add');
    expect(canAdvance(state, null)).toBe(false);
    state = { ...state, vendorId: 'deepseek' };
    expect(canAdvance(state, deepseek)).toBe(true);

    state = { ...state, step: 2, way: 'api_key', probeOk: false };
    expect(canAdvance(state, deepseek)).toBe(false);
    state = { ...state, probeOk: true };
    expect(canAdvance(state, deepseek)).toBe(true);

    state = { ...state, way: 'agent', probeOk: true };
    expect(canAdvance(state, deepseek)).toBe(false);

    state = { ...state, way: 'account', probeOk: false };
    expect(canAdvance(state, GROK_VENDOR, false)).toBe(false);
    expect(canAdvance(state, GROK_VENDOR, true)).toBe(true);

    state = { ...blankWizard('edit'), step: 2, way: 'api_key', createdId: 'p1', probeOk: false };
    expect(canAdvance(state, deepseek)).toBe(true);
    state = { ...state, apiKeyEdited: true };
    expect(canAdvance(state, deepseek)).toBe(false);
    state = { ...state, probeOk: true };
    expect(canAdvance(state, deepseek)).toBe(true);

    state = { ...state, step: 3, selectedModelIds: [] };
    expect(canAdvance(state, deepseek)).toBe(false);
    expect(canFinish(state)).toBe(false);
    state = { ...state, selectedModelIds: ['a', 'b'] };
    expect(canFinish(state)).toBe(true);
  });

  it('omits apiKey from patch when the key was not edited', () => {
    const state = {
      ...blankWizard('edit'),
      step: 3 as const,
      createdId: 'p1',
      name: 'Work',
      originalName: 'Work',
      apiKey: '••••3f9c',
      originalKeyMasked: '••••3f9c',
      apiKeyEdited: false,
      selectedModelIds: ['deepseek-chat'],
    };
    expect(buildPatchBody(state)).toEqual({ models: ['deepseek-chat'] });
  });

  it('omits apiKey when the field still looks masked', () => {
    const state = {
      ...blankWizard('edit'),
      name: 'Work',
      originalName: 'Home',
      apiKey: '••••3f9c',
      originalKeyMasked: '••••3f9c',
      apiKeyEdited: true,
      selectedModelIds: ['m1'],
    };
    expect(buildPatchBody(state)).toEqual({ name: 'Work', models: ['m1'] });
    expect(isMaskedApiKey('••••3f9c', '••••3f9c')).toBe(true);
    expect(isMaskedApiKey('sk-real-secret', '••••3f9c')).toBe(false);
  });

  it('includes a new key only after it is typed', () => {
    const state = {
      ...blankWizard('edit'),
      name: 'Work',
      originalName: 'Work',
      apiKey: 'sk-new-secret',
      originalKeyMasked: '••••3f9c',
      apiKeyEdited: true,
      selectedModelIds: ['m1'],
    };
    expect(buildPatchBody(state)).toEqual({
      apiKey: 'sk-new-secret',
      models: ['m1'],
    });
  });

  it('builds create and draft-test bodies without a masked key', () => {
    const state = {
      ...blankWizard('add'),
      vendorId: 'custom',
      way: 'custom_endpoint' as const,
      name: 'Lab',
      apiKey: 'sk-lab-key',
      apiKeyEdited: true,
      baseUrl: 'http://127.0.0.1:9/v1',
      selectedModelIds: ['alpha', 'beta'],
    };
    expect(buildCreateBody(state, custom)).toEqual({
      vendor: 'custom',
      name: 'Lab',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-lab-key',
      models: ['alpha', 'beta'],
    });
    expect(buildTestDraftBody(state, custom)).toEqual({
      vendor: 'custom',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-lab-key',
    });
    const masked = { ...state, apiKey: '••••abcd', originalKeyMasked: '••••abcd' };
    expect(buildTestDraftBody(masked, custom).apiKey).toBeUndefined();
  });

  it('filters vendors and formats helpers', () => {
    expect(filterVendors([deepseek, GROK_VENDOR], 'grok').map((item) => item.id)).toEqual(['grok']);
    expect(filterVendors([deepseek], 'claude')).toEqual([]);
    expect(filterVendors(presentVendors([]), 'claude').map((item) => item.id)).toContain('anthropic');
    expect(hostOf('https://api.deepseek.com/v1')).toBe('api.deepseek.com');
    expect(formatContextWindow(200_000)).toBe('200K');
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(brandFilters([
      { id: 'a', displayName: 'A', brand: 'Claude', contextWindow: 1, contextWindowCustom: false, images: false },
      { id: 'b', displayName: 'B', brand: 'Claude', contextWindow: 1, contextWindowCustom: false, images: false },
      { id: 'c', displayName: 'C', brand: 'Grok', contextWindow: 1, contextWindowCustom: false, images: false },
      { id: 'd', displayName: 'D', brand: null, contextWindow: 1, contextWindowCustom: false, images: false },
      { id: 'e', displayName: 'E', brand: 'OpenAI', contextWindow: 1, contextWindowCustom: false, images: false },
    ]).map((item) => item.id)).toEqual(['Claude', 'OpenAI', 'Grok']);
    expect(brandFilters([
      { id: 'e', displayName: 'E', brand: 'OpenAI', contextWindow: 1, contextWindowCustom: false, images: false },
    ])[0].name).toBe('GPT');
  });

  it('starts an edit wizard on step 2 with the masked key', () => {
    const state = wizardFromProvider({
      id: 'p1',
      vendor: 'DeepSeek',
      name: 'Work',
      access: 'api_key',
      runtime: 'model',
      baseUrl: 'https://api.deepseek.com/v1',
      keyMasked: '••••3f9c',
      hasKey: true,
      status: 'ok',
      statusText: '',
      lastTestedAt: 1,
      models: [{ id: 'deepseek-chat', displayName: 'DeepSeek Chat', brand: 'DeepSeek', contextWindow: 128000, contextWindowCustom: false, images: false }],
      isDefault: false,
    });
    expect(state.mode).toBe('edit');
    expect(state.step).toBe(2);
    expect(state.apiKey).toBe('••••3f9c');
    expect(state.apiKeyEdited).toBe(false);
    expect(canAdvance(state, deepseek)).toBe(true);
    expect(buildPatchBody(state).apiKey).toBeUndefined();
  });

  it('discards add-mode drafts on cancel, except Grok account login', () => {
    expect(shouldDiscardDraftOnCancel({ mode: 'add', createdId: 'prov_1' })).toBe(true);
    expect(shouldDiscardDraftOnCancel({ mode: 'add', createdId: GROK_VENDOR_ID })).toBe(false);
    expect(shouldDiscardDraftOnCancel({ mode: 'add', createdId: null })).toBe(false);
    expect(shouldDiscardDraftOnCancel({ mode: 'edit', createdId: 'prov_1' })).toBe(false);
  });
});
