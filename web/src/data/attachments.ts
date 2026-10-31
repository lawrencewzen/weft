import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_COUNT,
  IMAGE_MEDIA_TYPES,
  normalizeMediaType,
  type MessageImage,
} from '../../../src/v2/views/message-images';
import { randomId } from './uuid';

export { IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, IMAGE_MEDIA_TYPES, type MessageImage };

export type ImageAttachment = {
  id: string;
  kind: 'image';
  name: string;
  size: number;
  mediaType: MessageImage['mediaType'];
  data: string;
  previewUrl: string;
};

export type FileRefAttachment = {
  id: string;
  kind: 'file';
  path: string;
};

export type UploadAttachment = {
  id: string;
  kind: 'upload';
  name: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
  uploaded?: {
    path: string;
    name: string;
    bytes: number;
    mediaType: string;
  };
};

export type PasteAttachment = {
  id: string;
  kind: 'paste';
  text: string;
  lines: number;
  chars: number;
  name: string;
};

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 20;
export const PASTE_MAX_COUNT = 10;
export const PASTE_MAX_BYTES = 1024 * 1024;
export const PASTE_THRESHOLD_LINES = 8;
export const PASTE_THRESHOLD_CHARS = 800;

export function pasteLineCount(text: string): number {
  return String(text || '').split('\n').length;
}

export function isLongPaste(text: string): boolean {
  const lines = pasteLineCount(text);
  return lines >= PASTE_THRESHOLD_LINES || Boolean(text && text.length >= PASTE_THRESHOLD_CHARS);
}

export function pasteSummaryName(text: string, defaultName = ''): string {
  const first = String(text || '').split('\n').find((l) => l.trim());
  const trimmed = first ? first.trim().slice(0, 28) : '';
  return trimmed || defaultName;
}

export function createPasteAttachment(text: string, defaultName = ''): PasteAttachment {
  const lines = pasteLineCount(text);
  return {
    id: newId(),
    kind: 'paste',
    text,
    lines,
    chars: text.length,
    name: pasteSummaryName(text, defaultName),
  };
}

const localPastesStore = new Map<string, string[]>();

export function recordLocalPastes(id: string, pastes: string[]): void {
  localPastesStore.set(id, pastes);
}

export function getLocalPastes(id: string): string[] | undefined {
  return localPastesStore.get(id);
}

export function clearLocalPastes(): void {
  localPastesStore.clear();
}

export type ComposerHintKind =
  | 'too_large'
  | 'too_many'
  | 'bad_type'
  | 'no_vision'
  | 'outside_project';

export type ComposerHint = {
  kind: ComposerHintKind;
  name?: string;
};

function newId(): string {
  return randomId();
}

export function formatFileSize(bytes: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    return `${kb < 10 && !Number.isInteger(kb) ? kb.toFixed(1).replace(/\.0$/, '') : Math.round(kb)} KB`;
  }
  const mb = n / (1024 * 1024);
  return `${mb < 10 && !Number.isInteger(mb) ? mb.toFixed(1).replace(/\.0$/, '') : Math.round(mb)} MB`;
}

export function isImageMediaType(value: string | null | undefined): boolean {
  const type = normalizeMediaType(value);
  return Boolean(type && IMAGE_MEDIA_TYPES.has(type));
}

export function isImageFile(file: Pick<File, 'type' | 'name'>): boolean {
  if (isImageMediaType(file.type)) return true;
  const name = String(file.name || '').toLowerCase();
  return /\.(png|jpe?g|gif|webp)$/.test(name);
}

export function mediaTypeOfFile(file: Pick<File, 'type' | 'name'>): MessageImage['mediaType'] | null {
  const fromType = normalizeMediaType(file.type);
  if (fromType) return fromType;
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.webp')) return 'image/webp';
  return null;
}

export async function readAsBase64(file: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read failed'));
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(file);
    });
  }
  const buf = await file.arrayBuffer();
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buf).toString('base64');
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function fileToImageAttachment(file: File): Promise<ImageAttachment | { hint: ComposerHint }> {
  const mediaType = mediaTypeOfFile(file);
  if (!mediaType) return { hint: { kind: 'bad_type', name: file.name } };
  if (file.size > IMAGE_MAX_BYTES) return { hint: { kind: 'too_large', name: file.name } };
  const data = await readAsBase64(file);
  return {
    id: newId(),
    kind: 'image',
    name: file.name || 'image.png',
    size: file.size,
    mediaType,
    data,
    previewUrl: URL.createObjectURL(file),
  };
}

export function revokePreview(attachment: ImageAttachment): void {
  if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
}

export function toMessageImages(attachments: readonly ImageAttachment[]): MessageImage[] {
  return attachments.map((item) => ({
    mediaType: item.mediaType,
    data: item.data,
    name: item.name,
  }));
}

export function imageFingerprint(images: readonly MessageImage[]): string {
  return images.map((item) => `${item.name || ''}:${item.mediaType}:${item.data.length}`).join('|');
}

export function insertFileRef(text: string, relPath: string): string {
  const token = `@${relPath}`;
  if (!relPath || text.includes(token)) return text;
  const trimmed = text.replace(/\s+$/, '');
  return trimmed ? `${trimmed} ${token}` : token;
}

export function removeFileRef(text: string, relPath: string): string {
  if (!relPath) return text;
  const normPath = relPath.replaceAll('\\', '/');
  const token = `@${normPath}`;
  if (!text.includes(token)) return text;
  const cleaned = text
    .split(token)
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '');
  if (!cleaned.trim()) return '';
  return cleaned;
}

