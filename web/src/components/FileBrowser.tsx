import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import {
  FILE_LAYOUT_MIN_TOTAL,
  FILE_PREVIEW_W_MIN,
  FILE_TREE_W_DEFAULT,
  FILE_TREE_W_MIN,
  readFileTreeWidth,
  writeFileTreeWidth,
} from '../data/layout';
import { isMarkdownFile, useRightActions, useRightChanges, useRightFiles } from '../data/rightPaneContext';
import { visibleTreeRows } from '../data/fileTree';
import { readUiZoom } from '../data/uiZoom';
import { useFileSearch, type UseFileSearchResult } from '../data/useFileSearch';
import { t } from '../i18n';
import { CodeEditor } from './CodeEditor';
import { CtxMenu, type CtxMenuItem } from './CtxMenu';
import { FileSearchResultRow } from './FileSearchResultRow';
import { Markdown } from './Markdown';

const DIR_CHEV = (
  <svg className="ws-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 3l3 3-3 3" />
  </svg>
);

const FILE_TREE_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M6 2.5v11" />
  </svg>
);

const SEARCH_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3" />
  </svg>
);

type EditorPaneProps = {
  lang: Lang;
  isNarrow?: boolean;
  showDrawer?: boolean;
  onToggleDrawer?: () => void;
};

