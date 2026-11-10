import { useEffect, useState } from 'react';
import { getSettings, putCompactionTrigger } from '../../data/api';
import { getPreferredLang, setPreferredLang, type Lang } from '../../data/lang';
import {
  APPEARANCES,
  CHAT_WIDTHS,
  FONT_SIZES,
  THEME_FAMILIES,
  THEME_SWATCHES,
  applyDocumentPrefs,
  notifyPrefs,
  readAppearance,
  readChatWidth,
  readFontSize,
  readThemeFamily,
  subscribePrefs,
  writeAppearance,
  writeChatWidth,
  writeFontSize,
  writeThemeFamily,
  type Appearance,
  type ChatWidth,
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

const CHAT_WIDTH_KEYS: Record<ChatWidth, I18nKey> = {
  standard: 'width_standard',
  wide: 'width_wide',
  wider: 'width_wider',
  full: 'width_full',
};

export type CompactionEffective = { providerId: string; modelId: string; name: string; percent: number };

const EFFECTIVE_SHOWN = 3;

export function effectiveHint(lang: Lang, list: CompactionEffective[]): { text: string; title: string } | null {
  if (!list.length) return null;
  const item = (m: CompactionEffective) => `${m.name} ${m.percent}%`;
  const sep = lang === 'en' ? ', ' : '、';
  const shown = list.slice(0, EFFECTIVE_SHOWN).map(item).join(sep);
  const rest = list.length - EFFECTIVE_SHOWN;
  const listText = rest > 0 ? `${shown} ${t(lang, 'compact_effective_more', { n: rest })}` : shown;
  return {
    text: t(lang, 'compact_effective_hint', { list: listText }),
    title: list.map(item).join('\n'),
  };
}

type Props = {
  lang: Lang;
};

const TRIGGER_MIN = 60;
const TRIGGER_MAX = 90;

export function parseTriggerPercent(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= TRIGGER_MIN && n <= TRIGGER_MAX ? n : null;
}

export function GeneralPage({ lang }: Props) {
  const [appearance, setAppearance] = useState(readAppearance);
  const [theme, setTheme] = useState(readThemeFamily);
  const [fontSize, setFontSize] = useState(readFontSize);
  const [chatWidth, setChatWidth] = useState(readChatWidth);
  const [trigger, setTrigger] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [effective, setEffective] = useState<CompactionEffective[]>([]);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSettings()
      .then((view) => {
        if (!alive) return;
        setSaved(view.compaction.triggerPercent);
        setEffective(view.compaction.effective ?? []);
        setTrigger(String(view.compaction.triggerPercent));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  async function commitTrigger() {
    const n = parseTriggerPercent(trigger);
    if (n === null) {
      setTriggerError(t(lang, 'compact_trigger_range'));
      return;
    }
    setTriggerError(null);
    if (n === saved) return;
    try {
      const view = await putCompactionTrigger(n);
      setSaved(view.compaction.triggerPercent);
      setEffective(view.compaction.effective ?? []);
      setTrigger(String(view.compaction.triggerPercent));
    } catch {
      setTriggerError(t(lang, 'compact_trigger_save_failed'));
    }
  }

  useEffect(() => subscribePrefs(() => {
    setAppearance(readAppearance());
    setTheme(readThemeFamily());
    setFontSize(readFontSize());
    setChatWidth(readChatWidth());
  }), []);

  function persist(next: {
    lang?: Lang;
    appearance?: Appearance;
    theme?: ThemeFamily;
    fontSize?: FontSize;
    chatWidth?: ChatWidth;
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
    if (next.chatWidth) {
      writeChatWidth(next.chatWidth);
      setChatWidth(next.chatWidth);
    }
    applyDocumentPrefs({
      lang: next.lang ?? getPreferredLang(),
      appearance: next.appearance ?? readAppearance(),
      theme: next.theme ?? readThemeFamily(),
      fontSize: next.fontSize ?? readFontSize(),
      chatWidth: next.chatWidth ?? readChatWidth(),
    });
    notifyPrefs();
  }

  const hint = effectiveHint(lang, effective);

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

      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'chat_width_label')}</b>
          <span>{t(lang, 'chat_width_desc')}</span>
        </div>
        <div className="ns-seg" data-testid="next-pref-chat-width">
          {CHAT_WIDTHS.map((width) => (
            <button
              key={width}
              type="button"
              className={chatWidth === width ? 'is-on' : ''}
              data-width={width}
              onClick={() => persist({ chatWidth: width })}
            >
              {t(lang, CHAT_WIDTH_KEYS[width])}
            </button>
          ))}
        </div>
      </div>

      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'compact_trigger_label')}</b>
          {triggerError ? (
            <span className="ns-pref-error" data-testid="next-pref-compact-error" role="alert">{triggerError}</span>
          ) : null}
          {hint ? (
            <span data-testid="next-pref-compact-effective" title={hint.title}>{hint.text}</span>
          ) : null}
        </div>
        <div className="ns-pref-input">
          <input
            data-testid="next-pref-compact-trigger"
            inputMode="numeric"
            value={trigger}
            aria-invalid={triggerError ? 'true' : undefined}
            aria-label={t(lang, 'compact_trigger_label')}
            onChange={(e) => {
              setTrigger(e.target.value);
              setTriggerError(null);
            }}
            onBlur={() => { void commitTrigger(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void commitTrigger();
              }
            }}
          />
          <span className="ns-pref-input-unit">%</span>
        </div>
      </div>
    </div>
  );
}
