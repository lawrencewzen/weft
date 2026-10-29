import { useEffect, useMemo } from 'react';
import { agentCommands, commandTopics } from '../data/agentCommands';
import type { Lang } from '../data/lang';
import type { RightTab } from '../data/layout';
import { useRightPane } from '../data/rightPaneContext';
import { useSession } from '../data/session';
import { subagentTopic } from '../data/store';
import { useStoreTopics } from '../data/useStoreTopic';
import { t } from '../i18n';
import { ChangesPane } from './ChangesPane';
import { FileBrowser } from './FileBrowser';
import { TerminalPane } from './TerminalPane';

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
    totals,
    hasChanges,
  } = useRightPane();
  const { store, conversationId, retainTopic, releaseTopic } = useSession();
  const agents = conversationId ? store.subagents(conversationId) : [];
  const agentIdsKey = agents.map((agent) => agent.id).join(';');
  const agentsKey = agents.map((agent) => `${agent.id}:${agent.status}`).join(';');
  const paneTopics = useMemo(
    () => (conversationId ? commandTopics(conversationId, agents) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- agentIdsKey captures list of subagents
    [conversationId, agentIdsKey],
  );
  const storeVersion = useStoreTopics(store, paneTopics);
  const commands = useMemo(
    () => (conversationId ? agentCommands(store, conversationId, agents) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store is stable; storeVersion tracks writes
    [store, conversationId, agentsKey, storeVersion],
  );
  const runningCount = commands.filter((row) => row.running).length;
  const effectiveTab: RightTab = tab === 'term'
    ? 'term'
    : tab === 'files'
      ? 'files'
      : 'changes';

  const agentKey = agents.map((agent) => agent.id).join('\n');
  useEffect(() => {
    if (!conversationId) return;
    const list = store.subagents(conversationId);
    const topics = list.map((agent) => subagentTopic(conversationId, agent.id));
    for (const topic of topics) retainTopic(topic);
    return () => {
      for (const topic of topics) releaseTopic(topic);
    };
  }, [conversationId, agentKey, retainTopic, releaseTopic, store]);

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
          <button
            type="button"
            className={`tab-btn${effectiveTab === 'term' ? ' active' : ''}`}
            data-testid="next-right-tab-term"
            title={t(lang, 'tab_term_title')}
            onClick={() => setTab('term')}
          >
            <span>{t(lang, 'tab_term')}</span>
            {runningCount > 0 ? <span className="tab-count">{runningCount}</span> : null}
          </button>
        </nav>
      </header>
      <div className="right-viewport">
        {effectiveTab === 'term' ? (
          <TerminalPane lang={lang} />
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