function FileEditorPane({ lang, isNarrow = false, showDrawer = false, onToggleDrawer }: EditorPaneProps) {
  const {
    file,
    activeFilePath,
    editorMode,
    setEditorMode,
    draftText,
    setDraftText,
    saveFile,
    saveState,
    reloadFile,
    fileTargetLine,
  } = useRightFiles();

  const toggleBtn = isNarrow ? (
    <button
      type="button"
      className="icon-btn is-sm file-tree-toggle-btn"
      data-testid="next-file-tree-toggle"
      title={showDrawer ? t(lang, 'hide_file_tree') : t(lang, 'show_file_tree')}
      aria-label={showDrawer ? t(lang, 'hide_file_tree') : t(lang, 'show_file_tree')}
      aria-expanded={showDrawer}
      onClick={onToggleDrawer}
    >
      {FILE_TREE_ICON}
    </button>
  ) : null;

  if (!activeFilePath || !file) {
    return (
      <div className="md-editor-container file-editor-empty-container">
        {isNarrow ? (
          <div className="md-editor-toolbar file-preview-head">
            <div className="file-toolbar-left">
              {toggleBtn}
              <span className="path">{t(lang, 'select_file_to_preview')}</span>
            </div>
          </div>
        ) : null}
        <div className="file-preview-empty">{t(lang, 'select_file_to_preview')}</div>
      </div>
    );
  }
  if (file.tooLarge) {
    return (
      <div className="md-editor-container file-editor-empty-container">
        {isNarrow ? (
          <div className="md-editor-toolbar file-preview-head">
            <div className="file-toolbar-left">
              {toggleBtn}
              <span className="path" title={activeFilePath}>{activeFilePath}</span>
            </div>
          </div>
        ) : null}
        <div className="file-preview-empty">{activeFilePath} — {t(lang, 'file_too_large')}</div>
      </div>
    );
  }
  if (file.binary || file.text == null) {
    return (
      <div className="md-editor-container file-editor-empty-container">
        {isNarrow ? (
          <div className="md-editor-toolbar file-preview-head">
            <div className="file-toolbar-left">
              {toggleBtn}
              <span className="path" title={activeFilePath}>{activeFilePath}</span>
            </div>
          </div>
        ) : null}
        <div className="file-preview-empty">{activeFilePath} — {t(lang, 'file_binary')}</div>
      </div>
    );
  }

  const isMd = isMarkdownFile(activeFilePath);
  const isDirty = draftText !== (file.text ?? '');
  const lineCount = draftText.length === 0 ? 1 : draftText.split('\n').length;

  return (
    <div className="md-editor-container code-editor-wrapper" data-testid="next-file-editor">
      <div className="md-editor-toolbar file-preview-head">
        <div className="file-toolbar-left">
          {toggleBtn}
          <span className="path" title={activeFilePath}>{activeFilePath}</span>
          {!isMd ? (
            <span className="file-lines-count">{t(lang, 'file_lines', { n: lineCount })}</span>
          ) : null}
          {isDirty ? (
            <span className="file-unsaved" data-testid="next-file-unsaved" title={t(lang, 'file_unsaved')}>
              ● {t(lang, 'file_unsaved')}
            </span>
          ) : null}
        </div>
        <div className="md-editor-actions">
          {isMd ? (
            editorMode === 'edit' ? (
              <button type="button" className="btn btn-sm" onClick={() => setEditorMode('preview')}>
                {t(lang, 'btn_preview')}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                data-testid="next-file-open-editor"
                onClick={() => setEditorMode('edit')}
              >
                {t(lang, 'btn_edit')}
              </button>
            )
          ) : null}
          <button
            type="button"
            className="btn btn-sm p"
            data-testid="next-file-save"
            onClick={() => { void saveFile(); }}
            disabled={saveState.phase === 'saving'}
          >
            {t(lang, 'btn_save')}
          </button>
        </div>
      </div>
      {saveState.phase === 'conflict' ? (
        <div className="file-conflict" data-testid="next-file-conflict">
          <span>{t(lang, 'file_conflict')}</span>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="next-file-overwrite"
            onClick={() => { void saveFile(true); }}
          >
            {t(lang, 'file_overwrite')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="next-file-reload"
            onClick={() => { void reloadFile(); }}
          >
            {t(lang, 'file_reload')}
          </button>
        </div>
      ) : null}
      {isMd && editorMode === 'preview' ? (
        <div className="md-editor-preview">
          <Markdown text={draftText} copyLabel={t(lang, 'copy_code')} copiedLabel={t(lang, 'copied')} />
        </div>
      ) : (
        <CodeEditor
          key={activeFilePath}
          filePath={activeFilePath}
          value={draftText}
          onChange={setDraftText}
          targetLine={fileTargetLine}
          onSave={saveFile}
        />
      )}
    </div>
  );
}

type DirMenu = { x: number; y: number; path: string };

type TreeContentProps = {
  lang: Lang;
  workspaceLabel: string;
  treeReady: boolean;
  rows: ReturnType<typeof visibleTreeRows>;
  activeFilePath: string | null;
  changed: Set<string>;
  treeTruncated: boolean;
  onDirMenu: (ev: MouseEvent, dirPath: string) => void;
  onSelectDir: (path: string) => void;
  onSelectFile: (path: string) => void;
};

function FileTreeRows({
  lang,
  workspaceLabel,
  treeReady,
  rows,
  activeFilePath,
  changed,
  treeTruncated,
  onDirMenu,
  onSelectDir,
  onSelectFile,
}: TreeContentProps) {
  return (
    <>
      {workspaceLabel ? <div className="file-tree-root" title={workspaceLabel}>{workspaceLabel}</div> : null}
      {!treeReady ? (
        <div className="file-tree-empty">{t(lang, 'file_tree_loading')}</div>
      ) : rows.length === 0 ? (
        <div className="file-tree-empty">{t(lang, 'file_tree_empty')}</div>
      ) : (
        rows.map((row) => (
          row.type === 'dir' ? (
            <button
              key={row.path}
              type="button"
              className={`file-tree-row is-dir${row.expanded ? ' is-open' : ''}${row.ignored ? ' is-ignored' : ''}`}
              style={{ paddingLeft: 8 + row.depth * 14 }}
              title={row.path}
              data-testid="next-file-node"
              data-path={row.path}
              data-type="dir"
              onClick={() => onSelectDir(row.path)}
              onContextMenu={(ev) => onDirMenu(ev, row.path)}
            >
              <span className="file-tree-icon">{DIR_CHEV}</span>
              <span className="file-tree-name">{row.name}</span>
            </button>
          ) : (
            <button
              key={row.path}
              type="button"
              className={`file-tree-row${row.path === activeFilePath ? ' active' : ''}${row.ignored ? ' is-ignored' : ''}`}
              style={{ paddingLeft: 8 + row.depth * 14 }}
              title={row.path}
              data-testid="next-file-node"
              data-path={row.path}
              data-type="file"
              onClick={() => onSelectFile(row.path)}
            >
              <span className="file-tree-icon" />
              <span className="file-tree-name">{row.name}</span>
              {changed.has(row.path) ? <span className="file-tree-mod">M</span> : null}
            </button>
          )
        ))
      )}
      {treeTruncated ? (
        <div className="file-tree-empty" data-testid="next-file-tree-truncated">
          {t(lang, 'file_tree_truncated')}
        </div>
      ) : null}
    </>
  );
}

type TreePanelProps = {
  lang: Lang;
  workspaceLabel: string;
  treeReady: boolean;
  rows: ReturnType<typeof visibleTreeRows>;
  activeFilePath: string | null;
  changed: Set<string>;
  treeTruncated: boolean;
  onDirMenu: (ev: MouseEvent, dirPath: string) => void;
  onSelectDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResult: UseFileSearchResult;
};

function FileTreePanel({
  lang,
  workspaceLabel,
  treeReady,
  rows,
  activeFilePath,
  changed,
  treeTruncated,
  onDirMenu,
  onSelectDir,
  onSelectFile,
  searchQuery,
  setSearchQuery,
  searchResult,
}: TreePanelProps) {
  const isSearching = searchQuery.trim().length > 0;
  const { entries, truncated, loading, error } = searchResult;

  return (
    <>
      {workspaceLabel ? <div className="file-tree-root" title={workspaceLabel}>{workspaceLabel}</div> : null}
      <div className="file-tree-search-bar">
        <span className="file-tree-search-ic">{SEARCH_ICON}</span>
        <input
          type="text"
          className="file-tree-search-input"
          data-testid="next-file-tree-search-input"
          placeholder={t(lang, 'file_search_placeholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setSearchQuery('');
            }
          }}
        />
        {searchQuery ? (
          <button
            type="button"
            className="file-tree-search-clear"
            data-testid="next-file-tree-search-clear"
            onClick={() => setSearchQuery('')}
            aria-label={t(lang, 'btn_cancel')}
          >
            ✕
          </button>
        ) : null}
      </div>
      {isSearching ? (
        error ? (
          <div className="file-tree-empty file-search-error" data-testid="next-file-search-error">
            {t(lang, 'file_search_error')}
          </div>
        ) : !loading && entries.length === 0 ? (
          <div className="file-tree-empty file-search-empty" data-testid="next-file-search-empty">
            {t(lang, 'file_search_no_results')}
          </div>
        ) : (
          <>
            {entries.map((entry) => (
              <FileSearchResultRow
                key={entry.path}
                path={entry.path}
                query={searchQuery}
                active={entry.path === activeFilePath}
                onClick={() => onSelectFile(entry.path)}
              />
            ))}
            {truncated ? (
              <div className="file-tree-empty file-search-truncated" data-testid="next-file-search-truncated">
                {t(lang, 'file_search_truncated')}
              </div>
            ) : null}
          </>
        )
      ) : (
        <FileTreeRows
          lang={lang}
          workspaceLabel=""
          treeReady={treeReady}
          rows={rows}
          activeFilePath={activeFilePath}
          changed={changed}
          treeTruncated={treeTruncated}
          onDirMenu={onDirMenu}
          onSelectDir={onSelectDir}
          onSelectFile={onSelectFile}
        />
      )}
    </>
  );
}

