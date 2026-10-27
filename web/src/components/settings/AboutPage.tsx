import type { Lang } from '../../data/lang';
import { t } from '../../i18n';

export type AboutService = {
  serviceVersion: string;
  protocolVersion: string;
  demo: boolean;
};

type Props = {
  lang: Lang;
  service: AboutService;
};

const REPO_URL = 'https://github.com/lawrencewzen/weft';
const UPSTREAM_URL = 'https://github.com/xiaomoBoy/pi-durable-assistant';

export function AboutPage({ lang, service }: Props) {
  return (
    <div className="next-settings-content" data-testid="next-settings-about">
      <div className="next-settings-head">
        <h2>{t(lang, 'settings_nav_about')}</h2>
      </div>
      <div className="ns-about-brand">
        <div className="ns-about-logo" aria-hidden="true">W</div>
        <div>
          <b data-testid="next-about-name">{t(lang, 'app_name')}</b>
          <div className="ns-about-tagline">{t(lang, 'about_desc')}</div>
        </div>
      </div>
      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'about_version')}</b>
        </div>
        <span data-testid="next-about-version">{service.serviceVersion || '—'}</span>
      </div>
      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'about_protocol')}</b>
        </div>
        <span data-testid="next-about-protocol">{service.protocolVersion || '—'}</span>
      </div>
      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'about_demo')}</b>
        </div>
        <span data-testid="next-about-demo">
          {t(lang, service.demo ? 'about_demo_on' : 'about_demo_off')}
        </span>
      </div>
      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'about_repo')}</b>
        </div>
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">github.com/lawrencewzen/weft</a>
      </div>
      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'about_license')}</b>
        </div>
        <span>MIT</span>
      </div>
      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'about_thanks')}</b>
          <span>{t(lang, 'about_upstream')}</span>
        </div>
        <a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer">xiaomoBoy/pi-durable-assistant</a>
      </div>
      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'about_runtime')}</b>
        </div>
        <span>
          <span className="ns-about-dot" aria-hidden="true" />
          {t(lang, 'about_runtime_connected')}
        </span>
      </div>
    </div>
  );
}