export type AtTrigger = {
  query: string;
  atIndex: number;
  cursorIndex: number;
};

export function matchAtTrigger(text: string, cursorIndex: number): AtTrigger | null {
  if (cursorIndex < 1 || cursorIndex > text.length) return null;
  const beforeCursor = text.slice(0, cursorIndex);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursor);
  if (!match) return null;
  const atIndex = match.index + (match[0].startsWith('@') ? 0 : 1);
  return {
    query: match[1],
    atIndex,
    cursorIndex,
  };
}

export function filterAtFiles(files: readonly string[], query: string, limit = 6): string[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) {
    return files.slice(0, limit);
  }
  const result: string[] = [];
  for (const file of files) {
    if (file.toLowerCase().includes(q)) {
      result.push(file);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function splitFilePath(filePath: string): { name: string; dir: string } {
  const normalized = filePath.replaceAll('\\', '/');
  const k = normalized.lastIndexOf('/');
  if (k >= 0) {
    return {
      name: normalized.slice(k + 1),
      dir: normalized.slice(0, k + 1),
    };
  }
  return {
    name: normalized,
    dir: '',
  };
}

export function applyAtSelection(
  text: string,
  filePath: string,
  trigger: Pick<AtTrigger, 'atIndex' | 'cursorIndex'>,
): { text: string; nextCursor: number } {
  const normPath = filePath.replaceAll('\\', '/');
  const before = text.slice(0, trigger.atIndex);
  const after = text.slice(trigger.cursorIndex);
  const inserted = `@${normPath} `;
  return {
    text: before + inserted + after,
    nextCursor: before.length + inserted.length,
  };
}

export function isFileRefInText(text: string, filePath: string): boolean {
  const p = filePath.replaceAll('\\', '/').trim();
  if (!p) return false;
  const token = `@${p}`;
  const normalized = ` ${text.replace(/\s+/g, ' ')} `;
  return normalized.includes(` ${token} `);
}

export function stepAtActiveIndex(
  currentIndex: number,
  total: number,
  direction: 'down' | 'up',
): number {
  if (total <= 0) return 0;
  if (direction === 'down') {
    return (currentIndex + 1) % total;
  }
  return (currentIndex - 1 + total) % total;
}

export function shouldResetAtActiveIndex(
  prevQuery: string | null,
  currentQuery: string | null,
  isOpening: boolean,
): boolean {
  if (isOpening) return true;
  if (currentQuery === null) return false;
  return prevQuery !== currentQuery;
}

export function resolveAtSelection(
  matchedFiles: readonly string[],
  activeIndex: number,
): string | null {
  if (matchedFiles.length === 0) return null;
  return matchedFiles[activeIndex] ?? matchedFiles[0] ?? null;
}

export function fromFileUrl(value: string): string | null {
  const text = String(value || '').trim();
  if (!/^file:/i.test(text)) return null;
  try {
    const url = new URL(text);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    return path.replaceAll('/', '\\').includes(':') ? path.replaceAll('/', '\\') : path;
  } catch {
    return null;
  }
}

export function posixPath(value: string): string {
  return String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
}

export function relativeToWorkspace(absPath: string, workspacePath: string): string | null {
  const a = posixPath(absPath);
  const w = posixPath(workspacePath);
  if (!a || !w) return null;
  if (a.toLowerCase() === w.toLowerCase()) return null;
  const prefix = `${w}/`;
  if (a.toLowerCase().startsWith(prefix.toLowerCase())) return a.slice(w.length + 1);
  return null;
}

export function filePathOf(file: File): string | null {
  const extra = file as File & { path?: unknown };
  return typeof extra.path === 'string' && extra.path.trim() ? extra.path.trim() : null;
}

export function pathsFromUriList(raw: string): string[] {
  const out: string[] = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const path = fromFileUrl(trimmed);
    if (path) out.push(path);
  }
  return out;
}

export function matchProjectPath(opts: {
  fileName: string;
  filePath?: string | null;
  uriPaths?: readonly string[];
  workspacePath?: string | null;
  treePaths?: readonly string[];
}): string | null {
  const workspacePath = opts.workspacePath || '';
  const candidates = [
    opts.filePath,
    ...(opts.uriPaths || []),
  ].filter((item): item is string => Boolean(item));
  for (const abs of candidates) {
    const rel = relativeToWorkspace(abs, workspacePath);
    if (rel) return rel;
  }
  const name = String(opts.fileName || '').trim();
  if (!name) return null;
  const hits = (opts.treePaths || []).filter((path) => {
    const parts = posixPath(path).split('/').filter(Boolean);
    return parts[parts.length - 1] === name;
  });
  return hits.length === 1 ? hits[0] : null;
}

export function addImages(
  current: readonly ImageAttachment[],
  incoming: readonly ImageAttachment[],
): { next: ImageAttachment[]; hint: ComposerHint | null } {
  if (!incoming.length) return { next: [...current], hint: null };
  const room = IMAGE_MAX_COUNT - current.length;
  if (room <= 0) {
    incoming.forEach(revokePreview);
    return { next: [...current], hint: { kind: 'too_many' } };
  }
  if (incoming.length > room) {
    incoming.slice(room).forEach(revokePreview);
    return { next: [...current, ...incoming.slice(0, room)], hint: { kind: 'too_many' } };
  }
  return { next: [...current, ...incoming], hint: null };
}
