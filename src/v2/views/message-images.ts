/** Parse, assemble, and redact user-message images. Pi Durable ImageContent shape. */

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 6;
export const MESSAGE_BODY_MAX_BYTES = 44 * 1024 * 1024;

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export type MessageImage = {
  mediaType: ImageMediaType;
  data: string;
  name?: string;
};

export type ImageContent = {
  type: 'image';
  data: string;
  mimeType: ImageMediaType;
  name?: string;
};

export type TextContent = {
  type: 'text';
  text: string;
};

export type UserContent = string | Array<TextContent | ImageContent>;

export type ParseImagesOk = { ok: true; images: MessageImage[] };
export type ParseImagesErr = { ok: false; error: string; code: string };
export type ParseImagesResult = ParseImagesOk | ParseImagesErr;

const MEDIA_ALIASES: Record<string, ImageMediaType> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

export function normalizeMediaType(value: unknown): ImageMediaType | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return MEDIA_ALIASES[key] || null;
}

/** Decoded byte length of standard base64, or null if the string is not base64. */
export function decodedBase64Bytes(data: string): number | null {
  const text = data.replace(/\s+/g, '');
  if (!text || text.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseOneImage(raw: unknown, index: number): ParseImagesResult & { image?: MessageImage } {
  const row = asRecord(raw);
  if (!row) {
    return { ok: false, error: `images[${index}] invalid`, code: 'E_BAD_REQUEST' };
  }
  const mediaType = normalizeMediaType(row.mediaType ?? row.mimeType);
  if (!mediaType) {
    return { ok: false, error: `images[${index}] unsupported type`, code: 'E_BAD_REQUEST' };
  }
  if (typeof row.data !== 'string' || !row.data) {
    return { ok: false, error: `images[${index}] data required`, code: 'E_BAD_REQUEST' };
  }
  const bytes = decodedBase64Bytes(row.data);
  if (bytes == null) {
    return { ok: false, error: `images[${index}] invalid data`, code: 'E_BAD_REQUEST' };
  }
  if (bytes > IMAGE_MAX_BYTES) {
    return { ok: false, error: `images[${index}] exceeds 5MB`, code: 'E_TOO_LARGE' };
  }
  const image: MessageImage = { mediaType, data: row.data };
  if (typeof row.name === 'string' && row.name.trim()) {
    image.name = row.name.trim().slice(0, 200);
  }
  return { ok: true, images: [image], image };
}

/** Validate the POST /messages `images` field. Missing/null → empty list. */
export function parseSendImages(raw: unknown): ParseImagesResult {
  if (raw == null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'images must be an array', code: 'E_BAD_REQUEST' };
  }
  if (raw.length > IMAGE_MAX_COUNT) {
    return { ok: false, error: `at most ${IMAGE_MAX_COUNT} images`, code: 'E_BAD_REQUEST' };
  }
  const images: MessageImage[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const parsed = parseOneImage(raw[i], i);
    if (!parsed.ok) return parsed;
    if (parsed.image) images.push(parsed.image);
  }
  return { ok: true, images };
}

export function toImageContent(image: MessageImage): ImageContent {
  const block: ImageContent = {
    type: 'image',
    data: image.data,
    mimeType: image.mediaType,
  };
  if (image.name) block.name = image.name;
  return block;
}

/** Pi Durable UserInput: string, or [text, image...]. Empty text with images omits the text part. */
export function assembleUserContent(text: string, images: readonly MessageImage[] = []): UserContent {
  const trimmed = String(text ?? '').trim();
  if (!images.length) return trimmed;
  const parts: Array<TextContent | ImageContent> = [];
  if (trimmed) parts.push({ type: 'text', text: trimmed });
  for (const image of images) parts.push(toImageContent(image));
  return parts;
}

function imageFromSource(source: Record<string, unknown> | null, name?: unknown): MessageImage | null {
  if (!source) return null;
  const mediaType = normalizeMediaType(source.mediaType ?? source.mimeType ?? source.media_type);
  const data = typeof source.data === 'string' ? source.data : '';
  if (!mediaType || !data) return null;
  const image: MessageImage = { mediaType, data };
  if (typeof name === 'string' && name.trim()) image.name = name.trim();
  return image;
}

function imageFromBlock(block: unknown): MessageImage | null {
  const row = asRecord(block);
  if (!row) return null;
  if (row.type === 'image') {
    const direct = imageFromSource(row, row.name);
    if (direct) return direct;
    return imageFromSource(asRecord(row.source), row.name);
  }
  // Anthropic-style { source: { mediaType, data } } without type: image.
  return imageFromSource(asRecord(row.source), row.name);
}

export function extractMessageImages(content: unknown): MessageImage[] {
  if (!Array.isArray(content)) return [];
  const out: MessageImage[] = [];
  for (const block of content) {
    const image = imageFromBlock(block);
    if (image) out.push(image);
  }
  return out;
}

function redactImage(image: MessageImage): Record<string, unknown> {
  const bytes = decodedBase64Bytes(image.data);
  const out: Record<string, unknown> = {
    mediaType: image.mediaType,
    data: `[redacted ${bytes ?? 0} bytes]`,
  };
  if (image.name) out.name = image.name;
  return out;
}

/** Replace image payloads so logs never contain base64. */
export function redactUserContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    const image = imageFromBlock(part);
    if (!image) return part;
    const row = asRecord(part) || {};
    return { ...row, ...redactImage(image), type: 'image' };
  });
}

export function redactSendBody(body: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!body) return null;
  const images = body.images;
  if (!Array.isArray(images)) return { ...body };
  return {
    ...body,
    images: images.map((item, i) => {
      const parsed = parseOneImage(item, i);
      if (parsed.ok && parsed.image) return redactImage(parsed.image);
      const row = asRecord(item);
      if (!row) return { data: '[redacted]' };
      return { ...row, data: '[redacted]' };
    }),
  };
}

export function imageDisplayName(image: Pick<MessageImage, 'mediaType' | 'name'>, index = 0): string {
  if (image.name && image.name.trim()) return image.name.trim();
  const ext = image.mediaType === 'image/jpeg' ? 'jpg' : (image.mediaType.split('/')[1] || 'png');
  return index ? `image-${index + 1}.${ext}` : `image.${ext}`;
}

export function imageDataUrl(image: Pick<MessageImage, 'mediaType' | 'data'>): string {
  return `data:${image.mediaType};base64,${image.data}`;
}
