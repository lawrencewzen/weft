/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPreferredLang, resolveLang, setPreferredLang } from './lang';
import {
  applyDocumentPrefs,
  asAppearance,
  asChatWidth,
  asFontSize,
  asLang,
  asThemeFamily,
  DEFAULT_APPEARANCE,
  DEFAULT_CHAT_WIDTH,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
  effectiveAppearance,
  LS_APPEARANCE,
  LS_CHAT_WIDTH,
  LS_FONT_SIZE,
  LS_LANG,
  LS_THEME,
  readAppearance,
  readChatWidth,
  readFontSize,
  readStoredLang,
  readThemeFamily,
  themeAttr,
  toggleAppearance,
  writeAppearance,
  writeChatWidth,
  writeFontSize,
  writeStoredLang,
  writeThemeFamily,
} from './prefs';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}

function installStorage(mem: MemoryStorage): void {
  // @ts-expect-error test stub
  globalThis.localStorage = mem;
}

describe('prefs keys and values match the old UI', () => {
  afterEach(() => {
    setPreferredLang(null);
    vi.unstubAllGlobals();
    // @ts-expect-error test stub
    globalThis.localStorage = undefined;
  });

  it('uses stable localStorage key names', () => {
    expect(LS_LANG).toBe('weft_lang');
    expect(LS_APPEARANCE).toBe('weft_appearance');
    expect(LS_THEME).toBe('weft_theme');
    expect(LS_FONT_SIZE).toBe('weft_font_size');
    expect(LS_CHAT_WIDTH).toBe('weft_chat_width');
  });

  it('defaults appearance to light, theme to white, font to md, chat width to wider', () => {
    installStorage(new MemoryStorage());
    expect(DEFAULT_APPEARANCE).toBe('light');
    expect(DEFAULT_THEME).toBe('white');
    expect(DEFAULT_FONT_SIZE).toBe('md');
    expect(DEFAULT_CHAT_WIDTH).toBe('wider');
    expect(readAppearance()).toBe('light');
    expect(readThemeFamily()).toBe('white');
    expect(readFontSize()).toBe('md');
    expect(readChatWidth()).toBe('wider');
    expect(readStoredLang()).toBeNull();
  });

  it('round-trips zh/en, light/dark/system, white/claude, sm/md/lg, standard/wide/wider/full', () => {
    const mem = new MemoryStorage();
    installStorage(mem);
    writeStoredLang('en');
    expect(mem.getItem(LS_LANG)).toBe('en');
    expect(readStoredLang()).toBe('en');
    writeStoredLang('zh');
    expect(readStoredLang()).toBe('zh');

    writeAppearance('dark');
    expect(mem.getItem(LS_APPEARANCE)).toBe('dark');
    expect(readAppearance()).toBe('dark');
    writeAppearance('system');
    expect(readAppearance()).toBe('system');
    writeAppearance('light');
    expect(readAppearance()).toBe('light');

    writeThemeFamily('claude');
    expect(mem.getItem(LS_THEME)).toBe('claude');
    expect(readThemeFamily()).toBe('claude');
    writeThemeFamily('white');
    expect(readThemeFamily()).toBe('white');

    writeFontSize('sm');
    expect(mem.getItem(LS_FONT_SIZE)).toBe('sm');
    expect(readFontSize()).toBe('sm');
    writeFontSize('lg');
    expect(readFontSize()).toBe('lg');
    writeFontSize('md');
    expect(readFontSize()).toBe('md');

    writeChatWidth('standard');
    expect(mem.getItem(LS_CHAT_WIDTH)).toBe('standard');
    expect(readChatWidth()).toBe('standard');
    writeChatWidth('wide');
    expect(mem.getItem(LS_CHAT_WIDTH)).toBe('wide');
    expect(readChatWidth()).toBe('wide');
    writeChatWidth('wider');
    expect(mem.getItem(LS_CHAT_WIDTH)).toBe('wider');
    expect(readChatWidth()).toBe('wider');
    writeChatWidth('full');
    expect(mem.getItem(LS_CHAT_WIDTH)).toBe('full');
    expect(readChatWidth()).toBe('full');
  });

  it('falls unknown theme families back to white like the old UI', () => {
    const mem = new MemoryStorage();
    installStorage(mem);
    mem.setItem(LS_THEME, 'codex');
    expect(readThemeFamily()).toBe('white');
    mem.setItem(LS_THEME, 'grok');
    expect(readThemeFamily()).toBe('white');
    mem.setItem(LS_THEME, 'cursor');
    expect(readThemeFamily()).toBe('white');
    expect(asThemeFamily('nope')).toBe('white');
    expect(asAppearance('dim')).toBe('light');
    expect(asFontSize('xl')).toBe('md');
    expect(asChatWidth('gigantic')).toBe('wider');
    expect(asChatWidth(null)).toBe('wider');
    expect(asChatWidth(undefined)).toBe('wider');
    mem.setItem(LS_CHAT_WIDTH, 'huge');
    expect(readChatWidth()).toBe('wider');
    expect(asLang('fr')).toBeNull();
    expect(asLang('zh')).toBe('zh');
  });

  it('builds the same data-theme attr the old UI writes', () => {
    expect(themeAttr('white', 'light')).toBe('white-light');
    expect(themeAttr('white', 'dark')).toBe('white-dark');
    expect(themeAttr('claude', 'light')).toBe('claude-light');
    expect(themeAttr('claude', 'dark')).toBe('claude-dark');
    expect(effectiveAppearance('light')).toBe('light');
    expect(effectiveAppearance('dark')).toBe('dark');
  });

  it('toggles the stored appearance between light and dark', () => {
    const mem = new MemoryStorage();
    installStorage(mem);
    writeAppearance('light');
    expect(toggleAppearance()).toBe('dark');
    expect(readAppearance()).toBe('dark');
    expect(toggleAppearance()).toBe('light');
    expect(readAppearance()).toBe('light');
    writeAppearance('system');
    expect(effectiveAppearance()).toBe('light');
    expect(toggleAppearance()).toBe('dark');
    expect(readAppearance()).toBe('dark');
  });

  it('applies document preferences to document.documentElement attributes', () => {
    installStorage(new MemoryStorage());
    applyDocumentPrefs();
    expect(document.documentElement.getAttribute('data-chat-width')).toBe('wider');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('md');
    expect(document.documentElement.getAttribute('data-theme')).toBe('white-light');

    writeChatWidth('standard');
    applyDocumentPrefs();
    expect(document.documentElement.getAttribute('data-chat-width')).toBe('standard');

    writeChatWidth('wide');
    applyDocumentPrefs();
    expect(document.documentElement.getAttribute('data-chat-width')).toBe('wide');

    applyDocumentPrefs({ chatWidth: 'full' });
    expect(document.documentElement.getAttribute('data-chat-width')).toBe('full');
  });
});

