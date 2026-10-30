import { t } from '../i18n';
import { useLeftPanel } from '../data/leftPanelContext';
import { useRightChanges, useRightLayout } from '../data/rightPaneContext';
import type { Lang } from '../data/lang';

export function LeftOpenButton({ lang, onOpen }: { lang: Lang; onOpen?: () => void }) {
  const { toggleLeft, leftSlotW, leftSlotM, leftSlotTr, leftBtnOp, leftBtnPe, lbDx, lbTr } = useLeftPanel();
  return (
    <div
      className="top-left-slot"
      style={{
        width: leftSlotW,
        marginRight: leftSlotM,
        flexShrink: 0,
        transition: leftSlotTr,
        overflow: 'visible',
      }}
    >
      <button
        type="button"
        className="icon-btn top-left-open"
        data-testid="next-left-open"
        title={t(lang, 'expand_sidebar')}
        aria-label={t(lang, 'expand_sidebar')}
        style={{
          opacity: leftBtnOp,
          pointerEvents: leftBtnPe,
          transform: `translateX(${lbDx}px)`,
          transition: lbTr,
          visibility: leftBtnOp ? 'visible' : 'hidden',
        }}
        onClick={() => {
          if (toggleLeft) toggleLeft();
          else onOpen?.();
        }}
      >
        <span className="ico-panel ico-panel-left" aria-hidden="true" />
      </button>
    </div>
  );
}

export function RightToggle({ lang }: { lang: Lang }) {
  const { open, toggleRight, rbDx, rbTr, rightBtnOp, rightBtnPe } = useRightLayout();
  const { hasChanges } = useRightChanges();
  return (
    <button
      type="button"
      className="icon-btn top-right-open"
      data-testid="next-right-toggle"
      title={t(lang, 'expand_panel')}
      aria-label={t(lang, 'expand_panel')}
      aria-pressed={open}
      style={{
        opacity: rightBtnOp,
        pointerEvents: rightBtnPe,
        transform: `translateX(${rbDx}px)`,
        transition: rbTr,
        visibility: rightBtnOp ? 'visible' : 'hidden',
      }}
      onClick={toggleRight}
    >
      <span className="ico-panel ico-panel-right" aria-hidden="true" />
      <span
        className={`top-right-dot${hasChanges ? ' is-on' : ''}`}
        data-testid="next-right-dot"
      />
    </button>
  );
}
