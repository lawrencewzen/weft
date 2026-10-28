import { useSyncExternalStore } from 'react';
import type { Lang } from '../data/lang';
import { conversationPath, navigate } from '../data/nav';
import type { RightTab } from '../data/layout';
import { useRightPane } from '../data/rightPaneContext';
import { useSession } from '../data/session';
import { t } from '../i18n';
import { ChangesPane } from './ChangesPane';
import { FileBrowser } from './FileBrowser';
import { SubagentOverview } from './SubagentOverview';
import { SubagentPane } from './SubagentPane';

type Props = {
  lang: Lang;
  workspaceLabel: string;
};

export function RightPane({ lang, workspaceLabel }: Props) {
  const {
    tab,
    setTab,
    open,
    setOpen,
    totals,
    hasChanges,
    selectedSubagentId,
  } = useRightPane();
  const { store, conversationId } = useSession();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const agents = conversationId ? store.subagents(conversationId) : [];
  const showSubagentsTab = agents.length > 0 || Boolean(selectedSubagentId);
  const effectiveTab: RightTab = tab === 'subagents' && showSubagentsTab
    ? 'subagents'
    : tab === 'files'
      ? 'files'
      : 'changes';

  function onSubagentsTab() {
    if (selectedSubagentId && conversationId) {
      navigate(conversationPath(conversationId));
    }
    setTab('subagents');
  }

  return (
    <aside
      className="col-right"
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
          {showSubagentsTab ? (
            <button
              type="button"
              className={`tab-btn${effectiveTab === 'subagents' ? ' active' : ''}`}
              data-testid="next-right-tab-subagents"
              title={t(lang, 'tab_subagents_title')}
              onClick={onSubagentsTab}
            >
              <span>{t(lang, 'tab_subagents')}</span>
              {agents.length > 0 ? <span className="tab-count">{agents.length}</span> : null}
            </button>
          ) : null}
        </nav>
        <div className="tabs-actions">
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
        {effectiveTab === 'subagents' && conversationId && selectedSubagentId ? (
          <SubagentPane
            cid={conversationId}
            agentId={selectedSubagentId}
            agents={agents}
            lang={lang}
          />
        ) : effectiveTab === 'subagents' && conversationId ? (
          <SubagentOverview cid={conversationId} agents={agents} lang={lang} />
        ) : effectiveTab === 'files' ? (
          <FileBrowser lang={lang} workspaceLabel={workspaceLabel} />
        ) : (
          <ChangesPane lang={lang} />
        )}
      </div>
      </div>
    </aside>
  );
}
