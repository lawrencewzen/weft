import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { Lang } from '../data/lang';
import { NO_PROJECT_ID } from '../data/sidebarModel';
import { isProjectWorkspace } from '../data/store';
import { useWorkspaces } from '../data/useWorkspaces';
import { shortenWorkspacePath } from '../data/workspacePath';
import { t } from '../i18n';
import { CtxMenu, type CtxMenuItem } from './CtxMenu';

type Props = {
  lang: Lang;
  selectedId?: string | null;
  canSwitch?: boolean;
  /** Draft empty-state title uses the same picker as the composer chip. */
  variant?: 'chip' | 'hero';
  onPick: (workspaceId: string | null) => void;
  onNew: () => void;
  onOpenTerminal?: () => void;
  onCopyPath?: (path: string) => void;
};

const FOLDER_ICON = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </svg>
);

const PLUS_ICON = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

const NONE_ICON = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M4.2 11.8l7.6-7.6" />
  </svg>
);

export function WorkspaceChip({
  lang,
  selectedId = null,
  canSwitch = false,
  variant = 'chip',
  onPick,
  onNew,
  onOpenTerminal,
  onCopyPath,
}: Props) {
  const { workspaces } = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [boundHint, setBoundHint] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const projects = workspaces.filter(isProjectWorkspace);
  const selected = projects.find((ws) => ws.id === selectedId) || null;
  const noneSelected = !selected;
  const hero = variant === 'hero';
  const chooseLabel = t(lang, 'ws_chip_choose');
  const noneLabel = t(lang, 'no_project');
  const label = selected?.name || chooseLabel;
  const title = selected?.path || selected?.name || chooseLabel;
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
    if (!canSwitch) {
      setOpen(false);
      setBoundHint(true);
      return;
    }
    setBoundHint(false);
    setOpen((value) => !value);
  }

  function onContextMenu(ev: ReactMouseEvent) {
    if (!selected) return;
    ev.preventDefault();
    ev.stopPropagation();
    setOpen(false);
    setBoundHint(false);
    setCtx({ x: ev.clientX, y: ev.clientY });
  }

  const ctxItems: CtxMenuItem[] = selected ? [
    {
      label: t(lang, 'open_in_terminal'),
      action: 'open-terminal',
      run: () => onOpenTerminal?.(),
    },
    {
      label: t(lang, 'copy_path'),
      action: 'copy-path',
      run: () => {
        if (selected.path) onCopyPath?.(selected.path);
      },
    },
  ] : [];

  return (
    <div className={`chip-selector-wrap${hero ? ' is-hero' : ''}`} ref={wrap}>
      <button
        type="button"
        className={`model-chip ws-chip${hero ? ' ws-chip-hero' : ''}${open || boundHint ? ' is-open' : ''}${noneSelected ? ' is-empty' : ''}`}
        data-testid={triggerId}
        data-bound={canSwitch ? undefined : 'true'}
        aria-haspopup={canSwitch ? 'listbox' : undefined}
        aria-expanded={open}
        title={title}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {hero ? null : FOLDER_ICON}
        <span className="model-chip-name">{label}</span>
        {canSwitch ? <span className="model-chip-caret" aria-hidden="true">▾</span> : null}
      </button>
      {boundHint ? (
        <div className="model-menu ws-chip-hint" data-testid="next-ws-chip-bound-hint" role="status">
          {t(lang, 'ws_chip_bound')}
        </div>
      ) : null}
      {open && canSwitch ? (
        <div className="model-menu ws-chip-menu" data-testid={menuId} role="listbox">
          {projects.length === 0 ? (
            <div className="ws-chip-empty" data-testid="next-ws-chip-empty">
              {t(lang, 'ws_chip_no_projects')}
            </div>
          ) : projects.map((ws) => {
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
                <span className="ws-chip-ic" aria-hidden="true">{FOLDER_ICON}</span>
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
          <div className="ws-chip-sep" />
          {selected ? (
            <button
              type="button"
              className="ws-chip-act"
              data-testid="next-ws-chip-option"
              data-id={NO_PROJECT_ID}
              onClick={() => {
                setOpen(false);
                onPick(null);
              }}
            >
              <span className="ws-chip-ic" aria-hidden="true">{NONE_ICON}</span>
              {noneLabel}
            </button>
          ) : null}
          <button
            type="button"
            className="ws-chip-act"
            data-testid="next-ws-chip-new"
            onClick={() => {
              setOpen(false);
              onNew();
            }}
          >
            <span className="ws-chip-ic" aria-hidden="true">{PLUS_ICON}</span>
            {t(lang, 'ws_chip_add_project')}
          </button>
        </div>
      ) : null}
      {ctx && selected ? (
        <CtxMenu
          x={ctx.x}
          y={ctx.y}
          title={selected.path || selected.name}
          items={ctxItems}
          onClose={() => setCtx(null)}
        />
      ) : null}
    </div>
  );
}
