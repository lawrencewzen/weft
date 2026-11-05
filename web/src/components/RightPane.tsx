import type { Lang } from '../data/lang';
import type { RightTab } from '../data/layout';
import { useRightChanges, useRightLayout } from '../data/rightPaneContext';
import { t } from '../i18n';
import { ChangesPane } from './ChangesPane';
import { FileBrowser } from './FileBrowser';

type Props = {
  lang: Lang;
  workspaceLabel: string;
};

const MAXIMIZE_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 2.5h3.5v3.5M13.5 2.5L9.5 6.5M6 13.5H2.5V10M2.5 13.5l4-4" />
  </svg>
);

const RESTORE_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13.5 6H10V2.5M10 6l4-4M2.5 10H6v3.5M6 10l-4 4" />
  </svg>
);

export function RightPane({ lang, workspaceLabel }: Props) {
  const {
    tab,
    setTab,
    open,
    maximized,
    toggleMaximized,
  } = useRightLayout();
  const { totals, hasChanges } = useRightChanges();
  const effectiveTab: RightTab = tab === 'files' ? 'files' : 'changes';

  return (
    <aside
      className={`col-right${maximized ? ' is-maximized' : ''}`}
      data-testid="next-right"
      inert={!open || undefined}
      aria-hidden={!open || undefined}
    >
      <div className="col-panel-inner">
      <header className="right-tabs-bar">
        <nav className="tabs-nav">
          <button
            type="button"
            className={`tab-btn${effectiveTab === 'changes' ? ' active' : ''}`}
            data-testid="next-right-tab-changes"
            title={t(lang, 'tab_diff_title')}
            onClick={() => setTab('changes')}
          >
            <span>{t(lang, 'tab_diff')}</span>
            {hasChanges ? (
              <span className="tab-stat">
                <span className="add">+{totals.added}</span>
                <span className="del">−{totals.removed}</span>
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className={`tab-btn${effectiveTab === 'files' ? ' active' : ''}`}
            data-testid="next-right-tab-files"
            title={t(lang, 'tab_file_title')}
            onClick={() => setTab('files')}
          >
            <span>{t(lang, 'tab_file')}</span>
          </button>
        </nav>
        {effectiveTab === 'files' ? (
          <div className="right-tabs-actions">
            <button
              type="button"
              className="icon-btn is-sm right-tab-action"
              data-testid="next-file-maximize"
              title={maximized ? t(lang, 'restore_panel') : t(lang, 'maximize_panel')}
              aria-label={maximized ? t(lang, 'restore_panel') : t(lang, 'maximize_panel')}
              onClick={toggleMaximized}
            >
              {maximized ? RESTORE_ICON : MAXIMIZE_ICON}
            </button>
          </div>
        ) : null}
      </header>
      <div className="right-viewport">
        {effectiveTab === 'files' ? (
          <FileBrowser lang={lang} workspaceLabel={workspaceLabel} />
        ) : (
          <ChangesPane lang={lang} />
        )}
      </div>
      </div>
    </aside>
  );
}
