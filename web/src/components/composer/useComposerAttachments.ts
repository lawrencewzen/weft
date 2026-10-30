import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import { ApiError, getWorkspaceTree, uploadWorkspaceFile, type SendMessageFile } from '../../data/api';
import {
  addImages,
  createPasteAttachment,
  filePathOf,
  fileToImageAttachment,
  imageFingerprint,
  insertFileRef,
  isFileRefInText,
  isImageFile,
  isLongPaste,
  matchProjectPath,
  PASTE_MAX_BYTES,
  PASTE_MAX_COUNT,
  pathsFromUriList,
  readAsBase64,
  removeFileRef,
  revokePreview,
  toMessageImages,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  type ComposerHint,
  type FileRefAttachment,
  type ImageAttachment,
  type MessageImage,
  type PasteAttachment,
  type UploadAttachment,
} from '../../data/attachments';
import type { Lang } from '../../data/lang';
import { t } from '../../i18n';
import { errorMessage } from '../sendRequest';

export type ComposerAttachmentSnapshot = {
  images: ImageAttachment[];
  fileRefs: FileRefAttachment[];
  uploads: UploadAttachment[];
  pastes: PasteAttachment[];
};

export type ComposerSendPayload = {
  imagePayload: MessageImage[];
  sentFiles: SendMessageFile[];
  sentPastes: string[];
  extraKey: string;
};

export type UseComposerAttachmentsOptions = {
  lang: Lang;
  workspaceId: string | null;
  workspacePath: string | null;
  supportsImages: boolean;
  allowAttach: boolean;
  locked: boolean;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setHint: Dispatch<SetStateAction<ComposerHint | null>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onResize: () => void;
};

export type UseComposerAttachmentsResult = ReturnType<typeof useComposerAttachments>;

