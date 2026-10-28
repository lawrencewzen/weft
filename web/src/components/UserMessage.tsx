import { useEffect, useState } from 'react';
import type { Lang } from '../data/lang';
import { imageDataUrl, imageDisplayName } from '../../../src/v2/views/message-images';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { Markdown } from './Markdown';

type Item = components['schemas']['ThreadItemUser'];
type MessageImage = components['schemas']['MessageImage'];

export function UserMessage({ item, lang }: { item: Item; lang: Lang }) {
  const images = item.images || [];
  const [open, setOpen] = useState<MessageImage | null>(null);
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
            <button
              key={`${image.mediaType}-${index}`}
              type="button"
              className="msg-user-image"
              data-testid="next-user-image"
              aria-label={t(lang, 'image_preview')}
              onClick={() => setOpen(image)}
            >
              <img src={imageDataUrl(image)} alt={imageDisplayName(image, index)} />
            </button>
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
      {open ? (
        <button
          type="button"
          className="img-lightbox"
          data-testid="next-image-lightbox"
          aria-label={t(lang, 'image_close')}
          onClick={() => setOpen(null)}
        >
          <img src={imageDataUrl(open)} alt={imageDisplayName(open)} />
        </button>
      ) : null}
    </div>
  );
}
