/**
 * Bytes of a workspace file or a snapshot blob, as text.
 * Disk reads (conversations.mjs readWorkspaceText) and git blobs both go
 * through here. When encoding detection is on, GBK is detected and decoded
 * with src/platform/win/text-encoding.mjs so the changes panel does not
 * show U+FFFD. Detection is always on for win32, and elsewhere only when
 * WEFT_TEXT_ENCODING_DETECT=1. Off, this stays a UTF-8 decode that keeps a
 * leading BOM as U+FEFF and replaces invalid sequences.
 */
import { decode, detect, isTextEncodingDetectEnabled } from '../platform/win/text-encoding.mjs';

export function decodeWorkspaceBytes(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (!isTextEncodingDetectEnabled()) return bytes.toString('utf8');
  return decode(bytes, detect(bytes));
}
