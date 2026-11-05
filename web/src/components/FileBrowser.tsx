import { useState, type MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import { isMarkdownFile, useRightActions, useRightChanges, useRightFiles } from '../data/rightPaneContext';
import { visibleTreeRows } from '../data/fileTree';
import { t } from '../i18n';
import { CodeEditor } from './CodeEditor';
import { CtxMenu, type CtxMenuItem } from './CtxMenu';
import { Markdown } from './Markdown';

const DIR_CHEV = (
  <svg className="ws-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 3l3 3-3 3" />
  </svg>
);

function FileEditorPane({ lang }: { lang: Lang }) {
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

  if (!activeFilePath || !file) {
    return <div className="file-preview-empty">{t(lang, 'select_file_to_preview')}</div>;
  }
  if (file.tooLarge) {
    return <div className="file-preview-empty">{activeFilePath} — {t(lang, 'file_too_large')}</div>;
  }
  if (file.binary || file.text == null) {
    return <div className="file-preview-empty">{activeFilePath} — {t(lang, 'file_binary')}</div>;
  }

  const isMd = isMarkdownFile(activeFilePath);
  const isDirty = draftText !== (file.text ?? '');
  const lineCount = draftText.length === 0 ? 1 : draftText.split('\n').length;

  return (
    <div className="md-editor-container code-editor-wrapper" data-testid="next-file-editor">
      <div className="md-editor-toolbar file-preview-head">
        <div className="file-toolbar-left">
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

export function FileBrowser({ lang, workspaceLabel }: { lang: Lang; workspaceLabel: string }) {
  const {
    tree,
    treeTruncated,
    treeReady,
    expandedDirs,
    toggleDirectory,
    activeFilePath,
  } = useRightFiles();
  const { visibleChanges } = useRightChanges();
  const { openFile, copyPath, openInTerminal } = useRightActions();
  const [dirMenu, setDirMenu] = useState<DirMenu | null>(null);
  const rows = treeReady ? visibleTreeRows(tree, expandedDirs) : [];
  const changed = new Set(visibleChanges.map((item) => item.path));

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

  return (
    <div className="file-browser">
      <div className="file-tree" data-testid="next-file-tree">
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
                className={`file-tree-row is-dir${row.expanded ? ' is-open' : ''}`}
                style={{ paddingLeft: 8 + row.depth * 14 }}
                title={row.path}
                data-testid="next-file-node"
                data-path={row.path}
                data-type="dir"
                onClick={() => toggleDirectory(row.path)}
                onContextMenu={(ev) => onDirMenu(ev, row.path)}
              >
                <span className="file-tree-icon">{DIR_CHEV}</span>
                <span className="file-tree-name">{row.name}</span>
              </button>
            ) : (
              <button
                key={row.path}
                type="button"
                className={`file-tree-row${row.path === activeFilePath ? ' active' : ''}`}
                style={{ paddingLeft: 8 + row.depth * 14 }}
                title={row.path}
                data-testid="next-file-node"
                data-path={row.path}
                data-type="file"
                onClick={() => openFile(row.path)}
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
      </div>
      <div className="file-preview" data-testid="next-file-view">
        <FileEditorPane lang={lang} />
      </div>
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