export function useComposerAttachments({
  lang,
  workspaceId,
  workspacePath,
  supportsImages,
  allowAttach,
  locked,
  draft,
  setDraft,
  setError,
  setHint,
  textareaRef,
  onResize,
}: UseComposerAttachmentsOptions) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [uploads, setUploads] = useState<UploadAttachment[]>([]);
  const [pastes, setPastes] = useState<PasteAttachment[]>([]);
  const [pastePeekId, setPastePeekId] = useState<string | null>(null);
  const [fileRefs, setFileRefs] = useState<FileRefAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  const visibleFileRefs = useMemo(() => {
    return fileRefs.filter((ref) => isFileRefInText(draft, ref.path));
  }, [fileRefs, draft]);

  const hasUploading = uploads.some((u) => u.status === 'uploading');
  const hasUploadError = uploads.some((u) => u.status === 'error');
  const hasTagItems = images.length > 0 || fileRefs.length > 0 || uploads.length > 0 || pastes.length > 0;

  useEffect(() => () => {
    imagesRef.current.forEach(revokePreview);
  }, []);

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
  }, [setHint, supportsImages]);

  const addFileRef = useCallback((relPath: string) => {
    if (!relPath) return;
    setFileRefs((current) => {
      if (current.some((item) => item.path === relPath)) return current;
      return [...current, { id: `file-${relPath}`, kind: 'file', path: relPath }];
    });
  }, []);

  const addProjectFile = useCallback((relPath: string) => {
    if (!relPath) return;
    addFileRef(relPath);
    setDraft((current) => insertFileRef(current, relPath));
  }, [addFileRef, setDraft]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    if (!workspaceId) {
      setError(t(lang, 'composer_need_workspace'));
      return;
    }
    if (uploads.length + files.length > UPLOAD_MAX_FILES) {
      setError(t(lang, 'attach_too_many', { n: UPLOAD_MAX_FILES }));
      return;
    }
    for (const file of files) {
      const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (file.size > UPLOAD_MAX_BYTES) {
        const errorItem: UploadAttachment = {
          id,
          kind: 'upload',
          name: file.name || 'file',
          size: file.size,
          status: 'error',
          error: t(lang, 'upload_too_large', { name: file.name || 'file' }),
        };
        setUploads((prev) => [...prev, errorItem]);
        continue;
      }
      const initialItem: UploadAttachment = {
        id,
        kind: 'upload',
        name: file.name || 'file',
        size: file.size,
        status: 'uploading',
      };
      setUploads((prev) => [...prev, initialItem]);
      void (async () => {
        try {
          const base64 = await readAsBase64(file);
          const result = await uploadWorkspaceFile(workspaceId, {
            name: file.name,
            data: base64,
          });
          setUploads((prev) => prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: 'done',
                  size: result.bytes,
                  uploaded: result,
                }
              : item
          ));
        } catch (err) {
          const msg = err instanceof ApiError && err.status === 413
            ? t(lang, 'upload_too_large', { name: file.name || 'file' })
            : errorMessage(err, t(lang, 'upload_failed', { name: file.name || 'file' }));
          setUploads((prev) => prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: 'error',
                  error: msg,
                }
              : item
          ));
        }
      })();
    }
  }, [lang, setError, uploads.length, workspaceId]);

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
    const toUpload: File[] = [];
    for (const file of others) {
      const rel = matchProjectPath({
        fileName: file.name,
        filePath: filePathOf(file),
        uriPaths,
        workspacePath,
        treePaths,
      });
      if (rel) {
        addProjectFile(rel);
      } else {
        toUpload.push(file);
      }
    }
    if (toUpload.length) {
      void uploadFiles(toUpload);
    }
  }, [addImageFiles, addProjectFile, uploadFiles, workspaceId, workspacePath]);

  function removeImage(id: string) {
    setImages((current) => {
      const hit = current.find((item) => item.id === id);
      if (hit) revokePreview(hit);
      const next = current.filter((item) => item.id !== id);
      imagesRef.current = next;
      return next;
    });
  }

  function removeUpload(id: string) {
    setUploads((prev) => prev.filter((item) => item.id !== id));
  }

  function removePaste(id: string) {
    if (pastePeekId === id) setPastePeekId(null);
    setPastes((prev) => prev.filter((item) => item.id !== id));
  }

  function removeFile(path: string) {
    setFileRefs((current) => current.filter((item) => item.path !== path));
    setDraft((current) => removeFileRef(current, path));
  }

  function restorePaste(id: string) {
    const item = pastes.find((p) => p.id === id);
    setPastePeekId(null);
    setPastes((prev) => prev.filter((p) => p.id !== id));
    if (!item) return;
    setDraft((cur) => (cur ? `${cur}\n${item.text}` : item.text));
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      onResize();
    });
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
    if (files.length > 0) {
      event.preventDefault();
      const imageFiles = files.filter(isImageFile);
      const nonImageFiles = files.filter((f) => !isImageFile(f));
      if (imageFiles.length) void addImageFiles(imageFiles);
      if (nonImageFiles.length) void uploadFiles(nonImageFiles);
      return;
    }
    const text = event.clipboardData?.getData('text/plain') || '';
    if (isLongPaste(text)) {
      event.preventDefault();
      if (pastes.length >= PASTE_MAX_COUNT) {
        setError(t(lang, 'paste_too_many'));
        return;
      }
      if (text.length > PASTE_MAX_BYTES) {
        setError(t(lang, 'paste_too_large'));
        return;
      }
      const newPaste = createPasteAttachment(text, t(lang, 'paste_default_name'));
      setPastes((prev) => [...prev, newPaste]);
    }
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

  function buildSendPayload(): ComposerSendPayload {
    const imagePayload = toMessageImages(images);
    const sentUploads = uploads.filter((u) => u.status === 'done' && u.uploaded);
    const sentFiles: SendMessageFile[] = sentUploads.map((u) => ({
      path: u.uploaded!.path,
      name: u.uploaded!.name,
      bytes: u.uploaded!.bytes,
    }));
    const sentPastes: string[] = pastes.map((p) => p.text);
    const filesKey = sentFiles.map((f) => f.path).join(',');
    const pastesKey = sentPastes.map((p) => `${p.length}:${p.slice(0, 10)}`).join(',');
    return {
      imagePayload,
      sentFiles,
      sentPastes,
      extraKey: `${imageFingerprint(imagePayload)}|${filesKey}|${pastesKey}`,
    };
  }

  function takeAndClear(): ComposerAttachmentSnapshot {
    const snapshot: ComposerAttachmentSnapshot = {
      images,
      fileRefs,
      uploads,
      pastes,
    };
    setImages([]);
    setFileRefs([]);
    setUploads([]);
    setPastes([]);
    imagesRef.current = [];
    return snapshot;
  }

  function restore(snapshot: ComposerAttachmentSnapshot) {
    setImages((current) => {
      if (current.length) return current;
      imagesRef.current = snapshot.images;
      return snapshot.images;
    });
    setFileRefs((current) => (current.length ? current : snapshot.fileRefs));
    setUploads((current) => (current.length ? current : snapshot.uploads));
    setPastes((current) => (current.length ? current : snapshot.pastes));
  }

  function revokeSnapshot(snapshot: ComposerAttachmentSnapshot) {
    snapshot.images.forEach(revokePreview);
  }

  function reset() {
    imagesRef.current.forEach(revokePreview);
    imagesRef.current = [];
    setImages([]);
    setFileRefs([]);
    setUploads([]);
    setPastes([]);
    setPastePeekId(null);
    setDragging(false);
    dragDepth.current = 0;
  }

  return {
    images,
    uploads,
    pastes,
    pastePeekId,
    setPastePeekId,
    fileRefs,
    visibleFileRefs,
    dragging,
    hasUploading,
    hasUploadError,
    hasTagItems,
    addImageFiles,
    addFileRef,
    addProjectFile,
    uploadFiles,
    dropFiles,
    removeImage,
    removeUpload,
    removePaste,
    removeFile,
    restorePaste,
    onPaste,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    buildSendPayload,
    takeAndClear,
    restore,
    revokeSnapshot,
    reset,
  };
}
