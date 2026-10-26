import { applyDocumentPrefs, notifyPrefs, readStoredLang, writeStoredLang } from './prefs';

export type Lang = 'zh' | 'en';

let override: Lang | null = null;

export function resolveLang(input?: string | null): Lang {
  const raw = String(input || '').trim().toLowerCase();
  if (raw.startsWith('zh')) return 'zh';
  if (raw) return 'en';
  return 'zh';
}

function browserLang(): Lang {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return resolveLang(navigator.language);
  }
  return 'zh';
}

/** weft_lang when set (same key as the old UI); otherwise follow the browser. */
export function getPreferredLang(): Lang {
  if (override) return override;
  return readStoredLang() ?? browserLang();
}

export function setPreferredLang(lang: Lang | null): void {
  override = lang;
  if (lang) {
    writeStoredLang(lang);
    applyDocumentPrefs({ lang });
    notifyPrefs();
  }
}
