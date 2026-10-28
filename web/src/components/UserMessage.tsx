import { useEffect, useState } from 'react';
import type { Lang } from '../data/lang';
import { imageDisplayName } from '../../../src/v2/views/message-images';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { formatFileSize, getLocalPastes } from '../data/attachments';
import { getMessagePaste } from '../data/api';
import { Markdown } from './Markdown';

type Item = components['schemas']['ThreadItemUser'];
type ThreadUserImage = components['schemas']['ThreadUserImage'];

const localPreviews = new Map<string, string>();

function imageKey(image: ThreadUserImage): string {
  return `${image.mediaType}:${image.bytes}:${image.name || ''}:${image.index}`;
}

function rememberLocalPreview(image: ThreadUserImage): void {
  if (image.url.startsWith('data:') || image.url.startsWith('blob:')) {
    localPreviews.set(imageKey(image), image.url);
  }
}

/** Keep the optimistic local preview on screen until the server url has loaded. */
function useStickyImageSrc(image: ThreadUserImage): string {
  rememberLocalPreview(image);
  const fallback = localPreviews.get(imageKey(image));
  const preferred = image.url;
  const initial = fallback && fallback !== preferred ? fallback : preferred;
  const [src, setSrc] = useState(initial);
  useEffect(() => {
    if (preferred === src) return;
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => {
      if (!cancelled) setSrc(preferred);
    };
    probe.onerror = () => {
      if (!cancelled && !fallback) setSrc(preferred);
    };
    probe.src = preferred;
    return () => {
      cancelled = true;
    };
  }, [preferred, src, fallback]);
  return src;
}

function UserImage({
  image,
  index,
  lang,
  onOpen,
}: {
  image: ThreadUserImage;
  index: number;
  lang: Lang;
  onOpen: () => void;
}) {
  const src = useStickyImageSrc(image);
  return (
    <button
      type="button"
      className="msg-user-image"
      data-testid="next-user-image"
      aria-label={t(lang, 'image_preview')}
      onClick={onOpen}
    >
      <img src={src} alt={imageDisplayName(image, index)} />
    </button>
  );
}

function Lightbox({
  image,
  lang,
  onClose,
}: {
  image: ThreadUserImage;
  lang: Lang;
  onClose: () => void;
}) {
  const src = useStickyImageSrc(image);
  return (
    <button
      type="button"
      className="img-lightbox"
      data-testid="next-image-lightbox"
      aria-label={t(lang, 'image_close')}
      onClick={onClose}
    >
      <img src={src} alt={imageDisplayName(image)} />
    </button>
  );
}

function isSteered(item: Item): boolean {
  return Boolean((item as Item & { steered?: boolean }).steered);
}

function UserPasteBlock({
  paste,
  index,
  item,
  conversationId,
  lang,
}: {
  paste: components['schemas']['ThreadUserPaste'];
  index: number;
  item: Item;
  conversationId?: string | null;
  lang: Lang;
}) {
  const [open, setOpen] = useState(false);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (!open) {
      if (!fullText) {
        const local = getLocalPastes(item.id);
        if (local && local[index] != null) {
          setFullText(local[index]);
          setOpen(true);
          return;
        }
        if (conversationId && !item.id.startsWith('local:')) {
          setLoading(true);
          try {
            const text = await getMessagePaste(conversationId, item.id, index);
            setFullText(text);
          } catch {
            // keep preview on failure
          } finally {
            setLoading(false);
          }
        }
      }
      setOpen(true);
    } else {
      setOpen(false);
    }
  };

  const displayText = open && fullText != null ? fullText : paste.preview;

  return (
    <div className="msg-user-paste-block" data-testid="next-user-paste">
      <div
        className={`msg-user-paste-content ${open ? 'is-expanded' : 'is-collapsed'}`}
        data-testid="next-user-paste-text"
      >
        {displayText}
      </div>
      <button
        type="button"
        className="msg-user-paste-bar"
        data-testid="next-user-paste-toggle"
        onClick={() => { void toggle(); }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 10h16M4 14h10M4 18h7" />
        </svg>
        <span className="msg-user-paste-title">
          {t(lang, 'paste_block_title', { n: paste.lines })}
        </span>
        <span className="msg-user-paste-label">
          {loading ? t(lang, 'loading') : open ? t(lang, 'collapse') : t(lang, 'expand')}
        </span>
      </button>
    </div>
  );
}

export function UserMessage({
  item,
  lang,
  conversationId,
}: {
  item: Item;
  lang: Lang;
  conversationId?: string | null;
}) {
  const images = item.images || [];
  const files = item.files || [];
  const pastes = item.pastes || [];
  const [open, setOpen] = useState<ThreadUserImage | null>(null);
  const text = item.text.trim();
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div
      className="msg-group msg-side-user"
      data-testid="next-item-user"
      data-role="user"
      data-id={item.id}
    >
      {images.length ? (
        <div className="msg-user-images" data-testid="next-user-images">
          {images.map((image, index) => (
            <UserImage
              key={`${image.mediaType}-${image.index}-${index}`}
              image={image}
              index={index}
              lang={lang}
              onOpen={() => setOpen(image)}
            />
          ))}
        </div>
      ) : null}
      {files.length ? (
        <div className="msg-user-files" data-testid="next-user-files">
          {files.map((file, idx) => (
            <span
              key={`${file.path}-${idx}`}
              className="msg-user-file-tag"
              data-testid="next-user-file"
              title={file.path}
            >
              <span className="msg-user-file-name">{file.name}</span>
              <span className="msg-user-file-size">&middot; {formatFileSize(file.bytes)}</span>
            </span>
          ))}
        </div>
      ) : null}
      {pastes.length ? (
        <div className="msg-user-pastes" data-testid="next-user-pastes">
          {pastes.map((paste, idx) => (
            <UserPasteBlock
              key={`paste-${idx}`}
              paste={paste}
              index={idx}
              item={item}
              conversationId={conversationId}
              lang={lang}
            />
          ))}
        </div>
      ) : null}
      {text ? (
        <Markdown
          text={item.text}
          pathRefs={item.pathRefs}
          copyLabel={t(lang, 'copy_code')}
          copiedLabel={t(lang, 'copied')}
        />
      ) : null}
      {open ? <Lightbox image={open} lang={lang} onClose={() => setOpen(null)} /> : null}
      {isSteered(item) ? (
        <div className="msg-steer-hint" data-testid="next-steer-hint">
          {t(lang, 'composer_steered')}
        </div>
      ) : null}
    </div>
  );
}
