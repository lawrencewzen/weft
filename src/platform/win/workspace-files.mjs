// Right-pane file API encoding for Chinese Windows (ACP/OEMCP 936 / GBK).
// files.ts calls these; detect / decode / encode live in text-encoding.mjs.
import {
  decode,
  detect,
  encode,
  isTextEncodingDetectEnabled,
} from './text-encoding.mjs';

function fatalUtf8(buf) {
  new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

/**
 * When detection is off, return null so the caller keeps looksBinary + UTF-8.
 * When on: GBK is text; utf8-bom keeps a leading U+FEFF; NUL / not-text is binary.
 */
export function inspectWorkspaceText(buf, env = process.env, platform = process.platform) {
  if (!isTextEncodingDetectEnabled(platform, env)) return null;
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf ?? []);
  if (buf.includes(0)) return { binary: true, text: null };
  const enc = detect(buf);
  if (enc === 'gbk') {
    return { binary: false, text: decode(buf, 'gbk'), encoding: 'gbk' };
  }
  if (enc === 'utf8-bom') {
    return { binary: false, text: decode(buf, 'utf8-bom'), encoding: 'utf8-bom' };
  }
  try {
    fatalUtf8(buf);
    return { binary: false, text: decode(buf, 'utf8'), encoding: 'utf8' };
  } catch {
    return { binary: true, text: null };
  }
}

/**
 * Existing files keep the on-disk encoding (utf8-bom keeps the BOM).
 * Missing files and detection-off writes are UTF-8.
 * `before` is decoded with the same encoding so line diffs stay on characters.
 */
export function encodeWorkspaceSave(text, existingBytes, env = process.env, platform = process.platform) {
  const value = String(text ?? '');
  if (!isTextEncodingDetectEnabled(platform, env)) {
    const before = existingBytes && existingBytes.length ? existingBytes.toString('utf8') : '';
    return { bytes: Buffer.from(value, 'utf8'), before };
  }
  if (!existingBytes || existingBytes.length === 0) {
    return { bytes: encode(value, 'utf8'), before: existingBytes ? decode(existingBytes, 'utf8') : '' };
  }
  const enc = detect(existingBytes);
  const before = decode(existingBytes, enc);
  return { bytes: encode(value, enc), before };
}
