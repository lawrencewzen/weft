import type { Lang } from '../../data/lang';
import { openReportDialog } from '../../data/reportDialog';
import { t } from '../../i18n';

export type AboutService = {
  serviceVersion: string;
};

type Props = {
  lang: Lang;
  service: AboutService;
};

const REPO_URL = 'https://github.com/lawrencewzen/weft';

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
          <b>{t(lang, 'about_runtime')}</b>
        </div>
        <span>
          <span className="ns-about-dot" aria-hidden="true" />
          {t(lang, 'about_runtime_connected')}
        </span>
      </div>
      <div className="ns-pref-row">
        <div className="ns-pref-copy">
          <b>{t(lang, 'report_issue')}</b>
        </div>
        <button type="button" className="btn" data-testid="next-about-report" onClick={() => openReportDialog()}>
          {t(lang, 'report_issue')}
        </button>
      </div>
    </div>
  );
}
