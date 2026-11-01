// Workspace text encoding for Chinese Windows (ACP/OEMCP 936 / GBK).
// Detect from disk bytes on each call; do not cache. Encode-to-GBK uses
// iconv-lite (TextEncoder has no gbk). Decode uses Node TextDecoder.
import iconv from 'iconv-lite';
import { FileError, LineScanner, err, ok } from '@earendil-works/pi-durable/env';

export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** win32 always; elsewhere only when WEFT_TEXT_ENCODING_DETECT=1. */
export function isTextEncodingDetectEnabled(platform = process.platform, env = process.env) {
  if (platform === 'win32') return true;
  return String(env?.WEFT_TEXT_ENCODING_DETECT ?? '').trim() === '1';
}

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Buffer.from(bytes ?? []);
}

function hasUtf8Bom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

/**
 * 'utf8-bom' | 'utf8' | 'gbk'. Pure ASCII is 'utf8'. Invalid UTF-8 that
 * decodes as GBK without U+FFFD is 'gbk'; otherwise keep utf8 (status quo).
 */
export function detect(bytes) {
  const buf = asBuffer(bytes);
  if (hasUtf8Bom(buf)) return 'utf8-bom';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf8';
  } catch {
    // not strict utf8
  }
  const gbk = new TextDecoder('gbk').decode(buf);
  if (!gbk.includes('\uFFFD')) return 'gbk';
  return 'utf8';
}

/** Match Node fs.readFile utf8: keep a leading U+FEFF. GBK via TextDecoder. */
export function decode(bytes, enc) {
  const buf = asBuffer(bytes);
  if (enc === 'gbk') return new TextDecoder('gbk').decode(buf);
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);
}

function encodeGbk(text) {
  for (const ch of text) {
    const encoded = iconv.encode(ch, 'gbk');
    if (iconv.decode(encoded, 'gbk') !== ch) {
      const cp = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      const shown = JSON.stringify(ch);
      throw new Error(
        `Cannot encode character ${shown} (U+${cp}) to GBK; the file is GBK encoded`,
      );
    }
  }
  return iconv.encode(text, 'gbk');
}

/** utf8-bom always writes a BOM and does not double one already in `text`. */
export function encode(text, enc) {
  const value = String(text ?? '');
  if (enc === 'gbk') return encodeGbk(value);
  const body = enc === 'utf8-bom' && value.startsWith('\uFEFF') ? value.slice(1) : value;
  const utf8 = Buffer.from(body, 'utf8');
  if (enc === 'utf8-bom') return Buffer.concat([UTF8_BOM, utf8]);
  return utf8;
}

export function createStringTextLineReader(text) {
  let buffered = String(text ?? '');
  let closed = false;
  return {
    async readLine(_context) {
      if (closed) return err(new FileError('invalid', 'Text line reader is closed'));
      const newline = buffered.indexOf('\n');
      if (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return ok({ text: line, terminated: true });
      }
      if (buffered.length === 0) return ok(undefined);
      const line = buffered;
      buffered = '';
      return ok({ text: line, terminated: false });
    },
    async close(_context) {
      closed = true;
      buffered = '';
    },
  };
}

class Utf8ViewBinaryReader {
  constructor(inner, utf8Bytes, path) {
    this.inner = inner;
    this.bytes = utf8Bytes;
    this.path = path;
    this.closed = false;
  }

  async info(context) {
    const innerInfo = await this.inner.info(context);
    if (!innerInfo.ok) return innerInfo;
    return ok({ ...innerInfo.value, size: this.bytes.length });
  }

  async read(offset, length, _context) {
    if (this.closed) return err(new FileError('invalid', 'Binary reader is closed', this.path));
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return err(new FileError('invalid', 'Offset and length must be non-negative safe integers', this.path));
    }
    if (offset >= this.bytes.length || length === 0) return ok(new Uint8Array(0));
    return ok(this.bytes.subarray(offset, offset + length));
  }

  async scanLines(options, _context) {
    if (this.closed) return err(new FileError('invalid', 'Binary reader is closed', this.path));
    let scanner;
    try {
      scanner = new LineScanner(options.startLine, options.endLine);
    } catch {
      return err(new FileError('invalid', 'Invalid line range', this.path));
    }
    scanner.push(this.bytes);
    return ok(scanner.finish());
  }

  async close(context) {
    this.closed = true;
    return this.inner.close(context);
  }
}

/**
 * Official createReadTool decodes via BinaryReader + UTF-8 TextDecoder.
 * Serve a UTF-8 view of GBK files so the read tool sees real Chinese.
 * readBinaryFile is unchanged and still returns on-disk bytes.
 */
export async function viewGbkReaderAsUtf8(reader, context) {
  const info = await reader.info(context);
  if (!info.ok) return ok(reader);
  const raw = await reader.read(0, info.value.size, context);
  if (!raw.ok) return ok(reader);
  if (detect(raw.value) !== 'gbk') return ok(reader);
  const utf8 = Buffer.from(decode(raw.value, 'gbk'), 'utf8');
  return ok(new Utf8ViewBinaryReader(reader, utf8, info.value.path));
}
