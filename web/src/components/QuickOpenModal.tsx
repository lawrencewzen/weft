import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Lang } from '../data/lang';
import { getRecentFiles } from '../data/recentFiles';
import { useFileSearch } from '../data/useFileSearch';
import { t } from '../i18n';
import { FileSearchResultRow } from './FileSearchResultRow';

const SEARCH_ICON = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3" />
  </svg>
);

export type QuickOpenModalProps = {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  workspaceId: string | null;
  onSelectFile: (path: string) => void;
};

export function QuickOpenModal({
  lang,
  open,
  onClose,
  workspaceId,
  onSelectFile,
}: QuickOpenModalProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const trimmed = query.trim();
  const isQueryEmpty = trimmed.length === 0;

  const { entries, truncated, loading, error } = useFileSearch(
    isQueryEmpty ? null : workspaceId,
    query,
    { limit: 20 },
  );

  const recentList = useMemo(() => {
    if (!isQueryEmpty || !workspaceId) return [];
    return getRecentFiles(workspaceId).map((path) => ({ path }));
  }, [isQueryEmpty, workspaceId]);

  const items = isQueryEmpty ? recentList : entries;

  useEffect(() => {
    if (open) {
      prevFocusRef.current = (document.activeElement as HTMLElement) ?? null;
      setQuery('');
      setSelectedIndex(0);
      inputRef.current?.focus();
      const raf = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => {
        cancelAnimationFrame(raf);
        const prev = prevFocusRef.current;
        if (prev && document.contains(prev)) {
          prev.focus();
        }
      };
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector<HTMLElement>('.file-search-result-row.is-selected');
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
      if (!items.length) return;
      setSelectedIndex((prev) => (prev + 1) % items.length);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!items.length) return;
      setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
      return;
    }
    if (ev.key === 'Enter') {
      const isComposing = ev.nativeEvent.isComposing || (ev as unknown as { isComposing?: boolean }).isComposing;
      if (isComposing) {
        return;
      }
      ev.preventDefault();
      const target = items[selectedIndex];
      if (target) {
        onSelectFile(target.path);
        onClose();
      }
    }
  }

  function handleSelect(path: string) {
    onSelectFile(path);
    onClose();
  }

  return createPortal(
    <div
      className="search-palette-overlay"
      data-testid="next-quick-open-modal"
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
        aria-label={t(lang, 'file_search_placeholder')}
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
            data-testid="next-quick-open-input"
            placeholder={t(lang, 'file_search_placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="search-palette-esc"
            onClick={onClose}
            aria-label={t(lang, 'btn_cancel')}
          >
            ESC
          </button>
        </div>
        <div ref={listRef} className="search-palette-list" data-testid="next-quick-open-list">
          {isQueryEmpty && recentList.length > 0 ? (
            <div className="search-palette-label">{t(lang, 'search_recent')}</div>
          ) : null}

          {error ? (
            <div className="search-palette-empty" data-testid="next-quick-open-error">
              {t(lang, 'file_search_error')}
            </div>
          ) : !isQueryEmpty && !loading && items.length === 0 ? (
            <div className="search-palette-empty" data-testid="next-quick-open-empty">
              {t(lang, 'file_search_no_results')}
            </div>
          ) : (
            items.map((item, idx) => (
              <FileSearchResultRow
                key={item.path}
                path={item.path}
                query={query}
                selected={idx === selectedIndex}
                onClick={() => handleSelect(item.path)}
                onMouseEnter={() => setSelectedIndex(idx)}
              />
            ))
          )}

          {!isQueryEmpty && truncated ? (
            <div className="search-palette-label" data-testid="next-quick-open-truncated">
              {t(lang, 'file_search_truncated')}
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