describe('preferred language', () => {
  afterEach(() => {
    setPreferredLang(null);
    vi.unstubAllGlobals();
    // @ts-expect-error test stub
    globalThis.localStorage = undefined;
  });

  it('uses weft_lang when present, otherwise the browser', () => {
    const mem = new MemoryStorage();
    installStorage(mem);
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(getPreferredLang()).toBe('en');
    mem.setItem(LS_LANG, 'zh');
    expect(getPreferredLang()).toBe('zh');
    mem.setItem(LS_LANG, 'en');
    expect(getPreferredLang()).toBe('en');
  });

  it('treats zh-* as zh and anything else as en', () => {
    expect(resolveLang('zh-CN')).toBe('zh');
    expect(resolveLang('zh')).toBe('zh');
    expect(resolveLang('en-US')).toBe('en');
    expect(resolveLang('fr')).toBe('en');
    expect(resolveLang('')).toBe('zh');
  });

  it('writes weft_lang when setPreferredLang is called', () => {
    const mem = new MemoryStorage();
    installStorage(mem);
    setPreferredLang('en');
    expect(mem.getItem(LS_LANG)).toBe('en');
    expect(getPreferredLang()).toBe('en');
    setPreferredLang('zh');
    expect(mem.getItem(LS_LANG)).toBe('zh');
  });

  it('falls back to zh when neither weft_lang nor navigator is set', () => {
    installStorage(new MemoryStorage());
    vi.stubGlobal('navigator', {});
    expect(getPreferredLang()).toBe('zh');
  });
});
