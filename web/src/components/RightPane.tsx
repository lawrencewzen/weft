import type { Lang } from '../data/lang';
import { isMarkdownFile, useRightPane } from '../data/rightPaneContext';
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
    setOpen,
    totals,
    hasChanges,
    activeFilePath,
    editorMode,
    setEditorMode,
  } = useRightPane();
  const md = isMarkdownFile(activeFilePath) && tab === 'files';
  const showEdit = md && editorMode !== 'edit';

  return (
    <aside className="col-right" data-testid="next-right">
      <header className="right-tabs-bar">
        <nav className="tabs-nav">
          <button
            type="button"
            className={`tab-btn${tab === 'changes' ? ' active' : ''}`}
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
            className={`tab-btn${tab === 'files' ? ' active' : ''}`}
            data-testid="next-right-tab-files"
            title={t(lang, 'tab_file_title')}
            onClick={() => setTab('files')}
          >
            <span>{t(lang, 'tab_file')}</span>
          </button>
        </nav>
        <div className="tabs-actions">
          {showEdit ? (
            <button
              type="button"
              className="tab-action-icon"
              data-testid="next-file-open-editor"
              title={t(lang, 'btn_edit')}
              onClick={() => setEditorMode('edit')}
            >
              {t(lang, 'btn_edit')}
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            data-testid="next-right-collapse"
            title={t(lang, 'collapse_panel')}
            aria-label={t(lang, 'collapse_panel')}
            onClick={() => setOpen(false)}
          >
            <span className="ico-panel ico-panel-right" aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="right-viewport">
        {tab === 'files' ? (
          <FileBrowser lang={lang} workspaceLabel={workspaceLabel} />
        ) : (
          <ChangesPane lang={lang} />
        )}
      </div>
    </aside>
  );
}
