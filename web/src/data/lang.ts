export type Lang = 'zh' | 'en';

let override: Lang | null = null;

export function resolveLang(input?: string | null): Lang {
  const raw = String(input || '').trim().toLowerCase();
  if (raw.startsWith('zh')) return 'zh';
  if (raw) return 'en';
  return 'zh';
}

/** Browser language, overridable by settings later via `setPreferredLang`. */
export function getPreferredLang(): Lang {
  if (override) return override;
  if (typeof navigator !== 'undefined' && navigator.language) {
    return resolveLang(navigator.language);
  }
  return 'zh';
}

export function setPreferredLang(lang: Lang | null): void {
  override = lang;
}
