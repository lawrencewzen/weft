import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  getConversationDiff,
  getWorkspaceFile,
  getWorkspaceTree,
  isConflictError,
  openWorkspaceTerminal,
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
  isRightOverlayWidth,
  persistRightOpen,
  readRightTab,
  readRightWidth,
  writeRightTab,
  writeRightWidth,
  type RightTab,
} from './layout';
import { useSession } from './session';
import { conversationTopic, type Change, type ToolCall } from './store';
import { useStoreTopics } from './useStoreTopic';
import { t } from '../i18n';

const TREE_KINDS = new Set<ToolCall['kind']>(['write', 'edit', 'bash']);
const TREE_REFRESH_MS = 300;

export type RightPaneValue = {
  conversationId: string | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRight: () => void;
  rightOpening: boolean;
  rbDx: number;
  rbAnim: boolean;
  rbTr: string;
  rightBtnOp: number;
  rightBtnPe: 'auto' | 'none';
  rpBtnOp: number;
  tab: RightTab;
  setTab: (tab: RightTab) => void;
  selectedSubagentId: string | null;
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
  openTerminal: (toolId?: string) => void;
  selectedCommandId: string | null;
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
  openInTerminal: (relPath?: string, targetWorkspaceId?: string) => Promise<void>;
  onToast: (message: string) => void;
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
  agentId?: string | null;
  workspaceId: string | null;
  lang: Lang;
  onToast: (message: string) => void;
  children?: ReactNode;
};

