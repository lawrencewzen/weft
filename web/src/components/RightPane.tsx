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

export function RightPane({ lang, workspaceLabel }: Props) {
  const {
    tab,
    setTab,
    open,
    toggleRight,
    rpBtnOp,
  } = useRightLayout();
  const { totals, hasChanges } = useRightChanges();
  const effectiveTab: RightTab = tab === 'files' ? 'files' : 'changes';

  return (
    <aside
      className="col-right"
      data-testid="next-right"
      inert={!open || undefined}
      aria-hidden={!open || undefined}
    >
      <div className="col-panel-inner">
      <header className="right-tabs-bar">
        <button
          type="button"
          className="icon-btn next-right-collapse-btn"
          data-testid="next-right-collapse"
          title={t(lang, 'collapse_panel')}
          aria-label={t(lang, 'collapse_panel')}
          style={{
            opacity: rpBtnOp,
            pointerEvents: rpBtnOp ? 'auto' : 'none',
            visibility: rpBtnOp ? 'visible' : 'hidden',
            marginRight: 4,
            flexShrink: 0,
          }}
          onClick={toggleRight}
        >
          <span className="ico-panel ico-panel-right" aria-hidden="true" />
        </button>
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
