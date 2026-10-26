import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  ApiError,
  getConversationDiff,
  getWorkspaceFile,
  getWorkspaceTree,
  isConflictError,
  saveWorkspaceFile,
  type Diff,
  type FileContent,
  type FileNode,
} from './api';
import { copyText } from './copyText';
import { changeHasDiff, changeSignature, diffTotals } from './diffView';
import { IDLE_SAVE, saveReducer, type SaveState } from './fileConflict';
import { defaultExpanded, dirPaths, expandAncestors, isMarkdownPath, toggleDir } from './fileTree';
import type { Lang } from './lang';
import {
  defaultRightOpen,
  persistRightOpen,
  readRightTab,
  readRightWidth,
  writeRightTab,
  writeRightWidth,
  type RightTab,
} from './layout';
import { useSession } from './session';
import type { Change, ToolCall } from './store';
import { t } from '../i18n';

const TREE_KINDS = new Set<ToolCall['kind']>(['write', 'edit', 'bash']);
const TREE_REFRESH_MS = 300;

export type RightPaneValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  tab: RightTab;
  setTab: (tab: RightTab) => void;
  width: number;
  setWidth: (width: number) => void;
  persistWidth: (width: number) => void;
  hasChanges: boolean;
  totals: { added: number; removed: number };
  visibleChanges: Change[];
  openPaths: Set<string>;
  toggleChange: (path: string) => void;
  diffs: Record<string, Diff | 'loading' | 'error'>;
  openFile: (path: string, line?: number) => void;
  openChangeDiff: (path: string) => void;
  showFiles: () => void;
  tree: FileNode[];
  treeTruncated: boolean;
  treeReady: boolean;
  expandedDirs: Set<string>;
  toggleDirectory: (path: string) => void;
  activeFilePath: string | null;
  fileTargetLine: number | null;
  file: FileContent | null;
  fileBusy: boolean;
  editorMode: 'preview' | 'edit';
  setEditorMode: (mode: 'preview' | 'edit') => void;
  draftText: string;
  setDraftText: (text: string) => void;
  saveState: SaveState;
  saveFile: (overwrite?: boolean) => Promise<void>;
  reloadFile: () => Promise<void>;
  copyPath: (path: string) => void;
};

const RightPaneContext = createContext<RightPaneValue | null>(null);

function toolDoneKey(tools: Record<string, ToolCall>): string {
  return Object.values(tools)
    .filter((tool) => tool.status === 'done' && TREE_KINDS.has(tool.kind))
    .map((tool) => tool.id)
    .sort()
    .join('\n');
}

type Props = {
  conversationId: string | null;
  workspaceId: string | null;
  lang: Lang;
  onToast: (message: string) => void;
  children: ReactNode;
};

