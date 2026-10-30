import { useEffect, useRef } from 'react';
import { formatFileSize } from '../../data/attachments';
import type { Lang } from '../../data/lang';
import { t } from '../../i18n';
import { StatusIcon } from '../StatusIcon';
import type { UseComposerAttachmentsResult } from './useComposerAttachments';

const FILE_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

export type ComposerTagsProps = {
  lang: Lang;
} & Pick<
  UseComposerAttachmentsResult,
  | 'images'
  | 'visibleFileRefs'
  | 'uploads'
  | 'pastes'
  | 'pastePeekId'
  | 'setPastePeekId'
  | 'removeImage'
  | 'removeUpload'
  | 'removePaste'
  | 'removeFile'
  | 'restorePaste'
>;

export function ComposerTags({
  lang,
  images,
  visibleFileRefs,
  uploads,
  pastes,
  pastePeekId,
  setPastePeekId,
  removeImage,
  removeUpload,
  removePaste,
  removeFile,
  restorePaste,
}: ComposerTagsProps) {
  const pastePeekRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pastePeekId) return;
    function onDocClick(event: MouseEvent) {
      const target = event.target as Element | null;
      if (
        pastePeekRef.current?.contains(target as Node) ||
        target?.closest?.('[data-testid="next-attach-paste"]')
      ) {
        return;
      }
      setPastePeekId(null);
    }
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setPastePeekId(null);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [pastePeekId, setPastePeekId]);

  return (
    <>
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
      {uploads.map((item) => {
        const isUploading = item.status === 'uploading';
        const isError = item.status === 'error';
        return (
          <span
            key={item.id}
            className={`composer-tag is-file${isError ? ' is-error' : ''}`}
            data-testid="next-attach-upload"
            data-status={item.status}
            title={item.uploaded?.path || item.name}
          >
            {isUploading ? (
              <StatusIcon status="running" size={14} className="composer-tag-spin" aria-hidden="true" />
            ) : isError ? (
              <StatusIcon status="failed" size={14} className="composer-tag-file-icon" aria-hidden="true" />
            ) : (
              <span className="composer-tag-file-icon">{FILE_ICON}</span>
            )}
            <span className="composer-tag-name">{item.name}</span>
            {isUploading ? (
              <span className="composer-tag-size">&middot; {t(lang, 'uploading')}</span>
            ) : isError ? (
              <span className="composer-tag-error" data-testid="next-upload-error">
                &middot; {item.error}
              </span>
            ) : (
              <span className="composer-tag-size">&middot; {formatFileSize(item.size)}</span>
            )}
            <button
              type="button"
              className="composer-tag-x"
              data-testid="next-attach-remove"
              aria-label={t(lang, 'attach_remove', { name: item.name })}
              onClick={() => removeUpload(item.id)}
            >
              &times;
            </button>
          </span>
        );
      })}
      {pastes.map((item) => {
        const isPeekOpen = pastePeekId === item.id;
        const head = item.text.split('\n').slice(0, 8).join('\n');
        return (
          <span
            key={item.id}
            className="composer-tag is-paste"
            data-testid="next-attach-paste"
            title={t(lang, 'attach_paste_peek')}
            onClick={() => {
              setPastePeekId((cur) => (cur === item.id ? null : item.id));
            }}
          >
            <span className="composer-tag-paste-icon">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--mute)"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M4 6h16M4 10h16M4 14h10M4 18h7" />
              </svg>
            </span>
            <span className="composer-tag-name">{item.name || t(lang, 'paste_default_name')}</span>
            <span className="composer-tag-size">{t(lang, 'paste_tag_lines', { n: item.lines })}</span>
            {isPeekOpen ? (
              <div
                ref={pastePeekRef}
                className="composer-paste-peek"
                data-testid="next-paste-peek"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="composer-paste-peek-head" data-testid="next-paste-peek-head">
                  {head}
                </div>
                <div className="composer-paste-peek-bar">
                  <span>{t(lang, 'paste_peek_all', { n: item.lines })}</span>
                  <button
                    type="button"
                    className="composer-paste-peek-restore"
                    data-testid="next-paste-peek-restore"
                    onClick={(e) => {
                      e.stopPropagation();
                      restorePaste(item.id);
                    }}
                  >
                    {t(lang, 'paste_peek_restore')}
                  </button>
                </div>
              </div>
            ) : null}
            <button
              type="button"
              className="composer-tag-x"
              data-testid="next-attach-remove"
              aria-label={t(lang, 'attach_remove', { name: item.name })}
              onClick={(e) => {
                e.stopPropagation();
                removePaste(item.id);
              }}
            >
              &times;
            </button>
          </span>
        );
      })}
    </>
  );
}
