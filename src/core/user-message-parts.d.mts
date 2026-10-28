/** Types for `user-message-parts.mjs` (paste / attached-file blocks). */

export const PASTE_PREVIEW_LINES: number;
export const WEFT_UPLOADS_PREFIX: string;
export const WEFT_GITIGNORE: string;
export const UPLOAD_NAME_MAX: number;

export type AttachedFileRef = {
  path: string;
  bytes?: number;
  name?: string;
};

export type ParsedPaste = {
  text: string;
  lines: number;
  chars: number;
  preview: string;
};

export type ParsedAttachedFile = {
  path: string;
  name: string;
  bytes: number;
};

export type UserMessagePasteMeta = {
  lines: number;
  chars: number;
  preview: string;
};

export type ParsedUserMessageParts = {
  text: string;
  pastes: UserMessagePasteMeta[];
  files: ParsedAttachedFile[];
  pasteTexts: string[];
};

export function posixRel(p: unknown): string;
export function lineCount(text: unknown): number;
export function pastePreview(text: unknown, maxLines?: number): string;
export function formatPasteBlock(text: unknown): string;
export function parsePasteBlock(text: unknown): ParsedPaste | null;
export function formatFileSize(bytes: unknown): string;
export function formatAttachedFilesBlock(files?: ReadonlyArray<AttachedFileRef> | null): string;
export function parseAttachedFilesBlock(text: unknown): ParsedAttachedFile[] | null;
export function basenamePosix(rel: unknown): string;
export function isWeftUploadRel(rel: unknown): boolean;
export function sanitizeUploadName(raw: unknown): string;
export function mediaTypeFromName(name: unknown): string;
export function parseUserMessageParts(content: unknown): ParsedUserMessageParts;
export function extractPasteTexts(content: unknown): string[];
