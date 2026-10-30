import type { Lang } from './types';

/** Same ids / copy as src/v2/phrases provider_name_* (kept here so proto does not import .ts paths). */
const NAMES: Record<string, Record<Lang, string>> = {
  'moonshotai-cn': { zh: 'Kimi（国内）', en: 'Kimi (China)' },
  zai: { zh: '智谱 Z.AI', en: 'Zhipu Z.AI' },
  'qwen-token-plan-cn': { zh: '通义千问 Token Plan（国内）', en: 'Qwen Token Plan (China)' },
  'minimax-cn': { zh: 'MiniMax（国内）', en: 'MiniMax (China)' },
  xiaomi: { zh: '小米 MiMo', en: 'Xiaomi MiMo' },
};

export function mockProviderName(id: string, fallback: string, lang: Lang): string {
  return NAMES[id]?.[lang] || fallback || id;
}
