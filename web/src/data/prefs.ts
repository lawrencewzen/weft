/** Same keys as public/app.js and public/i18n.js so / and /next stay in sync. */
export const LS_LANG = 'weft_lang';
export const LS_APPEARANCE = 'weft_appearance';
export const LS_THEME = 'weft_theme';
export const LS_FONT_SIZE = 'weft_font_size';

export type Appearance = 'light' | 'dark' | 'system';
export type ThemeFamily = 'white' | 'claude';
export type FontSize = 'sm' | 'md' | 'lg';

export const THEME_FAMILIES: readonly ThemeFamily[] = ['white', 'claude'];
export const APPEARANCES: readonly Appearance[] = ['light', 'dark', 'system'];
export const FONT_SIZES: readonly FontSize[] = ['sm', 'md', 'lg'];

export const DEFAULT_APPEARANCE: Appearance = 'light';
export const DEFAULT_THEME: ThemeFamily = 'white';
export const DEFAULT_FONT_SIZE: FontSize = 'md';

const PREFS_EVENT = 'weft-prefs';

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readRaw(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    /* ignore quota / private mode */
  }
}

export function asLang(raw: string | null | undefined): 'zh' | 'en' | null {
  if (raw === 'zh' || raw === 'en') return raw;
  return null;
}

export function asAppearance(raw: string | null | undefined): Appearance {
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return DEFAULT_APPEARANCE;
}

export function asThemeFamily(raw: string | null | undefined): ThemeFamily {
  if (raw === 'white' || raw === 'claude') return raw;
  return DEFAULT_THEME;
}

export function asFontSize(raw: string | null | undefined): FontSize {
  if (raw === 'sm' || raw === 'md' || raw === 'lg') return raw;
  return DEFAULT_FONT_SIZE;
}

export function readStoredLang(): 'zh' | 'en' | null {
  return asLang(readRaw(LS_LANG));
}

export function writeStoredLang(lang: 'zh' | 'en'): void {
  writeRaw(LS_LANG, lang);
  syncLegacySettings({ language: lang });
}

export function readAppearance(): Appearance {
  return asAppearance(readRaw(LS_APPEARANCE));
}

export function writeAppearance(mode: Appearance): void {
  writeRaw(LS_APPEARANCE, mode);
  syncLegacySettings({ appearance: mode });
}

export function readThemeFamily(): ThemeFamily {
  return asThemeFamily(readRaw(LS_THEME));
}

export function writeThemeFamily(family: ThemeFamily): void {
  writeRaw(LS_THEME, family);
  syncLegacySettings({ theme: family });
}

export function readFontSize(): FontSize {
  return asFontSize(readRaw(LS_FONT_SIZE));
}

export function writeFontSize(size: FontSize): void {
  writeRaw(LS_FONT_SIZE, size);
}

export function prefersDark(): boolean {
  try {
    return typeof matchMedia === 'function'
      && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function effectiveAppearance(mode: Appearance = readAppearance()): 'light' | 'dark' {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

export function themeAttr(
  family: ThemeFamily = readThemeFamily(),
  mode: Appearance = readAppearance(),
): string {
  return `${family}-${effectiveAppearance(mode)}`;
}

export type DocumentPrefs = {
  lang: 'zh' | 'en';
  appearance: Appearance;
  theme: ThemeFamily;
  fontSize: FontSize;
};

export function applyDocumentPrefs(prefs?: Partial<DocumentPrefs>): void {
  if (typeof document === 'undefined') return;
  const family = prefs?.theme ?? readThemeFamily();
  const appearance = prefs?.appearance ?? readAppearance();
  const fontSize = prefs?.fontSize ?? readFontSize();
  const lang = prefs?.lang;
  const root = document.documentElement;
  root.setAttribute('data-theme', themeAttr(family, appearance));
  root.setAttribute('data-font-size', fontSize);
  if (lang === 'zh' || lang === 'en') {
    root.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }
}

function syncLegacySettings(patch: Record<string, string>): void {
  if (typeof fetch !== 'function') return;
  void fetch('/api/settings', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

export function notifyPrefs(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(PREFS_EVENT));
}

export function subscribePrefs(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(PREFS_EVENT, fn);
  return () => window.removeEventListener(PREFS_EVENT, fn);
}

export function watchSystemAppearance(): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (readAppearance() === 'system') {
      applyDocumentPrefs();
      notifyPrefs();
    }
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export const THEME_SWATCHES: Record<ThemeFamily, [string, string, string]> = {
  white: ['#f5f5f5', '#fcfcfc', '#2b2b2b'],
  claude: ['#f3f1ec', '#faf9f6', 'oklch(0.6 0.1 45)'],
};
