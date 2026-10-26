import { useEffect, useRef } from 'react';
import type { Lang } from '../data/lang';
import { isMarkdownFile, useRightPane } from '../data/rightPaneContext';
import { visibleTreeRows } from '../data/fileTree';
import { t } from '../i18n';
import { Markdown } from './Markdown';

const DIR_CHEV = (
  <svg className="ws-chev" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 3l3 3-3 3" />
  </svg>
);

function FileLines({
  text,
  targetLine,
}: {
  text: string;
  targetLine: number | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const lines = text.split('\n');
  useEffect(() => {
    if (targetLine == null) return;
    root.current?.querySelector('.file-line.is-target')?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [targetLine, text]);
  return (
    <div className="file-lines file-view-content" ref={root}>
      {lines.map((line, i) => (
        <div
          key={i}
          className={`file-line${targetLine === i + 1 ? ' is-target' : ''}`}
          data-line={i + 1}
        >
          <span className="n">{i + 1}</span>
          <span className="code">{line}</span>
        </div>
      ))}
    </div>
  );
}

function FilePreview({ lang }: { lang: Lang }) {
  const { file, activeFilePath, fileTargetLine, visibleChanges } = useRightPane();
  if (!activeFilePath || !file) {
    return <div className="file-preview-empty">{t(lang, 'select_file_to_preview')}</div>;
  }
  if (file.tooLarge) {
    return <div className="file-preview-empty">{activeFilePath} — {t(lang, 'file_too_large')}</div>;
  }
  if (file.binary || file.text == null) {
    return <div className="file-preview-empty">{activeFilePath} — {t(lang, 'file_binary')}</div>;
  }
  const lines = file.text.split('\n');
  const changed = visibleChanges.some((item) => item.path === activeFilePath);
  return (
    <>
      <div className="file-preview-head">
        <span>{activeFilePath}</span>
        <span>{changed ? t(lang, 'file_modified_note') : t(lang, 'file_lines', { n: lines.length })}</span>
      </div>
      <FileLines text={file.text} targetLine={fileTargetLine} />
    </>
  );
}

function FileEditor({ lang }: { lang: Lang }) {
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
  } = useRightPane();
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        void saveFile();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveFile]);

  if (!activeFilePath || !file) {
    return <div className="file-preview-empty">{t(lang, 'select_file_to_preview')}</div>;
  }
  if (file.tooLarge) {
    return <div className="file-preview-empty">{activeFilePath} — {t(lang, 'file_too_large')}</div>;
  }
  if (file.binary || file.text == null) {
    return <div className="file-preview-empty">{activeFilePath} — {t(lang, 'file_binary')}</div>;
  }

  return (
    <div className="md-editor-container" data-testid="next-file-editor">
      <div className="md-editor-toolbar">
        <span className="path">{activeFilePath}</span>
        <div className="md-editor-actions">
          {editorMode === 'edit' ? (
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
          )}
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
      {editorMode === 'edit' ? (
        <textarea
          ref={area}
          className="md-editor-content"
          spellCheck={false}
          value={draftText}
          onChange={(ev) => setDraftText(ev.target.value)}
        />
      ) : (
        <div className="md-editor-preview">
          <Markdown text={draftText} copyLabel={t(lang, 'copy_code')} copiedLabel={t(lang, 'copied')} />
        </div>
      )}
    </div>
  );
}

export function FileBrowser({ lang, workspaceLabel }: { lang: Lang; workspaceLabel: string }) {
  const {
    tree,
    treeTruncated,
    treeReady,
    expandedDirs,
    toggleDirectory,
    openFile,
    activeFilePath,
    visibleChanges,
  } = useRightPane();
  const rows = treeReady ? visibleTreeRows(tree, expandedDirs) : [];
  const changed = new Set(visibleChanges.map((item) => item.path));
  const md = isMarkdownFile(activeFilePath);

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
        {md ? <FileEditor lang={lang} /> : <FilePreview lang={lang} />}
      </div>
    </div>
  );
}