export function RightPaneProvider({
  conversationId,
  agentId = null,
  workspaceId,
  lang,
  onToast,
  children,
}: Props) {
  const { store } = useSession();
  const cid = conversationId || '';
  const rightPaneTopics = useMemo(() => (
    cid ? [`${conversationTopic(cid)}#change`, `${conversationTopic(cid)}#tool`] : []
  ), [cid]);
  const storeVersion = useStoreTopics(store, rightPaneTopics);

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
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);

  const wsId = workspaceId || '';
  const changes = useMemo(
    () => (cid ? store.changes(cid) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store is stable; storeVersion tracks writes
    [store, cid, storeVersion],
  );
  const toolsById = useMemo(
    () => (cid ? store.toolsById(cid) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store is stable; storeVersion tracks writes
    [store, cid, storeVersion],
  );
  const visibleChanges = useMemo(() => changes.filter(changeHasDiff), [changes]);
  const totals = useMemo(() => diffTotals(visibleChanges), [visibleChanges]);
  const hasChanges = visibleChanges.length > 0;

  const openRef = useRef(openPaths);
  openRef.current = openPaths;
  const diffsRef = useRef(diffs);
  diffsRef.current = diffs;
  const sigRef = useRef<Record<string, string>>({});
  /** path → signature of the diff request currently in flight. */
  const inflightDiffs = useRef<Map<string, string>>(new Map());
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

  const [rightOpening, setRightOpening] = useState(false);
  const [rbDx, setRbDx] = useState(0);
  const [rbAnim, setRbAnim] = useState(false);
  const rbDxRef = useRef(0);
  const rightTimer = useRef<number | null>(null);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    setRightOpening(false);
    setRbAnim(false);
    setRbDx(0);
    persistRightOpen(next, typeof window !== 'undefined' ? window.innerWidth : 1440);
  }, []);

  const toggleRight = useCallback(() => {
    if (typeof window !== 'undefined' && isRightOverlayWidth(window.innerWidth)) {
      setOpen(!open);
      return;
    }
    const closing = open;
    if (closing) {
      const rb = document.querySelector<HTMLElement>('[data-testid="next-right-collapse"]')
        || document.querySelector<HTMLElement>('aside [title="收起右栏"]');
      const hb = document.querySelector<HTMLElement>('[data-testid="next-right-toggle"]')
        || document.querySelector<HTMLElement>('[title="展开右栏"]');
      if (rb && hb) {
        rbDxRef.current = Math.round(rb.getBoundingClientRect().left - (hb.getBoundingClientRect().left - (rbDxRef.current || 0)));
      }
    }
    const dx = rbDxRef.current || 50;
    if (closing) {
      setOpenState(false);
      persistRightOpen(false, typeof window !== 'undefined' ? window.innerWidth : 1440);
      setRightOpening(false);
      setRbAnim(false);
      setRbDx(dx);
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            setRbAnim(true);
            setRbDx(0);
          });
        });
      }
    } else {
      setOpenState(true);
      persistRightOpen(true, typeof window !== 'undefined' ? window.innerWidth : 1440);
      setRightOpening(true);
      setRbAnim(true);
      setRbDx(dx);
    }
    if (rightTimer.current) window.clearTimeout(rightTimer.current);
    rightTimer.current = window.setTimeout(() => {
      if (!closing) {
        setRightOpening(false);
      }
    }, 230);
  }, [open, setOpen]);

  const setTab = useCallback((next: RightTab) => {
    setTabState(next);
    writeRightTab(next);
    setOpen(true);
  }, [setOpen]);

  const selectedSubagentId = agentId || null;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only runs on workspaceId change; tab is read imperatively to avoid resetting state on tab switch
  }, [wsId]);

  const seenChangePaths = useRef<Set<string>>(new Set());

  useEffect(() => {
    seenChangePaths.current = new Set();
    setOpenPaths(new Set());
    setDiffs({});
    sigRef.current = {};
    seenDone.current = '';
    setSelectedCommandId(null);
  }, [cid]);

  useEffect(() => {
    if (!cid || visibleChanges.length === 0) return;
    const newChanges = visibleChanges.filter((c) => !seenChangePaths.current.has(c.path));
    if (newChanges.length === 0) return;

    for (const c of newChanges) {
      seenChangePaths.current.add(c.path);
    }

    // 超过 8 个文件或单文件超过 300 行的默认收起，避免卡顿
    if (visibleChanges.length > 8) return;

    const toExpand = newChanges
      .filter((c) => (c.added + c.removed) <= 300)
      .map((c) => c.path);

    if (toExpand.length > 0) {
      setOpenPaths((prev) => {
        const next = new Set(prev);
        for (const p of toExpand) next.add(p);
        return next;
      });
    }
  }, [cid, visibleChanges]);

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
      // One request per path+signature: a fast answer (or a loading state that
      // triggers another render) must not start the same request again.
      if (inflightDiffs.current.get(change.path) === sig) continue;
      inflightDiffs.current.set(change.path, sig);
      void loadDiff(change.path, sig).finally(() => {
        if (inflightDiffs.current.get(change.path) === sig) inflightDiffs.current.delete(change.path);
      });
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

  const openTerminal = useCallback((toolId?: string) => {
    if (toolId) setSelectedCommandId(toolId);
    setTab('term');
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

  const openInTerminal = useCallback(async (relPath?: string, targetWorkspaceId?: string) => {
    const id = targetWorkspaceId || wsId;
    if (!id) {
      onToast(t(lang, 'open_terminal_fail'));
      return;
    }
    try {
      const result = await openWorkspaceTerminal(id, relPath);
      onToast(result.message || t(lang, 'open_terminal_ok'));
    } catch (err) {
      onToast(err instanceof Error ? err.message : t(lang, 'open_terminal_fail'));
    }
  }, [wsId, lang, onToast]);

  const isRightOverlay = typeof window !== 'undefined' ? isRightOverlayWidth(window.innerWidth) : false;
  const rightBtnOp = !open || rightOpening || isRightOverlay ? 1 : 0;
  const rightBtnPe: 'auto' | 'none' = (!open || isRightOverlay) ? 'auto' : 'none';
  const rpBtnOp = open && (!rightOpening || isRightOverlay) ? 1 : 0;
  const rbTr = rbAnim ? 'transform .22s cubic-bezier(.3,.8,.3,1)' : 'none';

  const value = useMemo<RightPaneValue>(() => ({
    conversationId: cid || null,
    open,
    setOpen,
    toggleRight,
    rightOpening,
    rbDx,
    rbAnim,
    rbTr,
    rightBtnOp,
    rightBtnPe,
    rpBtnOp,
    tab,
    setTab,
    selectedSubagentId,
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
    openTerminal,
    selectedCommandId,
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
    openInTerminal,
    onToast,
  }), [
    cid,
    open, setOpen, toggleRight, rightOpening, rbDx, rbAnim, rbTr, rightBtnOp, rightBtnPe, rpBtnOp,
    tab, setTab, selectedSubagentId, width, persistWidth, hasChanges, totals, visibleChanges,
    openPaths, toggleChange, diffs, openFile, openChangeDiff, openTerminal, selectedCommandId, showFiles, tree, treeTruncated,
    treeReady, expandedDirs, toggleDirectory, activeFilePath, fileTargetLine, file, fileBusy,
    editorMode, draftText, saveState, saveFile, reloadFile, copyPath, openInTerminal, onToast,
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