export function FileBrowser({ lang, workspaceLabel }: { lang: Lang; workspaceLabel: string }) {
  const {
    workspaceId,
    tree,
    treeTruncated,
    treeReady,
    expandedDirs,
    toggleDirectory,
    activeFilePath,
  } = useRightFiles();
  const { visibleChanges } = useRightChanges();
  const { openFile, copyPath, openInTerminal } = useRightActions();

  const [treeQuery, setTreeQuery] = useState('');
  const searchResult = useFileSearch(workspaceId, treeQuery, { limit: 50 });

  const [treeWidth, setTreeWidth] = useState(() => readFileTreeWidth());
  const treeWidthRef = useRef(treeWidth);
  treeWidthRef.current = treeWidth;

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  const [dirMenu, setDirMenu] = useState<DirMenu | null>(null);
  const rows = treeReady ? visibleTreeRows(tree, expandedDirs) : [];
  const changed = new Set(visibleChanges.map((item) => item.path));

  const hasWorkspace = Boolean(workspaceId);

  useEffect(() => {
    if (!hasWorkspace) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [hasWorkspace]);

  const isNarrow = containerWidth != null && containerWidth < FILE_LAYOUT_MIN_TOTAL;

  useEffect(() => {
    if (!isNarrow && showDrawer) {
      setShowDrawer(false);
    }
  }, [isNarrow, showDrawer]);

  useEffect(() => {
    if (!showDrawer) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (treeQuery) {
          e.stopPropagation();
          setTreeQuery('');
          return;
        }
        e.stopPropagation();
        setShowDrawer(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [showDrawer, treeQuery]);

  useEffect(() => {
    if (!showDrawer) return;
    const onPointerDown = (e: globalThis.PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.file-tree-drawer') || target.closest('[data-testid=next-file-tree-toggle]')) {
        return;
      }
      setShowDrawer(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [showDrawer]);

  function onDirMenu(ev: MouseEvent, dirPath: string) {
    ev.preventDefault();
    ev.stopPropagation();
    setDirMenu({ x: ev.clientX, y: ev.clientY, path: dirPath });
  }

  const dirItems = (dirPath: string): CtxMenuItem[] => [
    { label: t(lang, 'copy_path'), action: 'copy-path', run: () => copyPath(dirPath) },
    {
      label: t(lang, 'open_in_terminal'),
      action: 'open-terminal',
      run: () => { void openInTerminal(dirPath); },
    },
  ];

  function onDividerMouseDown(ev: MouseEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const zoom = readUiZoom();
    setIsDragging(true);

    const onMouseMove = (e: globalThis.MouseEvent) => {
      const currentRect = container.getBoundingClientRect();
      const cssTargetW = (e.clientX - currentRect.left) / zoom;
      const contWidth = currentRect.width / zoom;
      const maxW = Math.max(FILE_TREE_W_MIN, contWidth - FILE_PREVIEW_W_MIN);
      const nextW = Math.round(Math.max(FILE_TREE_W_MIN, Math.min(maxW, cssTargetW)));
      setTreeWidth(nextW);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setIsDragging(false);
      writeFileTreeWidth(treeWidthRef.current);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  const maxAllowedTreeW = containerWidth != null
    ? Math.max(FILE_TREE_W_MIN, containerWidth - FILE_PREVIEW_W_MIN)
    : treeWidth;
  const effectiveTreeW = Math.max(FILE_TREE_W_MIN, Math.min(maxAllowedTreeW, treeWidth));

  if (!hasWorkspace) {
    return (
      <div className="pane-empty" data-testid="next-file-no-workspace">
        {t(lang, 'file_no_workspace')}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`file-browser${isNarrow ? ' is-narrow' : ''}${isDragging ? ' is-dragging' : ''}`}
    >
      {!isNarrow ? (
        <>
          <div
            className="file-tree"
            data-testid="next-file-tree"
            style={{ width: `${effectiveTreeW}px` }}
          >
            <FileTreePanel
              lang={lang}
              workspaceLabel={workspaceLabel}
              treeReady={treeReady}
              rows={rows}
              activeFilePath={activeFilePath}
              changed={changed}
              treeTruncated={treeTruncated}
              onDirMenu={onDirMenu}
              onSelectDir={(path) => toggleDirectory(path)}
              onSelectFile={(path) => openFile(path)}
              searchQuery={treeQuery}
              setSearchQuery={setTreeQuery}
              searchResult={searchResult}
            />
          </div>
          <div
            className="file-tree-divider"
            data-testid="next-file-tree-divider"
            title={t(lang, 'drag_resize')}
            onMouseDown={onDividerMouseDown}
            onDoubleClick={() => {
              setTreeWidth(FILE_TREE_W_DEFAULT);
              writeFileTreeWidth(FILE_TREE_W_DEFAULT);
            }}
          />
        </>
      ) : null}
      <div className="file-preview" data-testid="next-file-view">
        <FileEditorPane
          lang={lang}
          isNarrow={isNarrow}
          showDrawer={showDrawer}
          onToggleDrawer={() => setShowDrawer((v) => !v)}
        />
      </div>
      {isNarrow && showDrawer ? (
        <>
          <div
            className="file-tree-drawer-backdrop"
            onClick={() => setShowDrawer(false)}
          />
          <div
            ref={drawerRef}
            className="file-tree file-tree-drawer"
            data-testid="next-file-tree"
          >
            <FileTreePanel
              lang={lang}
              workspaceLabel={workspaceLabel}
              treeReady={treeReady}
              rows={rows}
              activeFilePath={activeFilePath}
              changed={changed}
              treeTruncated={treeTruncated}
              onDirMenu={onDirMenu}
              onSelectDir={(path) => toggleDirectory(path)}
              onSelectFile={(path) => {
                openFile(path);
                setShowDrawer(false);
              }}
              searchQuery={treeQuery}
              setSearchQuery={setTreeQuery}
              searchResult={searchResult}
            />
          </div>
        </>
      ) : null}
      {dirMenu ? (
        <CtxMenu
          x={dirMenu.x}
          y={dirMenu.y}
          title={dirMenu.path}
          items={dirItems(dirMenu.path)}
          onClose={() => setDirMenu(null)}
        />
      ) : null}
    </div>
  );
}
