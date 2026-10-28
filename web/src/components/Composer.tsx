import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { getWorkspaceTree, patchConversationModel, putModelContextWindow } from '../data/api';
import {
  addImages,
  filePathOf,
  fileToImageAttachment,
  formatFileSize,
  IMAGE_MAX_COUNT,
  imageFingerprint,
  insertFileRef,
  isImageFile,
  matchProjectPath,
  pathsFromUriList,
  removeFileRef,
  revokePreview,
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
import type { Lang } from '../data/lang';
import { draftPath, navigate, openSettings } from '../data/nav';
import { useProviders } from '../data/useProviders';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { writeActiveWorkspace } from '../data/layout';
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
  onSend: (text: string, requestId: string, images?: MessageImage[]) => Promise<unknown>;
  onStop: () => Promise<unknown>;
  onSent?: () => void;
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
}: Props) {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [fileRefs, setFileRefs] = useState<FileRefAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<ComposerHint | null>(null);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const req = useRef(createSendRequest());
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const { providers, defaultModel, ready: providersReady } = useProviders();
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
  const hasPayload = Boolean(draft.trim()) || images.length > 0 || fileRefs.length > 0;
  const canSend = hasPayload && !locked;
  const stopMode = run.canStop && !hasPayload;
  const showBanner = showModelControls && !noModel && contextIsWarn(context.level);
  const showNewline = Boolean(draft) && !stopMode;
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

  async function submit(text = draft.trim()) {
    let payload = text;
    for (const ref of fileRefs) payload = insertFileRef(payload, ref.path);
    payload = payload.trim();
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
    requestAnimationFrame(resize);
    try {
      await onSend(sentText, requestId, imagePayload.length ? imagePayload : undefined);
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
    if (event.key !== 'Enter') return;
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void submit();
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
    images.length || fileRefs.length ? 'is-tagged' : '',
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
            {images.length || fileRefs.length ? (
              <div className="composer-tags" data-testid="next-composer-tags">
                {images.map((item) => (
                  <span key={item.id} className="composer-tag" data-testid="next-attach-image">
                    <img className="composer-tag-thumb" src={item.previewUrl} alt="" />
                    <span className="composer-tag-name">{item.name}</span>
                    <span className="composer-tag-size">· {formatFileSize(item.size)}</span>
                    <button
                      type="button"
                      className="composer-tag-x"
                      data-testid="next-attach-remove"
                      aria-label={t(lang, 'attach_remove', { name: item.name })}
                      onClick={() => removeImage(item.id)}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {fileRefs.map((item) => (
                  <span key={item.id} className="composer-tag is-file" data-testid="next-attach-file">
                    <span className="composer-tag-name">{item.path}</span>
                    <button
                      type="button"
                      className="composer-tag-x"
                      data-testid="next-attach-remove"
                      aria-label={t(lang, 'attach_remove', { name: item.path })}
                      onClick={() => removeFile(item.path)}
                    >
                      ×
                    </button>
                  </span>
                ))}
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
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(event) => {
                setDraft(event.target.value);
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
                      <button
                        type="button"
                        className="composer-attach"
                        data-testid="next-composer-attach"
                        aria-label={t(lang, 'composer_attach')}
                        title={t(lang, 'composer_attach')}
                        disabled={locked}
                        onClick={openAttach}
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
                  />
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
                    onClick={() => { void submit(); }}
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
