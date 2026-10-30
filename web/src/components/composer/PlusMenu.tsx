import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { isImageFile, type ComposerHint } from '../../data/attachments';
import type { Lang } from '../../data/lang';
import { t } from '../../i18n';

const PLUS_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
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

export type PlusMenuProps = {
  lang: Lang;
  locked: boolean;
  supportsImages: boolean;
  setHint: Dispatch<SetStateAction<ComposerHint | null>>;
  addImageFiles: (files: File[]) => void | Promise<void>;
  uploadFiles: (files: File[]) => void | Promise<void>;
  insertFileAt: () => void;
};

export function PlusMenu({
  lang,
  locked,
  supportsImages,
  setHint,
  addImageFiles,
  uploadFiles,
  insertFileAt,
}: PlusMenuProps) {
  const [plusOpen, setPlusOpen] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const anyFileInput = useRef<HTMLInputElement>(null);

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

  function openAttach() {
    if (locked) return;
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

  function pickAnyFiles() {
    setPlusOpen(false);
    anyFileInput.current?.click();
  }

  function pickAt() {
    setPlusOpen(false);
    insertFileAt();
  }

  return (
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
            data-testid="next-composer-plus-file"
            role="menuitem"
            onClick={pickAnyFiles}
          >
            <span className="composer-plus-icon">{FILE_ICON}</span>
            <span className="composer-plus-text">
              <span className="composer-plus-label">{t(lang, 'composer_plus_file')}</span>
              <span className="composer-plus-hint">{t(lang, 'composer_plus_file_hint')}</span>
            </span>
          </button>
          <button
            type="button"
            className="composer-plus-item"
            data-testid="next-composer-plus-at"
            role="menuitem"
            onClick={pickAt}
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
      <input
        ref={anyFileInput}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        data-testid="next-composer-file-input"
        onChange={(event) => {
          const files = [...(event.target.files || [])];
          event.target.value = '';
          if (!files.length) return;
          const imageFiles = files.filter(isImageFile);
          const nonImageFiles = files.filter((f) => !isImageFile(f));
          if (imageFiles.length) void addImageFiles(imageFiles);
          if (nonImageFiles.length) void uploadFiles(nonImageFiles);
        }}
      />
    </>
  );
}
