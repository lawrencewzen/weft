import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { getWorkspaceTree, patchConversationModel, putModelContextWindow } from '../data/api';
import {
  addImages,
  applyAtSelection,
  filePathOf,
  fileToImageAttachment,
  filterAtFiles,
  formatFileSize,
  IMAGE_MAX_COUNT,
  imageFingerprint,
  insertFileRef,
  isFileRefInText,
  isImageFile,
  matchAtTrigger,
  matchProjectPath,
  pathsFromUriList,
  removeFileRef,
  resolveAtSelection,
  revokePreview,
  shouldResetAtActiveIndex,
  splitFilePath,
  stepAtActiveIndex,
  toMessageImages,
  type ComposerHint,
  type FileRefAttachment,
  type ImageAttachment,
  type MessageImage,
} from '../data/attachments';
import {
  contextIsWarn,
  groupComposerModels,
  hasAvailableModels,
  resolveComposerSelection,
  type ComposerModelOption,
  type ConversationModel,
  type ContextUsage,
  type ResolvedModel,
} from '../data/composerModel';
import { formatComposerGitTitle, type GitStatus } from '../data/gitBar';
import type { Lang } from '../data/lang';
import { draftPath, navigate, openSettings } from '../data/nav';
import type { QueueChip, SendMode } from '../data/pendingSend';
import { useProviders } from '../data/useProviders';
import { useWorkspaces } from '../data/useWorkspaces';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { writeActiveWorkspace } from '../data/layout';
import { useRightPane } from '../data/rightPaneContext';
import { ContextBanner, ContextChip } from './ContextChip';
import { DemoModelBadge } from './DemoModelBadge';
import { ModelChip } from './ModelChip';
import { WorkspaceChip } from './WorkspaceChip';
import { createSendRequest, errorMessage } from './sendRequest';

type RunState = components['schemas']['RunState'];

type Props = {
  lang: Lang;
  run: RunState;
  demo?: boolean;
  conversationId?: string | null;
  workspaceId?: string | null;
  workspacePath?: string | null;
  model?: ConversationModel | null;
  context?: ContextUsage;
  isDraft?: boolean;
  draftModel?: ResolvedModel | null;
  onDraftModel?: (model: ResolvedModel) => void;
  showModelControls?: boolean;
  onNewWorkspace?: () => void;
  onSend: (text: string, requestId: string, images?: MessageImage[], mode?: SendMode) => Promise<unknown>;
  onStop: () => Promise<unknown>;
  onSent?: () => void;
  queue?: QueueChip[];
  onWithdrawQueue?: (requestId: string) => Promise<unknown>;
  git?: GitStatus | null;
};

const FALLBACK_CONTEXT: ContextUsage = { used: 0, window: 128000, percent: 0, level: 'ok' };

const TEXTAREA_MIN = 44;
const TEXTAREA_MAX = 200;

const PLUS_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const SEND_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);
const STOP_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="3" />
  </svg>
);
const DROP_ICON = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </svg>
);

const GIT_BRANCH_ICON = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="4" cy="3.5" r="1.6" />
    <circle cx="4" cy="12.5" r="1.6" />
    <circle cx="12" cy="5" r="1.6" />
    <path d="M4 5v6M12 6.6c0 3-4 2.2-8 4.4" />
  </svg>
);

const PLUS_IMAGE_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="M21 16l-5-5-8 8" />
  </svg>
);

const PLUS_AT_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" />
  </svg>
);

const FILE_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

const AT_MENU_FILE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

function hintText(lang: Lang, hint: ComposerHint): string {
  if (hint.kind === 'too_large') return t(lang, 'attach_too_large', { name: hint.name || '' });
  if (hint.kind === 'too_many') return t(lang, 'attach_too_many', { n: IMAGE_MAX_COUNT });
  if (hint.kind === 'bad_type') return t(lang, 'attach_bad_type', { name: hint.name || '' });
  if (hint.kind === 'no_vision') return t(lang, 'attach_no_vision');
  return t(lang, 'attach_outside', { name: hint.name || '' });
}

