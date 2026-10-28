/** User-message paste / attached-file blocks stored in Pi Durable TextContent. */

export const PASTE_PREVIEW_LINES = 8;
export const WEFT_UPLOADS_PREFIX = '.weft/uploads/';
export const WEFT_GITIGNORE = '*\n';
export const UPLOAD_NAME_MAX = 200;

const FILES_OPEN = '<attached_files>';
const FILES_CLOSE = '</attached_files>';
const FILES_INTRO = '用户附上了这些文件，需要时用读文件工具读取：';

const MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.xml', 'application/xml'],
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.ts', 'text/plain'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

export function posixRel(p) {
  return String(p ?? '').replaceAll('\\', '/');
}

export function lineCount(text) {
  return String(text ?? '').split('\n').length;
}

export function pastePreview(text, maxLines = PASTE_PREVIEW_LINES) {
  return String(text ?? '').split('\n').slice(0, maxLines).join('\n');
}

export function formatPasteBlock(text) {
  const body = String(text ?? '');
  return `<pasted_text lines="${lineCount(body)}">\n${body}\n</pasted_text>`;
}

export function parsePasteBlock(text) {
  const raw = String(text ?? '');
  const match = /^<pasted_text lines="(\d+)">\n([\s\S]*)\n<\/pasted_text>$/.exec(raw);
  if (!match) return null;
  const body = match[2];
  const lines = Number(match[1]);
  return {
    text: body,
    lines: Number.isFinite(lines) ? lines : lineCount(body),
    chars: body.length,
    preview: pastePreview(body),
  };
}

export function formatFileSize(bytes) {
  const n = Number(bytes);
  const size = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  return `${size} 字节`;
}

export function formatAttachedFilesBlock(files) {
  const rows = (files || []).map((file) => {
    const rel = posixRel(file?.path);
    return `- ${rel}（${formatFileSize(file?.bytes)}）`;
  });
  return `${FILES_OPEN}\n${FILES_INTRO}\n${rows.join('\n')}\n${FILES_CLOSE}`;
}

export function parseAttachedFilesBlock(text) {
  const raw = String(text ?? '');
  const match = /^<attached_files>\n([\s\S]*)\n<\/attached_files>$/.exec(raw);
  if (!match) return null;
  const files = [];
  for (const line of match[1].split('\n')) {
    const row = /^- (.+)（(\d+) 字节）$/.exec(line);
    if (!row) continue;
    const filePath = row[1];
    const bytes = Number(row[2]);
    files.push({
      path: filePath,
      name: basenamePosix(filePath),
      bytes: Number.isFinite(bytes) ? bytes : 0,
    });
  }
  return files;
}

export function basenamePosix(rel) {
  const n = posixRel(rel);
  const parts = n.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : n;
}

export function isWeftUploadRel(rel) {
  const n = posixRel(rel).replace(/^\.\//, '');
  const hay = process.platform === 'win32' ? n.toLowerCase() : n;
  const needle = process.platform === 'win32' ? WEFT_UPLOADS_PREFIX.toLowerCase() : WEFT_UPLOADS_PREFIX;
  if (!hay.startsWith(needle)) return false;
  const rest = n.slice(WEFT_UPLOADS_PREFIX.length);
  const parts = rest.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return false;
  return parts.length >= 2;
}

const WIN_BAD_CHARS = new Set(['<', '>', ':', '"', '|', '?', '*']);
const WIN_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function isWinReservedDeviceName(name) {
  const upper = name.toUpperCase();
  if (WIN_RESERVED.has(upper)) return true;
  const dot = name.indexOf('.');
  if (dot <= 0) return false;
  return WIN_RESERVED.has(upper.slice(0, dot));
}

export function sanitizeUploadName(raw) {
  const s = String(raw ?? '');
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '/' || s[i] === '\\') start = i + 1;
  }
  let out = '';
  for (const ch of s.slice(start)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) continue;
    if (ch === '/' || ch === '\\') continue;
    out += WIN_BAD_CHARS.has(ch) ? '_' : ch;
  }
  out = out.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!out || out === '.' || out === '..') return 'file';
  if (isWinReservedDeviceName(out)) out = `_${out}`;
  if (out.length > UPLOAD_NAME_MAX) out = out.slice(0, UPLOAD_NAME_MAX);
  if (!out || out === '.' || out === '..') return 'file';
  return out;
}

export function mediaTypeFromName(name) {
  const base = basenamePosix(name).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return MIME_BY_EXT.get(base.slice(dot)) || 'application/octet-stream';
}

function walkTextChunks(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (typeof block === 'string') {
      out.push(block);
      continue;
    }
    if (block && typeof block === 'object' && block.type !== 'toolCall' && typeof block.text === 'string') {
      out.push(block.text);
    }
  }
  return out;
}

function pasteMeta(paste) {
  return {
    lines: paste.lines,
    chars: paste.chars,
    preview: paste.preview,
  };
}

/** Split stored UserContent into view fields. Snapshot must not include paste bodies.
 *  Each Pi Durable TextContent is classified as a whole paste/files block or as body text. */
export function parseUserMessageParts(content) {
  const textParts = [];
  const pastes = [];
  const files = [];
  const pasteTexts = [];
  for (const chunk of walkTextChunks(content)) {
    const paste = parsePasteBlock(chunk);
    if (paste) {
      pastes.push(pasteMeta(paste));
      pasteTexts.push(paste.text);
      continue;
    }
    const attached = parseAttachedFilesBlock(chunk);
    if (attached) {
      files.push(...attached);
      continue;
    }
    if (chunk) textParts.push(chunk);
  }
  return {
    text: textParts.join(''),
    pastes,
    files,
    pasteTexts,
  };
}

export function extractPasteTexts(content) {
  return parseUserMessageParts(content).pasteTexts;
}
