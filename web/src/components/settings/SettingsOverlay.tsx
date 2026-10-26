import { useEffect } from 'react';
import type { Lang } from '../../data/lang';
import { closeSettings, navigate, settingsPath } from '../../data/nav';
import { SETTINGS_PAGES, type SettingsPage } from '../../data/providerWizard';
import { t, type I18nKey } from '../../i18n';
import type { ConfirmOpts } from '../ConfirmDialog';
import { AboutPage, type AboutService } from './AboutPage';
import { GeneralPage } from './GeneralPage';
import { GitPage } from './GitPage';
import { PluginsPage } from './PluginsPage';
import { ProviderPage } from './ProviderPage';
import { SkillsPage } from './SkillsPage';

const NAV: { id: SettingsPage; key: I18nKey }[] = [
  { id: 'general', key: 'settings_nav_general' },
  { id: 'providers', key: 'settings_nav_providers' },
  { id: 'git', key: 'settings_nav_git' },
  { id: 'plugins', key: 'settings_nav_plugins' },
  { id: 'skills', key: 'settings_nav_skills' },
  { id: 'about', key: 'settings_nav_about' },
];

type Props = {
  page: SettingsPage;
  lang: Lang;
  service: AboutService;
  onToast: (message: string) => void;
  onConfirm: (opts: ConfirmOpts) => Promise<boolean>;
};

export function SettingsOverlay({ page, lang, service, onToast, onConfirm }: Props) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeSettings();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const current = SETTINGS_PAGES.includes(page) ? page : 'general';

  return (
    <div
      className="next-settings-ov"
      data-testid="next-settings"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) closeSettings();
      }}
    >
      <div className="next-settings" role="dialog" aria-modal="true" aria-label={t(lang, 'settings_title')}>
        <nav className="next-settings-nav">
          <h3>{t(lang, 'settings_title')}</h3>
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`next-settings-nav-item${current === item.id ? ' is-on' : ''}`}
              data-testid={`next-settings-nav-${item.id}`}
              onClick={() => navigate(settingsPath(item.id), { replace: true })}
            >
              {t(lang, item.key)}
            </button>
          ))}
        </nav>
        <div className="next-settings-body">
          <button
            type="button"
            className="next-settings-close"
            aria-label={t(lang, 'settings_close')}
            onClick={() => closeSettings()}
          >
            ×
          </button>
          {current === 'providers' ? (
            <ProviderPage lang={lang} onToast={onToast} onConfirm={onConfirm} />
          ) : current === 'general' ? (
            <GeneralPage lang={lang} />
          ) : current === 'about' ? (
            <AboutPage lang={lang} service={service} />
          ) : current === 'git' ? (
            <GitPage lang={lang} onToast={onToast} onConfirm={onConfirm} />
          ) : current === 'plugins' ? (
            <PluginsPage lang={lang} onToast={onToast} />
          ) : current === 'skills' ? (
            <SkillsPage lang={lang} onToast={onToast} onConfirm={onConfirm} />
          ) : (
            <div className="next-settings-content">
              <div className="next-settings-head">
                <h2>{t(lang, NAV.find((item) => item.id === current)?.key || 'settings_title')}</h2>
              </div>
              <p className="next-settings-placeholder">{t(lang, 'settings_coming')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