export function RightPaneProvider({
  conversationId,
  workspaceId,
  lang,
  onToast,
  children,
}: Props) {
  const { store } = useSession();
  useSyncExternalStore(store.subscribe, store.getVersion);

  const [open, setOpenState] = useState(() => defaultRightOpen(window.innerWidth));
  const [tab, setTabState] = useState<RightTab>(() => readRightTab());
  const [width, setWidth] = useState(() => readRightWidth());
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set());
  const [diffs, setDiffs] = useState<Record<string, Diff | 'loading' | 'error'>>({});
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [treeReady, setTreeReady] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [fileTargetLine, setFileTargetLine] = useState<number | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [editorMode, setEditorMode] = useState<'preview' | 'edit'>('preview');
  const [draftText, setDraftText] = useState('');
  const [saveState, setSaveState] = useState<SaveState>(IDLE_SAVE);

  const cid = conversationId || '';
  const wsId = workspaceId || '';
  const changes = cid ? store.changes(cid) : [];
  const toolsById = cid ? store.toolsById(cid) : {};
  const visibleChanges = useMemo(() => changes.filter(changeHasDiff), [changes]);
  const totals = useMemo(() => diffTotals(visibleChanges), [visibleChanges]);
  const hasChanges = visibleChanges.length > 0;

  const openRef = useRef(openPaths);
  openRef.current = openPaths;
  const diffsRef = useRef(diffs);
  diffsRef.current = diffs;
  const sigRef = useRef<Record<string, string>>({});
  const treeWsRef = useRef<string | null>(null);
  const treeDirsRef = useRef<Set<string>>(new Set());
  const treeTimer = useRef<number | null>(null);
  const treeGen = useRef(0);
  const fileGen = useRef(0);
  const seenDone = useRef('');
  const activePathRef = useRef(activeFilePath);
  activePathRef.current = activeFilePath;
  const versionRef = useRef<string | null>(null);
  const draftRef = useRef(draftText);
  draftRef.current = draftText;

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    persistRightOpen(next, window.innerWidth);
  }, []);

  const setTab = useCallback((next: RightTab) => {
    setTabState(next);
    writeRightTab(next);
    setOpen(true);
  }, [setOpen]);

  const persistWidth = useCallback((next: number) => {
    writeRightWidth(next);
  }, []);

  const loadTree = useCallback(async (wid: string) => {
    if (!wid) {
      treeGen.current += 1;
      setTree([]);
      setTreeTruncated(false);
      setTreeReady(true);
      treeWsRef.current = null;
      return;
    }
    const gen = ++treeGen.current;
    try {
      const data = await getWorkspaceTree(wid);
      if (gen !== treeGen.current) return;
      treeWsRef.current = wid;
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const dirs = new Set(dirPaths(entries));
      setTree(entries);
      setTreeTruncated(Boolean(data.truncated));
      setExpandedDirs((prev) => {
        if (prev.size === 0) return defaultExpanded(entries);
        const next = new Set(prev);
        for (const dir of dirs) {
          if (!treeDirsRef.current.has(dir)) next.add(dir);
        }
        return next;
      });
      treeDirsRef.current = dirs;
      setTreeReady(true);
    } catch {
      if (gen !== treeGen.current) return;
      treeWsRef.current = wid;
      setTree([]);
      setTreeTruncated(false);
      setTreeReady(true);
    }
  }, []);

  const scheduleTreeRefresh = useCallback((wid: string) => {
    if (!wid) return;
    if (treeTimer.current) window.clearTimeout(treeTimer.current);
    treeTimer.current = window.setTimeout(() => {
      treeTimer.current = null;
      void loadTree(wid);
    }, TREE_REFRESH_MS);
  }, [loadTree]);

  useEffect(() => {
    treeGen.current += 1;
    treeWsRef.current = null;
    treeDirsRef.current = new Set();
    setTree([]);
    setTreeTruncated(false);
    setTreeReady(false);
    setExpandedDirs(new Set());
    setActiveFilePath(null);
    setFile(null);
    setDraftText('');
    setFileTargetLine(null);
    setSaveState(IDLE_SAVE);
    versionRef.current = null;
    if (tab === 'files' && wsId) void loadTree(wsId);
  }, [wsId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setOpenPaths(new Set());
    setDiffs({});
    sigRef.current = {};
    seenDone.current = '';
  }, [cid]);

  useEffect(() => {
    if (tab !== 'files' || !wsId) return;
    if (treeWsRef.current === wsId && treeReady) return;
    void loadTree(wsId);
  }, [tab, wsId, treeReady, loadTree]);

  useEffect(() => {
    if (!cid || !wsId) return;
    const key = toolDoneKey(toolsById);
    if (!key) {
      seenDone.current = key;
      return;
    }
    if (key === seenDone.current) return;
    const prev = new Set(seenDone.current ? seenDone.current.split('\n') : []);
    const next = new Set(key.split('\n'));
    seenDone.current = key;
    let added = false;
    for (const id of next) {
      if (!prev.has(id)) added = true;
    }
    if (added) scheduleTreeRefresh(wsId);
  }, [cid, wsId, toolsById, scheduleTreeRefresh]);

  const loadDiff = useCallback(async (path: string, sig: string) => {
    if (!cid) return;
    sigRef.current[path] = sig;
    setDiffs((prev) => ({ ...prev, [path]: 'loading' }));
    try {
      const diff = await getConversationDiff(cid, path);
      if (sigRef.current[path] !== sig) return;
      setDiffs((prev) => ({ ...prev, [path]: diff }));
    } catch {
      if (sigRef.current[path] !== sig) return;
      setDiffs((prev) => ({ ...prev, [path]: 'error' }));
    }
  }, [cid]);

  useEffect(() => {
    if (!cid || tab !== 'changes') return;
    for (const change of visibleChanges) {
      if (!openRef.current.has(change.path)) continue;
      const sig = changeSignature(change);
      if (sigRef.current[change.path] === sig && diffsRef.current[change.path]
        && diffsRef.current[change.path] !== 'loading') continue;
      void loadDiff(change.path, sig);
    }
  }, [cid, tab, visibleChanges, loadDiff, openPaths]);

  const toggleChange = useCallback((path: string) => {
    setTab('changes');
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, [setTab]);

  const loadFile = useCallback(async (path: string, line?: number, opts?: { preserveEditor?: boolean }) => {
    if (!wsId) {
      onToast(t(lang, 'file_cannot_open'));
      return;
    }
    const gen = ++fileGen.current;
    setFileBusy(true);
    try {
      const content = await getWorkspaceFile(wsId, path);
      if (gen !== fileGen.current) return;
      setActiveFilePath(path);
      setFile(content);
      setDraftText(content.text ?? '');
      versionRef.current = content.version;
      if (!opts?.preserveEditor) setEditorMode('preview');
      setSaveState(IDLE_SAVE);
      setFileTargetLine(line != null && line >= 1 ? line : null);
      setExpandedDirs((prev) => expandAncestors(prev.size ? prev : defaultExpanded([]), path));
    } catch (err) {
      if (gen !== fileGen.current) return;
      if (err instanceof ApiError && (err.status === 403 || err.status === 404 || err.code === 'E_SANDBOX')) {
        onToast(t(lang, 'file_cannot_open'));
        return;
      }
      onToast(err instanceof Error ? err.message : t(lang, 'file_cannot_open'));
    } finally {
      if (gen === fileGen.current) setFileBusy(false);
    }
  }, [wsId, lang, onToast]);

  const openFile = useCallback((path: string, line?: number) => {
    setTab('files');
    void loadFile(path, line);
  }, [setTab, loadFile]);

  const openChangeDiff = useCallback((path: string) => {
    if (!path) return;
    setTab('changes');
    setOpenPaths((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, [setTab]);

  const showFiles = useCallback(() => {
    setTab('files');
    if (wsId) void loadTree(wsId);
  }, [setTab, wsId, loadTree]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedDirs((prev) => toggleDir(prev, path));
  }, []);

  const saveFile = useCallback(async (overwrite = false) => {
    if (!wsId || !activePathRef.current) return;
    const path = activePathRef.current;
    setSaveState((prev) => saveReducer(prev, { type: overwrite ? 'overwrite' : 'start' }));
    try {
      const text = draftRef.current;
      const body: { path: string; text: string; baseVersion?: string } = { path, text };
      if (!overwrite && versionRef.current) body.baseVersion = versionRef.current;
      const result = await saveWorkspaceFile(wsId, body);
      versionRef.current = result.version;
      setFile((prev) => (prev && prev.path === path
        ? { ...prev, text, version: result.version }
        : prev));
      setSaveState((prev) => saveReducer(prev, { type: 'success' }));
      onToast(t(lang, 'btn_saved'));
    } catch (err) {
      if (isConflictError(err)) {
        setSaveState((prev) => saveReducer(prev, { type: 'conflict', current: err.current }));
        return;
      }
      setSaveState((prev) => saveReducer(prev, {
        type: 'error',
        message: err instanceof Error ? err.message : t(lang, 'file_cannot_open'),
      }));
      onToast(err instanceof Error ? err.message : t(lang, 'file_cannot_open'));
    }
  }, [wsId, lang, onToast]);

  const reloadFile = useCallback(async () => {
    const path = activePathRef.current;
    setSaveState((prev) => saveReducer(prev, { type: 'reload' }));
    if (path) await loadFile(path, undefined, { preserveEditor: true });
  }, [loadFile]);

  const copyPath = useCallback((path: string) => {
    void copyText(path).then((ok) => onToast(t(lang, ok ? 'copied' : 'err_copy')));
  }, [lang, onToast]);

  const value = useMemo<RightPaneValue>(() => ({
    open,
    setOpen,
    tab,
    setTab,
    width,
    setWidth,
    persistWidth,
    hasChanges,
    totals,
    visibleChanges,
    openPaths,
    toggleChange,
    diffs,
    openFile,
    openChangeDiff,
    showFiles,
    tree,
    treeTruncated,
    treeReady,
    expandedDirs,
    toggleDirectory,
    activeFilePath,
    fileTargetLine,
    file,
    fileBusy,
    editorMode,
    setEditorMode,
    draftText,
    setDraftText,
    saveState,
    saveFile,
    reloadFile,
    copyPath,
  }), [
    open, setOpen, tab, setTab, width, persistWidth, hasChanges, totals, visibleChanges,
    openPaths, toggleChange, diffs, openFile, openChangeDiff, showFiles, tree, treeTruncated,
    treeReady, expandedDirs, toggleDirectory, activeFilePath, fileTargetLine, file, fileBusy,
    editorMode, draftText, saveState, saveFile, reloadFile, copyPath,
  ]);

  return <RightPaneContext.Provider value={value}>{children}</RightPaneContext.Provider>;
}

export function useRightPane(): RightPaneValue {
  const value = useContext(RightPaneContext);
  if (!value) throw new Error('useRightPane requires RightPaneProvider');
  return value;
}

export function isMarkdownFile(path: string | null | undefined): boolean {
  return Boolean(path && isMarkdownPath(path));
}