export function Composer({
  lang,
  run,
  demo = false,
  conversationId = null,
  workspaceId = null,
  workspacePath = null,
  model = null,
  context = FALLBACK_CONTEXT,
  isDraft = false,
  draftModel = null,
  onDraftModel,
  showModelControls = true,
  onNewWorkspace,
  onSend,
  onStop,
  onSent,
  queue = [],
  onWithdrawQueue,
  git: propGit,
}: Props) {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [fileRefs, setFileRefs] = useState<FileRefAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<ComposerHint | null>(null);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const atActiveIndexRef = useRef(0);
  atActiveIndexRef.current = atActiveIndex;
  const prevQueryRef = useRef<string | null>(null);
  const prevOpenRef = useRef(false);
  const [atDismissed, setAtDismissed] = useState(false);
  const [treeCache, setTreeCache] = useState<Record<string, { files: string[]; error: boolean }>>({});
  const [cursorPos, setCursorPos] = useState<number | null>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const atMenuRef = useRef<HTMLDivElement>(null);
  const req = useRef(createSendRequest());
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const { providers, defaultModel, ready: providersReady } = useProviders();
  const { openInTerminal, copyPath } = useRightPane();
  const { workspaces } = useWorkspaces();
  const currentWorkspace = workspaces.find((ws) => ws.id === workspaceId) || null;
  const git = propGit !== undefined ? propGit : (currentWorkspace?.git ?? null);
  const totalDiff = (git?.insertions || 0) + (git?.deletions || 0);
  const hasDiff = totalDiff > 0;
  const groups = useMemo(() => groupComposerModels(providers, defaultModel), [providers, defaultModel]);
  const available = hasAvailableModels(providers);
  const selected = useMemo(() => resolveComposerSelection({
    providers,
    conversationModel: model,
    defaultModel,
    draft: draftModel,
    isDraft,
  }), [providers, model, defaultModel, draftModel, isDraft]);
  const noModel = showModelControls && !demo && providersReady && !available;
  const noWorkspace = isDraft && !workspaceId;
  const locked = !run.canSend || noModel || noWorkspace;
  const allowAttach = showModelControls && !noModel;
  const supportsImages = demo || selected?.images === true;

  const activeCursor = cursorPos !== null
    ? Math.min(cursorPos, draft.length)
    : (area.current?.selectionStart ?? draft.length);
  const atTrigger = useMemo(() => {
    return matchAtTrigger(draft, activeCursor);
  }, [draft, activeCursor]);

  const atOpen = Boolean(atTrigger && focused && !locked && !atDismissed);

  useEffect(() => {
    if (!atTrigger) {
      setAtDismissed(false);
    }
  }, [atTrigger]);

  useEffect(() => {
    if (!atOpen || !workspaceId) return;
    if (treeCache[workspaceId]) return;
    let cancelled = false;
    void (async () => {
      try {
        const tree = await getWorkspaceTree(workspaceId);
        if (cancelled) return;
        const files = tree.entries.filter((e) => e.type === 'file').map((e) => e.path);
        setTreeCache((prev) => ({ ...prev, [workspaceId]: { files, error: false } }));
      } catch {
        if (cancelled) return;
        setTreeCache((prev) => ({ ...prev, [workspaceId]: { files: [], error: true } }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [atOpen, workspaceId, treeCache]);

  const cachedTree = workspaceId ? treeCache[workspaceId] : null;
  const treeFiles = cachedTree?.files || [];
  const treeError = Boolean(cachedTree?.error);
  const treeLoading = atOpen && Boolean(workspaceId && !cachedTree);

  const matchedFiles = useMemo(() => {
    if (!atTrigger || treeError) return [];
    return filterAtFiles(treeFiles, atTrigger.query, 6);
  }, [atTrigger, treeError, treeFiles]);

  useEffect(() => {
    if (atOpen) {
      const currentQuery = atTrigger?.query ?? '';
      const isOpening = !prevOpenRef.current;
      if (shouldResetAtActiveIndex(prevQueryRef.current, currentQuery, isOpening)) {
        atActiveIndexRef.current = 0;
        setAtActiveIndex(0);
      }
      prevQueryRef.current = currentQuery;
    } else {
      prevQueryRef.current = null;
    }
    prevOpenRef.current = atOpen;
  }, [atOpen, atTrigger?.query]);

  // Sync file tags with text: if @path is removed or edited in draft, hide the tag
  const visibleFileRefs = useMemo(() => {
    return fileRefs.filter((ref) => isFileRefInText(draft, ref.path));
  }, [fileRefs, draft]);

  const hasPayload = Boolean(draft.trim()) || images.length > 0 || visibleFileRefs.length > 0;
  const canSend = hasPayload && !locked;
  const stopMode = run.canStop && !hasPayload;
  const showBanner = showModelControls && !noModel && contextIsWarn(context.level);
  const running = run.status === 'running';
  const showNewline = !running && Boolean(draft.trim());
  const placeholder = noModel
    ? t(lang, 'composer_placeholder_no_model')
    : run.status === 'running'
      ? t(lang, 'composer_placeholder_running')
      : t(lang, 'composer_placeholder');

  useEffect(() => () => {
    imagesRef.current.forEach(revokePreview);
  }, []);

  function resize() {
    const el = area.current;
    if (!el) return;
    el.style.height = `${TEXTAREA_MIN}px`;
    el.style.height = `${Math.min(TEXTAREA_MAX, Math.max(TEXTAREA_MIN, el.scrollHeight))}px`;
  }

  useEffect(() => {
    resize();
  }, [draft]);

  useEffect(() => {
    if (!plusOpen) return;
    function onDocClick(event: MouseEvent) {
      if (
        plusMenuRef.current?.contains(event.target as Node) ||
        plusBtnRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setPlusOpen(false);
    }
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setPlusOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [plusOpen]);

  const addImageFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    if (!supportsImages) {
      setHint({ kind: 'no_vision' });
      return;
    }
    const incoming: ImageAttachment[] = [];
    let localHint: ComposerHint | null = null;
    for (const file of files) {
      const result = await fileToImageAttachment(file);
      if ('hint' in result) {
        localHint = result.hint;
        continue;
      }
      incoming.push(result);
    }
    const added = addImages(imagesRef.current, incoming);
    imagesRef.current = added.next;
    setImages(added.next);
    setHint(added.hint || localHint);
  }, [supportsImages]);

  const addProjectFile = useCallback((relPath: string) => {
    if (!relPath) return;
    setFileRefs((current) => {
      if (current.some((item) => item.path === relPath)) return current;
      return [...current, { id: `file-${relPath}`, kind: 'file', path: relPath }];
    });
    setDraft((current) => insertFileRef(current, relPath));
  }, []);

  const dropFiles = useCallback(async (fileList: File[], uriList = '') => {
    const uriPaths = pathsFromUriList(uriList);
    const imageFiles: File[] = [];
    const others: File[] = [];
    for (const file of fileList) {
      if (isImageFile(file)) imageFiles.push(file);
      else others.push(file);
    }
    if (imageFiles.length) await addImageFiles(imageFiles);
    if (!others.length) return;
    let treePaths: string[] = [];
    if (workspaceId) {
      try {
        const tree = await getWorkspaceTree(workspaceId);
        treePaths = tree.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path);
      } catch {
        treePaths = [];
      }
    }
    for (const file of others) {
      const rel = matchProjectPath({
        fileName: file.name,
        filePath: filePathOf(file),
        uriPaths,
        workspacePath,
        treePaths,
      });
      if (rel) addProjectFile(rel);
      else setHint({ kind: 'outside_project', name: file.name });
    }
  }, [addImageFiles, addProjectFile, workspaceId, workspacePath]);

  const pickAtFile = useCallback((relPath: string) => {
    const el = area.current;
    const cur = el ? (el.selectionStart ?? activeCursor) : activeCursor;
    const trigger = matchAtTrigger(draft, cur) || atTrigger;
    if (!trigger) {
      addProjectFile(relPath);
      return;
    }
    const applied = applyAtSelection(draft, relPath, trigger);
    setFileRefs((current) => {
      if (current.some((item) => item.path === relPath)) return current;
      return [...current, { id: `file-${relPath}`, kind: 'file', path: relPath }];
    });
    setDraft(applied.text);
    setCursorPos(applied.nextCursor);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(applied.nextCursor, applied.nextCursor);
        setCursorPos(applied.nextCursor);
        resize();
      }
    });
  }, [activeCursor, addProjectFile, atTrigger, draft]);

  async function submit(text = draft.trim(), mode?: SendMode) {
    const payload = text.trim();
    const imagePayload = toMessageImages(images);
    if ((!payload && !imagePayload.length) || locked || busy) return;
    const requestId = req.current.begin(payload, imageFingerprint(imagePayload));
    setBusy(true);
    setError(null);
    setHint(null);
    const sentImages = images;
    const sentRefs = fileRefs;
    const sentText = payload;
    setDraft('');
    setImages([]);
    setFileRefs([]);
    imagesRef.current = [];
    setCursorPos(null);
    setAtDismissed(false);
    requestAnimationFrame(resize);
    try {
      await onSend(sentText, requestId, imagePayload.length ? imagePayload : undefined, mode);
      req.current.succeed();
      sentImages.forEach(revokePreview);
      onSent?.();
    } catch (err) {
      setDraft((current) => (current ? current : sentText));
      setImages((current) => {
        if (current.length) return current;
        imagesRef.current = sentImages;
        return sentImages;
      });
      setFileRefs((current) => (current.length ? current : sentRefs));
      setError(errorMessage(err, t(lang, 'send_failed')));
      requestAnimationFrame(resize);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    await submit(draft.trim());
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (atOpen) {
      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === 'Tab' ||
        event.key === 'Escape'
      ) {
        event.preventDefault();
      }
      if (event.key === 'Escape') {
        setAtDismissed(true);
        return;
      }
      if (event.key === 'ArrowDown') {
        if (matchedFiles.length > 0) {
          const next = stepAtActiveIndex(atActiveIndexRef.current, matchedFiles.length, 'down');
          atActiveIndexRef.current = next;
          setAtActiveIndex(next);
        }
        return;
      }
      if (event.key === 'ArrowUp') {
        if (matchedFiles.length > 0) {
          const next = stepAtActiveIndex(atActiveIndexRef.current, matchedFiles.length, 'up');
          atActiveIndexRef.current = next;
          setAtActiveIndex(next);
        }
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (!event.nativeEvent.isComposing && event.keyCode !== 229) {
          if (matchedFiles.length > 0) {
            const picked = resolveAtSelection(matchedFiles, atActiveIndexRef.current);
            if (picked) {
              pickAtFile(picked);
            }
          }
        }
        return;
      }
    }
    if (event.key === 'Escape' && plusOpen) {
      event.preventDefault();
      setPlusOpen(false);
      return;
    }
    if (event.key !== 'Enter') return;
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.shiftKey) return;
    if (event.altKey) {
      event.preventDefault();
      if (running) void submit(draft.trim(), 'queue');
      return;
    }
    event.preventDefault();
    void submit(draft.trim(), running ? 'steer' : undefined);
  }

  const pickModel = useCallback(async (option: ComposerModelOption) => {
    const next: ResolvedModel = { providerId: option.providerId, modelId: option.modelId };
    if (isDraft || !conversationId) {
      onDraftModel?.(next);
      return;
    }
    try {
      await patchConversationModel(conversationId, next);
    } catch (err) {
      setError(errorMessage(err, t(lang, 'send_failed')));
    }
  }, [conversationId, isDraft, lang, onDraftModel]);

  const setWindow = useCallback(async (window: number | null) => {
    if (!selected?.providerId || !selected.modelId) return;
    try {
      await putModelContextWindow(selected.providerId, selected.modelId, window);
    } catch (err) {
      setError(errorMessage(err, t(lang, 'send_failed')));
    }
  }, [lang, selected]);

  function openManage() {
    openSettings('providers');
  }

  function openNewChat() {
    if (!workspaceId) return;
    navigate(draftPath(workspaceId));
  }

  function openAttach() {
    if (!allowAttach || locked) return;
    if (!supportsImages) {
      setHint({ kind: 'no_vision' });
      return;
    }
    fileInput.current?.click();
  }

  function pickImages() {
    setPlusOpen(false);
    openAttach();
  }

  function insertFileAt() {
    setPlusOpen(false);
    const el = area.current;
    if (el) {
      const start = el.selectionStart ?? draft.length;
      const end = el.selectionEnd ?? draft.length;
      const next = draft.slice(0, start) + '@' + draft.slice(end);
      const nextPos = start + 1;
      setDraft(next);
      setCursorPos(nextPos);
      setFocused(true);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(nextPos, nextPos);
        resize();
      });
    } else {
      setDraft((cur) => cur + '@');
      setCursorPos(draft.length + 1);
      setFocused(true);
    }
  }

  function removeImage(id: string) {
    setImages((current) => {
      const hit = current.find((item) => item.id === id);
      if (hit) revokePreview(hit);
      const next = current.filter((item) => item.id !== id);
      imagesRef.current = next;
      return next;
    });
  }

  function removeFile(path: string) {
    setFileRefs((current) => current.filter((item) => item.path !== path));
    setDraft((current) => removeFileRef(current, path));
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!allowAttach) return;
    const files = [...(event.clipboardData?.files || [])];
    const items = event.clipboardData?.items;
    if (items) {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file && !files.some((row) => row === file)) files.push(file);
      }
    }
    const imageFiles = files.filter(isImageFile);
    if (!imageFiles.length) return;
    event.preventDefault();
    void addImageFiles(imageFiles);
  }

  function hasFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!allowAttach || locked || !hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!allowAttach || locked || !hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!allowAttach || !hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!allowAttach || locked) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...(event.dataTransfer?.files || [])];
    const uriList = event.dataTransfer?.getData('text/uri-list') || '';
    void dropFiles(files, uriList);
  }

  const boxClass = [
    'composer-box',
    focused ? 'is-focused' : '',
    noModel ? 'is-no-model' : '',
    showBanner ? 'is-ctx-warn' : '',
    dragging ? 'is-drop' : '',
    images.length || fileRefs.length || queue.length ? 'is-tagged' : '',
  ].filter(Boolean).join(' ');

  return (
    <footer className="center-composer">
      <div className="composer-stack">
        <div
          className={boxClass}
          data-testid="next-composer"
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {showBanner ? <ContextBanner lang={lang} context={context} onNewChat={openNewChat} /> : null}
          <div className="composer-body">
            {queue.length || images.length || fileRefs.length ? (
              <div className="composer-tags" data-testid="next-composer-tags">
                {queue.map((item) => (
                  <span key={item.requestId} className="composer-queue" data-testid="next-queue-chip">
                    <span className="composer-queue-label">{t(lang, 'composer_queue_label')}</span>
                    <span className="composer-queue-text">{item.text}</span>
                    <button
                      type="button"
                      className="composer-queue-edit"
                      data-testid="next-queue-edit"
                      onClick={() => {
                        void (async () => {
                          await onWithdrawQueue?.(item.requestId);
                          setDraft(item.text);
                          requestAnimationFrame(resize);
                          area.current?.focus();
                        })();
                      }}
                    >
                      {t(lang, 'composer_queue_edit')}
                    </button>
                    <button
                      type="button"
                      className="composer-queue-x"
                      data-testid="next-queue-dismiss"
                      aria-label={t(lang, 'composer_queue_remove')}
                      onClick={() => { void onWithdrawQueue?.(item.requestId); }}
                    >
                      &times;
                    </button>
                  </span>
                ))}
                {images.map((item) => (
                  <span key={item.id} className="composer-tag" data-testid="next-attach-image">
                    <img className="composer-tag-thumb" src={item.previewUrl} alt="" />
                    <span className="composer-tag-name">{item.name}</span>
                    <span className="composer-tag-size">&middot; {formatFileSize(item.size)}</span>
                    <button
                      type="button"
                      className="composer-tag-x"
                      data-testid="next-attach-remove"
                      aria-label={t(lang, 'attach_remove', { name: item.name })}
                      onClick={() => removeImage(item.id)}
                    >
                      &times;
                    </button>
                  </span>
                ))}
                {visibleFileRefs.map((item) => (
                  <span key={item.id} className="composer-tag is-file" data-testid="next-attach-file">
                    <span className="composer-tag-file-icon">{FILE_ICON}</span>
                    <span className="composer-tag-name">{item.path}</span>
                    <button
                      type="button"
                      className="composer-tag-x"
                      data-testid="next-attach-remove"
                      aria-label={t(lang, 'attach_remove', { name: item.path })}
                      onClick={() => removeFile(item.path)}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {atOpen ? (
              <div
                ref={atMenuRef}
                className="composer-at-menu"
                data-testid="next-composer-at-menu"
                role="listbox"
                aria-label={t(lang, 'composer_at_header')}
              >
                <div className="composer-at-header">{t(lang, 'composer_at_header')}</div>
                <div className="composer-at-list">
                  {treeError ? (
                    <div className="composer-at-empty" data-testid="next-composer-at-empty">
                      {t(lang, 'composer_at_unavailable')}
                    </div>
                  ) : treeLoading ? (
                    <div className="composer-at-empty" data-testid="next-composer-at-empty">
                      {t(lang, 'loading')}
                    </div>
                  ) : matchedFiles.length === 0 ? (
                    <div className="composer-at-empty" data-testid="next-composer-at-empty">
                      {t(lang, 'composer_at_empty')}
                    </div>
                  ) : (
                    matchedFiles.map((file, idx) => {
                      const { name, dir } = splitFilePath(file);
                      const isActive = idx === atActiveIndex;
                      return (
                        <button
                          key={file}
                          type="button"
                          className={`composer-at-item${isActive ? ' is-active' : ''}`}
                          data-testid="next-composer-at-item"
                          data-active={isActive ? 'true' : 'false'}
                          role="option"
                          aria-selected={isActive}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pickAtFile(file);
                          }}
                        >
                          <span className="composer-at-icon">{AT_MENU_FILE_ICON}</span>
                          <span className="composer-at-name">{name}</span>
                          {dir ? <span className="composer-at-dir">{dir}</span> : null}
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="composer-at-footer">{t(lang, 'composer_at_footer')}</div>
              </div>
            ) : null}
            <textarea
              ref={area}
              className="composer-textarea"
              data-testid="next-composer-input"
              rows={2}
              disabled={locked}
              placeholder={placeholder}
              value={draft}
              onFocus={() => {
                setFocused(true);
                setAtDismissed(false);
                if (area.current) {
                  setCursorPos(area.current.selectionStart ?? draft.length);
                }
              }}
              onBlur={() => {
                setFocused(false);
              }}
              onSelect={(event) => {
                const target = event.target as HTMLTextAreaElement;
                setCursorPos(target.selectionStart ?? target.value.length);
              }}
              onClick={(event) => {
                const target = event.target as HTMLTextAreaElement;
                setCursorPos(target.selectionStart ?? target.value.length);
              }}
              onKeyUp={(event) => {
                const target = event.target as HTMLTextAreaElement;
                setCursorPos(target.selectionStart ?? target.value.length);
              }}
              onChange={(event) => {
                const target = event.target;
                const nextCursor = target.selectionStart ?? target.value.length;
                setDraft(target.value);
                setCursorPos(nextCursor);
                setAtDismissed(false);
                resize();
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            <div className="composer-bar">
              {noModel ? (
                <div className="composer-no-model" data-testid="next-no-model">
                  <button
                    type="button"
                    className="btn-connect-model"
                    data-testid="next-no-model-connect"
                    onClick={openManage}
                  >
                    {t(lang, 'no_model_connect')}
                  </button>
                  <span className="composer-no-model-hint">{t(lang, 'no_model_hint')}</span>
                </div>
              ) : (
                <div className="composer-chips">
                  {allowAttach ? (
                    <>
                      {plusOpen ? (
                        <div
                          ref={plusMenuRef}
                          className="composer-plus-menu"
                          data-testid="next-composer-plus-menu"
                          role="menu"
                        >
                          <button
                            type="button"
                            className="composer-plus-item"
                            data-testid="next-composer-plus-image"
                            role="menuitem"
                            onClick={pickImages}
                          >
                            <span className="composer-plus-icon">{PLUS_IMAGE_ICON}</span>
                            <span className="composer-plus-text">
                              <span className="composer-plus-label">{t(lang, 'composer_plus_image')}</span>
                              <span className="composer-plus-hint">{t(lang, 'composer_plus_image_hint')}</span>
                            </span>
                          </button>
                          <button
                            type="button"
                            className="composer-plus-item"
                            data-testid="next-composer-plus-at"
                            role="menuitem"
                            onClick={insertFileAt}
                          >
                            <span className="composer-plus-icon">{PLUS_AT_ICON}</span>
                            <span className="composer-plus-text">
                              <span className="composer-plus-label">{t(lang, 'composer_plus_at')}</span>
                              <span className="composer-plus-hint">{t(lang, 'composer_plus_at_hint')}</span>
                            </span>
                          </button>
                        </div>
                      ) : null}
                      <button
                        ref={plusBtnRef}
                        type="button"
                        className={`composer-attach${plusOpen ? ' is-open' : ''}`}
                        data-testid="next-composer-attach"
                        aria-label={t(lang, 'composer_attach')}
                        title={t(lang, 'composer_attach')}
                        aria-expanded={plusOpen}
                        disabled={locked}
                        onClick={() => {
                          if (!locked) setPlusOpen((open) => !open);
                        }}
                      >
                        {PLUS_ICON}
                      </button>
                      <span className="composer-divider" aria-hidden="true" />
                    </>
                  ) : null}
                  {showModelControls && available ? (
                    <ModelChip
                      lang={lang}
                      selected={selected}
                      groups={groups}
                      onPick={(option) => { void pickModel(option); }}
                      onManage={openManage}
                    />
                  ) : null}
                  <WorkspaceChip
                    lang={lang}
                    selectedId={workspaceId}
                    canSwitch={isDraft}
                    onPick={(id) => {
                      writeActiveWorkspace(id);
                      navigate(draftPath(id), { replace: true });
                    }}
                    onNew={() => onNewWorkspace?.()}
                    onOpenTerminal={workspaceId
                      ? () => { void openInTerminal(undefined, workspaceId); }
                      : undefined}
                    onCopyPath={copyPath}
                  />
                  {git?.branch ? (
                    <button
                      type="button"
                      className="composer-git-chip"
                      data-testid="next-composer-git"
                      title={formatComposerGitTitle(lang, git)}
                    >
                      {GIT_BRANCH_ICON}
                      <span className="composer-git-branch" data-testid="next-composer-git-branch">
                        {git.branch}
                      </span>
                      {hasDiff ? (
                        <>
                          <span className="composer-git-ins" data-testid="next-composer-git-ins">
                            +{git.insertions || 0}
                          </span>
                          <span className="composer-git-del" data-testid="next-composer-git-del">
                            {"−" + (git.deletions || 0)}
                          </span>
                        </>
                      ) : null}
                      {git.ahead != null && git.ahead > 0 ? (
                        <span className="composer-git-ahead" data-testid="next-composer-git-ahead">
                          {"↑" + git.ahead}
                        </span>
                      ) : null}
                    </button>
                  ) : null}
                  {demo ? <DemoModelBadge lang={lang} testId="next-demo-model-chip" /> : null}
                </div>
              )}
              {noWorkspace ? (
                <span className="composer-lock" data-testid="next-composer-need-ws">{t(lang, 'composer_need_workspace')}</span>
              ) : locked && !noModel && run.lockedReason === 'no_workspace' ? (
                <span className="composer-lock">{t(lang, 'locked_no_workspace')}</span>
              ) : null}
              {hint ? (
                <span className="composer-hint" data-testid="next-composer-hint">{hintText(lang, hint)}</span>
              ) : null}
              {error ? (
                <span className="composer-error" data-testid="next-composer-error">
                  {error}
                  <button type="button" className="composer-retry" data-testid="next-composer-retry" onClick={() => { void retry(); }}>
                    {t(lang, 'btn_retry')}
                  </button>
                </span>
              ) : null}
              <div className="composer-actions">
                {showNewline ? (
                  <span className="composer-newline" data-testid="next-composer-newline">
                    {t(lang, 'composer_newline_hint')}
                  </span>
                ) : null}
                {showModelControls && !noModel ? (
                  <ContextChip
                    lang={lang}
                    context={context}
                    selected={selected}
                    onSetWindow={setWindow}
                  />
                ) : null}
                {stopMode ? (
                  <button
                    type="button"
                    className="btn-send is-ready"
                    data-testid="next-stop"
                    data-state="stop"
                    title={t(lang, 'btn_stop_title')}
                    aria-label={t(lang, 'btn_stop')}
                    disabled={busy}
                    onClick={() => { void onStop(); }}
                  >
                    {STOP_ICON}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`btn-send${canSend ? ' is-ready' : ''}`}
                    data-testid="next-send"
                    title={noWorkspace ? t(lang, 'composer_need_workspace') : t(lang, 'send_title')}
                    aria-label={t(lang, 'btn_send')}
                    disabled={locked || busy || !canSend}
                    onClick={() => { void submit(draft.trim(), running ? 'steer' : undefined); }}
                  >
                    {SEND_ICON}
                  </button>
                )}
              </div>
            </div>
          </div>
          {dragging ? (
            <div className="composer-drop" data-testid="next-composer-drop">
              {DROP_ICON}
              <span className="composer-drop-title">{t(lang, 'attach_drop')}</span>
              <span className="composer-drop-hint">{t(lang, 'attach_drop_hint')}</span>
            </div>
          ) : null}
        </div>
      </div>
      {allowAttach ? (
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          tabIndex={-1}
          data-testid="next-composer-attach-input"
          onChange={(event) => {
            const files = [...(event.target.files || [])];
            event.target.value = '';
            void addImageFiles(files);
          }}
        />
      ) : null}
    </footer>
  );
}
