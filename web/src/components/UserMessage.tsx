import { useEffect, useState } from 'react';
import type { Lang } from '../data/lang';
import { imageDisplayName } from '../../../src/v2/views/message-images';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
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

export function UserMessage({ item, lang }: { item: Item; lang: Lang }) {
  const images = item.images || [];
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
      {text ? (
        <Markdown
          text={item.text}
          pathRefs={item.pathRefs}
          copyLabel={t(lang, 'copy_code')}
          copiedLabel={t(lang, 'copied')}
        />
      ) : null}
      {open ? <Lightbox image={open} lang={lang} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
