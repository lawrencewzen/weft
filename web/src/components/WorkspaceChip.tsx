import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../data/lang';
import { useWorkspaces } from '../data/useWorkspaces';
import { shortenWorkspacePath } from '../data/workspacePath';
import { t } from '../i18n';

type Props = {
  lang: Lang;
  selectedId?: string | null;
  canSwitch?: boolean;
  /** Draft empty-state title uses the same picker as the composer chip. */
  variant?: 'chip' | 'hero';
  onPick: (workspaceId: string) => void;
  onNew: () => void;
};

const FOLDER_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

export function WorkspaceChip({
  lang,
  selectedId = null,
  canSwitch = false,
  variant = 'chip',
  onPick,
  onNew,
}: Props) {
  const { workspaces } = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [boundHint, setBoundHint] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const selected = workspaces.find((ws) => ws.id === selectedId) || null;
  const empty = workspaces.length === 0;
  const hero = variant === 'hero';
  const emptyLabel = t(lang, hero ? 'pick_project' : 'pick_workspace');
  const label = selected?.name || emptyLabel;
  const title = selected?.path || selected?.name || emptyLabel;
  const triggerId = hero ? 'next-draft-hero-ws' : 'next-ws-chip';
  const menuId = hero ? 'next-draft-hero-menu' : 'next-ws-chip-menu';

  useEffect(() => {
    if (!open && !boundHint) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setOpen(false);
        setBoundHint(false);
      }
    };
    const onDown = (ev: MouseEvent) => {
      if (!wrap.current?.contains(ev.target as Node)) {
        setOpen(false);
        setBoundHint(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, boundHint]);

  useEffect(() => {
    if (!boundHint) return;
    const timer = window.setTimeout(() => setBoundHint(false), 2200);
    return () => window.clearTimeout(timer);
  }, [boundHint]);

  function onClick() {
    if (empty) {
      onNew();
      return;
    }
    if (!canSwitch) {
      setOpen(false);
      setBoundHint(true);
      return;
    }
    setBoundHint(false);
    setOpen((value) => !value);
  }

  return (
    <div className={`chip-selector-wrap${hero ? ' is-hero' : ''}`} ref={wrap}>
      <button
        type="button"
        className={`model-chip ws-chip${hero ? ' ws-chip-hero' : ''}${open || boundHint ? ' is-open' : ''}`}
        data-testid={triggerId}
        data-bound={canSwitch ? undefined : 'true'}
        aria-haspopup={canSwitch && !empty ? 'listbox' : undefined}
        aria-expanded={open}
        title={title}
        onClick={onClick}
      >
        {hero ? null : FOLDER_ICON}
        <span className="model-chip-name">{label}</span>
        {canSwitch && !empty ? <span className="model-chip-caret" aria-hidden="true">▾</span> : null}
      </button>
      {boundHint ? (
        <div className="model-menu ws-chip-hint" data-testid="next-ws-chip-bound-hint" role="status">
          {t(lang, 'ws_chip_bound')}
        </div>
      ) : null}
      {open && canSwitch ? (
        <div className="model-menu ws-chip-menu" data-testid={menuId} role="listbox">
          {workspaces.map((ws) => {
            const selectedRow = ws.id === selected?.id;
            return (
              <button
                key={ws.id}
                type="button"
                className={`model-menu-item${selectedRow ? ' is-selected' : ''}`}
                role="option"
                aria-selected={selectedRow}
                data-testid="next-ws-chip-option"
                data-id={ws.id}
                title={ws.path || ws.name}
                onClick={() => {
                  setOpen(false);
                  if (ws.id !== selected?.id) onPick(ws.id);
                }}
              >
                <span className="model-menu-copy">
                  <span className="model-menu-title">{ws.name}</span>
                  {ws.path ? (
                    <span className="model-menu-id ws-chip-path">{shortenWorkspacePath(ws.path)}</span>
                  ) : null}
                </span>
                {selectedRow ? <span className="model-menu-check" aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
          <div className="model-menu-foot">
            <button
              type="button"
              className="model-menu-manage"
              data-testid="next-ws-chip-new"
              onClick={() => {
                setOpen(false);
                onNew();
              }}
            >
              {t(lang, 'ws_chip_new')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
