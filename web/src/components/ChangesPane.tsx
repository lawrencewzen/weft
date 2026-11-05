import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import {
  changeByTitle,
  changeStatusLetter,
  changeStatusTitle,
  flattenDiff,
  formatChangeBy,
} from '../data/diffView';
import { focusSubagent } from '../data/focusSubagent';
import { useRightActions, useRightChanges } from '../data/rightPaneContext';
import { useSession } from '../data/session';
import { conversationTopic } from '../data/store';
import { useStoreTopics } from '../data/useStoreTopic';
import { t } from '../i18n';
import { CtxMenu, type CtxMenuItem } from './CtxMenu';

const CHEV = (
  <svg className="ws-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 3l3 3-3 3" />
  </svg>
);

type MenuState = { x: number; y: number; path: string };

export function ChangesPane({ lang }: { lang: Lang }) {
  const { store } = useSession();
  const {
    conversationId,
    visibleChanges,
    totals,
    openPaths,
    toggleChange,
    diffs,
  } = useRightChanges();
  const { openFile, copyPath } = useRightActions();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const subagentTopics = useMemo(() => {
    if (!conversationId) return [];
    return [
      conversationTopic(conversationId),
      `${conversationTopic(conversationId)}#subagent`,
    ];
  }, [conversationId]);
  useStoreTopics(store, subagentTopics);

  function onCtx(ev: MouseEvent, path: string) {
    ev.preventDefault();
    ev.stopPropagation();
    setMenu({ x: ev.clientX, y: ev.clientY, path });
  }

  const items = (path: string): CtxMenuItem[] => {
    const target = visibleChanges.find((c) => c.path === path);
    const list: CtxMenuItem[] = [];
    if (target?.status !== 'deleted') {
      list.push({ label: t(lang, 'show_in_files'), action: 'show-in-files', run: () => openFile(path) });
    }
    list.push({ label: t(lang, 'copy_path'), action: 'copy-path', run: () => copyPath(path) });
    return list;
  };

  if (!visibleChanges.length) {
    return <div className="pane-empty">{t(lang, 'no_changes_yet')}</div>;
  }

  return (
    <div className="changes-pane">
      <div className="changes-head">
        <div className="changes-head-line">
          <b>{t(lang, 'changes_file_count', { n: visibleChanges.length })}</b>
          <span className="stat-add">+{totals.added}</span>
          <span className="stat-del">−{totals.removed}</span>
        </div>
        <div className="changes-head-note">{t(lang, 'changes_note')}</div>
      </div>
      {visibleChanges.map((change) => {
        const open = openPaths.has(change.path);
        const diff = diffs[change.path];
        const by = change.by;
        const byLabel = formatChangeBy(by, lang);
        const byTitle = changeByTitle(by, store, conversationId);
        const isSubagent = by?.kind === 'subagent';
        const subagentId = by?.kind === 'subagent' ? by.agentId : null;

        const isRenamed = change.status === 'renamed' && !!change.oldPath;
        const renameDisplay = isRenamed ? `${change.oldPath} → ${change.path}` : null;
        const pillTitle = renameDisplay || change.path;
        const statusLetter = changeStatusLetter(change.status);
        const statusTitle = changeStatusTitle(change.status, lang);

        function onSubagentClick(ev: MouseEvent | KeyboardEvent) {
          ev.stopPropagation();
          if (subagentId) {
            focusSubagent(subagentId);
          }
        }

        function onSubagentKeyDown(ev: KeyboardEvent) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onSubagentClick(ev);
          }
        }

        return (
          <div
            key={change.path}
            className={`change-file${open ? ' is-open' : ''}`}
            data-testid="next-change-row"
            data-path={change.path}
            data-ctx="change-file"
          >
            <div
              className="changed-file-pill"
              title={pillTitle}
              onClick={() => toggleChange(change.path)}
              onContextMenu={(ev) => onCtx(ev, change.path)}
            >
              {CHEV}
              {statusLetter ? (
                <span
                  className={`changed-file-status is-${change.status}`}
                  data-testid="next-change-status"
                  data-status={change.status}
                  title={statusTitle || undefined}
                >
                  {statusLetter}
                </span>
              ) : null}
              {isRenamed ? (
                <span
                  className="changed-file-path is-renamed"
                  title={pillTitle}
                >
                  <span className="rename-old">{change.oldPath}</span>
                  <span className="rename-arrow"> → </span>
                  <span className="rename-new">{change.path}</span>
                </span>
              ) : (
                <span
                  className={`changed-file-path${change.status === 'deleted' ? ' is-deleted' : ''}`}
                  title={pillTitle}
                >
                  {change.path}
                </span>
              )}
              {byLabel ? (
                <span
                  className={`changed-file-by${isSubagent ? ' is-subagent' : ''}`}
                  data-testid="next-change-by"
                  data-by-kind={change.by?.kind}
                  title={byTitle}
                  role={isSubagent ? 'button' : undefined}
                  tabIndex={isSubagent ? 0 : undefined}
                  onClick={isSubagent ? onSubagentClick : undefined}
                  onKeyDown={isSubagent ? onSubagentKeyDown : undefined}
                >
                  {byLabel}
                </span>
              ) : null}
              <span className="stat-add">+{change.added}</span>
              <span className="stat-del">−{change.removed}</span>
            </div>
            {open ? (
              <div className="diff-viewport" data-testid="next-diff" data-path={change.path}>
                {change.error ? (
                  <div className="diff-note">{change.error}</div>
                ) : diff == null || diff === 'loading' ? (
                  <div className="diff-note">{t(lang, 'loading')}</div>
                ) : diff === 'error' ? (
                  <div className="diff-note">{t(lang, 'no_diff_available')}</div>
                ) : diff.tooLarge ? (
                  <div className="diff-note">{t(lang, 'file_too_large')}</div>
                ) : flattenDiff(diff).length === 0 ? (
                  <div className="diff-note">
                    {change.status === 'renamed'
                      ? t(lang, 'diff_renamed_only')
                      : t(lang, 'diff_no_change')}
                  </div>
                ) : (
                  <div className="diff-lines">
                    {flattenDiff(diff).map((row, i) => (
                      row.kind === 'hunk' ? (
                        <div key={`hunk-${i}`} className="diff-line is-hunk" data-testid="next-diff-line">
                          <span className="n old" />
                          <span className="n new" />
                          <span className="sign" />
                          <span className="code">⋯</span>
                        </div>
                      ) : (
                        <div
                          key={`line-${i}`}
                          className={`diff-line is-${row.op}`}
                          data-testid="next-diff-line"
                          data-op={row.op}
                        >
                          <span className="n old">{row.oldLine ?? ''}</span>
                          <span className="n new">{row.newLine ?? ''}</span>
                          <span className="sign">{row.op === 'add' ? '+' : row.op === 'del' ? '−' : ''}</span>
                          <span className="code">{row.text}</span>
                        </div>
                      )
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      {menu ? (
        <CtxMenu
          x={menu.x}
          y={menu.y}
          title={menu.path}
          items={items(menu.path)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
