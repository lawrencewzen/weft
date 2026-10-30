import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Lang } from '../data/lang';
import { formatRelativeTime } from '../data/relativeTime';
import type { WorkspaceGroup } from '../data/sidebarModel';
import { filterSearchConversations, type SearchItem } from '../data/sidebarSearchModel';
import { t } from '../i18n';
import { StatusIcon, statusIconFor } from './StatusIcon';

const SEARCH_ICON = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3" />
  </svg>
);

export interface SidebarSearchProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  groups: WorkspaceGroup[];
  onSelectConversation: (workspaceId: string, convId: string) => void;
}

export function SidebarSearch({
  lang,
  open,
  onClose,
  groups,
  onSelectConversation,
}: SidebarSearchProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const results: SearchItem[] = useMemo(
    () => filterSearchConversations(groups, query),
    [groups, query],
  );

  useEffect(() => {
    if (open) {
      const prev = (document.activeElement as HTMLElement) ?? null;
      setQuery('');
      setSelectedIndex(0);
      inputRef.current?.focus();
      const raf = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => {
        cancelAnimationFrame(raf);
        if (prev && document.contains(prev)) {
          prev.focus();
        }
      };
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector<HTMLElement>('.search-result-row.is-selected');
    if (selectedEl) {
      selectedEl.scrollIntoView?.({ block: 'nearest' });
    }
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        onClose();
        return;
      }
      if (ev.key === 'Tab') {
        if (!dialogRef.current) return;
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) {
          ev.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (ev.shiftKey) {
          if (document.activeElement === first || !dialogRef.current.contains(document.activeElement)) {
            ev.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !dialogRef.current.contains(document.activeElement)) {
            ev.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function handleKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      onClose();
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (!results.length) return;
      setSelectedIndex((prev) => (prev + 1) % results.length);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!results.length) return;
      setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const target = results[selectedIndex];
      if (target) {
        onSelectConversation(target.workspace.id, target.conv.id);
        onClose();
      }
    }
  }

  return createPortal(
    <div
      className="search-palette-overlay"
      data-testid="next-search-modal"
      onMouseDown={onClose}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="search-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, 'search')}
        onMouseDown={(ev) => ev.stopPropagation()}
        onClick={(ev) => ev.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="search-palette-head">
          <span className="search-palette-ic">{SEARCH_ICON}</span>
          <input
            ref={inputRef}
            type="text"
            className="search-palette-input"
            data-testid="next-search-input"
            placeholder={t(lang, 'search_placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="search-palette-esc"
            onClick={onClose}
            aria-label={t(lang, 'btn_cancel')}
          >
            Esc
          </button>
        </div>

        <div className="search-palette-list" data-testid="next-search-results" ref={listRef}>
          {results.length > 0 ? (
            <>
              {!query.trim() ? (
                <div className="search-palette-label">{t(lang, 'search_recent')}</div>
              ) : null}
              {results.map((item, index) => {
                const { conv, workspace } = item;
                const isSelected = index === selectedIndex;
                const iconStatus = statusIconFor(conv.status);
                const relTime = formatRelativeTime(lang, conv.updatedAt);
                return (
                  <div
                    key={conv.id}
                    className={`search-result-row${isSelected ? ' is-selected' : ''}`}
                    data-testid="next-search-result"
                    data-id={conv.id}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => {
                      onSelectConversation(workspace.id, conv.id);
                      onClose();
                    }}
                  >
                    <span className="search-result-status">
                      {iconStatus ? (
                        <StatusIcon status={iconStatus} size={14} lang={lang} />
                      ) : null}
                    </span>
                    <span className="search-result-title">
                      {conv.title || t(lang, 'default_conversation_title')}
                    </span>
                    <span className="search-result-project">{workspace.name}</span>
                    <span className="search-result-time">{relTime}</span>
                  </div>
                );
              })}
            </>
          ) : (
            <div className="search-palette-empty" data-testid="next-search-empty">
              {t(lang, 'search_no_results')}
            </div>
          )}
        </div>

        <div className="search-palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd>{t(lang, 'search_kbd_move')}</span>
          <span><kbd>↵</kbd>{t(lang, 'search_kbd_open')}</span>
          <span><kbd>Esc</kbd>{t(lang, 'search_kbd_close')}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
