// Byte-limit clipping for text that may be GBK (Chinese Windows).
// Used by the AGENTS.md prompt cap. Built on text-encoding.mjs detect/decode;
// nothing here is cached.
import { detect } from './text-encoding.mjs';

/**
 * Byte length of the GBK / GB18030 character that starts at `i`.
 * ASCII is 1, a double-byte character is 2, a GB18030 four-byte character is 4.
 * A lone byte that cannot start a character counts as 1. The result may run
 * past the end of `buf`; callers compare against their own end.
 */
function gbkCharLength(buf, i) {
  const lead = buf[i];
  if (lead < 0x81 || lead === 0xff) return 1;
  const second = buf[i + 1];
  if (second >= 0x30 && second <= 0x39) return 4;
  return 2;
}

/** Index of the end of the last whole GBK character that ends at or before `limit`. */
function gbkBoundary(buf, limit) {
  let i = 0;
  let end = 0;
  while (i < buf.length) {
    const next = i + gbkCharLength(buf, i);
    if (next > limit) break;
    end = next;
    i = next;
  }
  return end;
}

/** Length of an incomplete UTF-8 sequence at the end of `buf` (0 when complete). */
function utf8IncompleteTail(buf) {
  for (let back = 1; back <= 3 && back <= buf.length; back += 1) {
    const byte = buf[buf.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    let need = 1;
    if ((byte & 0xe0) === 0xc0) need = 2;
    else if ((byte & 0xf0) === 0xe0) need = 3;
    else if ((byte & 0xf8) === 0xf0) need = 4;
    return need > back ? back : 0;
  }
  return 0;
}

function isStrictUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encoding of a file head that was cut at an arbitrary byte (so it may end in
 * half a character). The unfinished tail is dropped before detect() runs,
 * otherwise a UTF-8 cut would fail the strict UTF-8 check and could be taken
 * for GBK, and a GBK cut would leave a stray lead byte.
 */
export function detectTruncated(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const utf8Tail = utf8IncompleteTail(buf);
  const utf8Head = utf8Tail ? buf.subarray(0, buf.length - utf8Tail) : buf;
  if (isStrictUtf8(utf8Head)) return detect(utf8Head);
  // Not valid UTF-8 even without the tail: judge it as GBK, cut on a GBK boundary.
  return detect(buf.subarray(0, gbkBoundary(buf, buf.length)));
}

/**
 * Longest prefix of at most `limit` bytes that ends on a GBK character boundary.
 * Boundaries are counted from the start of the file, so a trail byte in the
 * 0x40-0x7E range is not mistaken for ASCII.
 */
export function clipGbkBytes(bytes, limit) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buf.length <= limit) return buf;
  return buf.subarray(0, gbkBoundary(buf, limit));
}
