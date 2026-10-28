import { useMemo, useState } from 'react';
import type { Lang } from '../data/lang';
import { useRightPane } from '../data/rightPaneContext';
import type { Change } from '../data/store';
import {
  getShownChanges,
  isChangeSummaryCollapsible,
  remainingHiddenCount,
  sortChanges,
  splitChangePath,
} from '../data/changeSummary';
import { t } from '../i18n';

type Props = {
  changes: Change[];
  lang: Lang;
};

const FILE_ICON = (
  <svg
    className="change-summary-row-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

const DIFF_ICON = (
  <svg
    className="change-summary-head-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M12 4v8M8 8h8M8 18h8" />
  </svg>
);

const CHEV_ICON = (
  <svg
    className="change-summary-more-icon"
    width="10"
    height="10"
    viewBox="0 0 12 12"
    aria-hidden="true"
  >
    <path
      d="M3 4.5l3 3 3-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

export function ChangeSummary({ changes, lang }: Props) {
  const { openChangeDiff, setOpen, setTab } = useRightPane();
  const [expanded, setExpanded] = useState(false);

  const sorted = useMemo(() => sortChanges(changes), [changes]);
  const collapsible = useMemo(() => isChangeSummaryCollapsible(sorted.length), [sorted.length]);
  const shown = useMemo(() => getShownChanges(sorted, expanded), [sorted, expanded]);
  const remaining = useMemo(() => remainingHiddenCount(sorted.length), [sorted.length]);

  const { totalAdd, totalDel } = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const c of changes) {
      add += c.added || 0;
      del += c.removed || 0;
    }
    return { totalAdd: add, totalDel: del };
  }, [changes]);

  if (!changes.length) return null;

  function openDiff(path: string) {
    if (!path) return;
    setOpen(true);
    openChangeDiff(path);
  }

  function openChangesPane() {
    setOpen(true);
    setTab('changes');
  }

  return (
    <div
      className="change-summary"
      data-testid="next-change-summary"
    >
      <div
        className="change-summary-head"
        data-testid="next-change-summary-head"
        role="button"
        tabIndex={0}
        onClick={openChangesPane}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openChangesPane();
          }
        }}
      >
        {DIFF_ICON}
        <span className="change-summary-head-title">
          {t(lang, 'change_summary_title', { n: changes.length })}
        </span>
        <span className="change-summary-head-sum">
          <span className="add">+{totalAdd.toLocaleString('en-US')}</span>{' '}
          <span className="del">−{totalDel.toLocaleString('en-US')}</span>
        </span>
        <span className="change-summary-head-view">
          {t(lang, 'change_summary_view_changes')}
        </span>
      </div>

      <div className={`change-summary-rows${expanded ? ' is-scroll' : ''}`}>
        {shown.map((change) => {
          const split = splitChangePath(change.path);
          const add = change.added || 0;
          const del = change.removed || 0;

          return (
            <button
              key={change.path}
              type="button"
              className="change-summary-row"
              data-testid="next-change-summary-row"
              data-path={change.path}
              title={change.path}
              onClick={() => openDiff(change.path)}
            >
              {FILE_ICON}
              <span className="change-summary-row-name">{split.name}</span>
              <span className="change-summary-row-dir">
                <span>{split.dir}</span>
              </span>
              {split.outside ? (
                <span
                  className="change-summary-row-outside"
                  data-testid="next-change-summary-outside"
                >
                  {t(lang, 'change_summary_outside_ws')}
                </span>
              ) : null}
              <span className="change-summary-row-nums">
                <span className={`change-summary-row-add${add ? '' : ' is-zero'}`}>
                  +{add.toLocaleString('en-US')}
                </span>
                <span className={`change-summary-row-del${del ? '' : ' is-zero'}`}>
                  −{del.toLocaleString('en-US')}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {collapsible ? (
        <button
          type="button"
          className={`change-summary-more${expanded ? ' is-open' : ''}`}
          data-testid="next-change-summary-more"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {CHEV_ICON}
          <span>
            {expanded
              ? t(lang, 'change_summary_collapse')
              : t(lang, 'change_summary_more_files', { n: remaining })}
          </span>
        </button>
      ) : null}
    </div>
  );
}
