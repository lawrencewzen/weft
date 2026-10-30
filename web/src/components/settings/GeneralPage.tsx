import { useEffect, useState } from 'react';
import { getPreferredLang, setPreferredLang, type Lang } from '../../data/lang';
import {
  APPEARANCES,
  FONT_SIZES,
  THEME_FAMILIES,
  THEME_SWATCHES,
  applyDocumentPrefs,
  notifyPrefs,
  readAppearance,
  readFontSize,
  readThemeFamily,
  subscribePrefs,
  writeAppearance,
  writeFontSize,
  writeThemeFamily,
  type Appearance,
  type FontSize,
  type ThemeFamily,
} from '../../data/prefs';
import { LANGUAGE_NAMES, t, type I18nKey } from '../../i18n';

const APPEARANCE_KEYS: Record<Appearance, I18nKey> = {
  light: 'mode_light',
  dark: 'mode_dark',
  system: 'mode_system',
};

const THEME_KEYS: Record<ThemeFamily, I18nKey> = {
  white: 'theme_white',
  claude: 'theme_claude',
};

const FONT_KEYS: Record<FontSize, I18nKey> = {
  sm: 'size_sm',
  md: 'size_md',
  lg: 'size_lg',
};

type Props = {
  lang: Lang;
};

export function GeneralPage({ lang }: Props) {
  const [appearance, setAppearance] = useState(readAppearance);
  const [theme, setTheme] = useState(readThemeFamily);
  const [fontSize, setFontSize] = useState(readFontSize);

  useEffect(() => subscribePrefs(() => {
    setAppearance(readAppearance());
    setTheme(readThemeFamily());
    setFontSize(readFontSize());
  }), []);

  function persist(next: {
    lang?: Lang;
    appearance?: Appearance;
    theme?: ThemeFamily;
    fontSize?: FontSize;
  }): void {
    if (next.lang) setPreferredLang(next.lang);
    if (next.appearance) {
      writeAppearance(next.appearance);
      setAppearance(next.appearance);
    }
    if (next.theme) {
      writeThemeFamily(next.theme);
      setTheme(next.theme);
    }
    if (next.fontSize) {
      writeFontSize(next.fontSize);
      setFontSize(next.fontSize);
    }
    applyDocumentPrefs({
      lang: next.lang ?? getPreferredLang(),
      appearance: next.appearance ?? readAppearance(),
      theme: next.theme ?? readThemeFamily(),
      fontSize: next.fontSize ?? readFontSize(),
    });
    notifyPrefs();
  }

  return (
    <div className="next-settings-content" data-testid="next-settings-general">
      <div className="next-settings-head">
        <h2>{t(lang, 'settings_nav_general')}</h2>
      </div>

      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'lang_label')}</b>
          <span>{t(lang, 'lang_desc')}</span>
        </div>
        <div className="ns-seg" data-testid="next-pref-lang">
          <button
            type="button"
            className={lang === 'zh' ? 'is-on' : ''}
            data-lang="zh"
            lang="zh-CN"
            onClick={() => persist({ lang: 'zh' })}
          >
            {LANGUAGE_NAMES.zh}
          </button>
          <button
            type="button"
            className={lang === 'en' ? 'is-on' : ''}
            data-lang="en"
            lang="en"
            onClick={() => persist({ lang: 'en' })}
          >
            {LANGUAGE_NAMES.en}
          </button>
        </div>
      </div>

      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'appearance_label')}</b>
          <span>{t(lang, 'appearance_desc')}</span>
        </div>
        <div className="ns-seg" data-testid="next-pref-appearance">
          {APPEARANCES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={appearance === mode ? 'is-on' : ''}
              data-mode={mode}
              onClick={() => persist({ appearance: mode })}
            >
              {t(lang, APPEARANCE_KEYS[mode])}
            </button>
          ))}
        </div>
      </div>

      <div className="ns-pref-row is-block">
        <div className="ns-pref-copy">
          <b>{t(lang, 'theme_label')}</b>
          <span>{t(lang, 'theme_desc')}</span>
        </div>
        <div className="ns-theme-grid" data-testid="next-pref-theme">
          {THEME_FAMILIES.map((family) => {
            const [side, panel, accent] = THEME_SWATCHES[family];
            return (
              <button
                key={family}
                type="button"
                className={`ns-theme-card${theme === family ? ' is-on' : ''}`}
                data-family={family}
                onClick={() => persist({ theme: family })}
              >
                <span className="ns-theme-swatch" aria-hidden="true">
                  <i style={{ background: side }} />
                  <i style={{ background: panel, flex: 3 }} />
                  <i style={{ background: accent, flex: 0.3 }} />
                </span>
                {t(lang, THEME_KEYS[family])}
              </button>
            );
          })}
        </div>
      </div>

      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'font_size_label')}</b>
          <span>{t(lang, 'font_size_desc')}</span>
        </div>
        <div className="ns-seg" data-testid="next-pref-font">
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={fontSize === size ? 'is-on' : ''}
              data-size={size}
              onClick={() => persist({ fontSize: size })}
            >
              {t(lang, FONT_KEYS[size])}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
