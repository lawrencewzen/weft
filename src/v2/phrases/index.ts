import { en } from './en.ts';
import { zh } from './zh.ts';

export type Lang = 'zh' | 'en';

export { en, zh };

/**
 * Look up a phrase template. `en` falls back to `zh`; missing in both throws.
 * Exported so tests can prove the fallback without mutating the catalogs.
 */
export function lookupPhraseFrom(
  primary: Record<string, string>,
  fallback: Record<string, string>,
  key: string,
): string {
  if (Object.hasOwn(primary, key)) return primary[key];
  if (primary !== fallback && Object.hasOwn(fallback, key)) return fallback[key];
  throw new Error(`missing phrase: ${key}`);
}

export function lookupPhrase(lang: Lang, key: string): string {
  return lookupPhraseFrom(lang === 'en' ? en : zh, zh, key);
}

export function hasPhrase(lang: Lang, key: string): boolean {
  const primary = lang === 'en' ? en : zh;
  return Object.hasOwn(primary, key) || Object.hasOwn(zh, key);
}

export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  let text = template;
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/** Server-side sentence for `lang`. Placeholders are `{name}`. */
export function phrase(lang: Lang, key: string, params?: Record<string, unknown>): string {
  return interpolate(lookupPhrase(lang, key), params);
}

const PROVIDER_NAME_KEYS: Record<string, string> = {
  'moonshotai-cn': 'provider_name_moonshotai_cn',
  zai: 'provider_name_zai',
  'qwen-token-plan-cn': 'provider_name_qwen_token_plan_cn',
  'minimax-cn': 'provider_name_minimax_cn',
  xiaomi: 'provider_name_xiaomi',
};

/** Localized display name for a built-in provider id. Falls back to `fallback`. */
export function localizedProviderName(id: string, fallback: string, lang: Lang): string {
  const key = PROVIDER_NAME_KEYS[id];
  if (key && hasPhrase(lang, key)) return phrase(lang, key);
  return fallback || id;
}
