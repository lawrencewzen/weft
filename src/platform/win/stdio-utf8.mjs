/**
 * Windows stdio UTF-8.
 *
 * On zh-CN Windows, ACP/console code page is 936 (GBK). Node's
 * `process.stdout.write(string)` / `console.log` may transcode the JS string
 * through that code page when stdout is a file or pipe (not a console TTY).
 * `weft open` attaches the service's stdout/stderr to logs/service.log via
 * inherited file descriptors, so the ready line「打开新版界面：…」landed as
 * GBK bytes.
 *
 * Writing a Buffer skips that transcode. Wrap stdout/stderr so every string
 * write becomes UTF-8 bytes. Safe on non-Windows (already UTF-8).
 */
const MARK = Symbol.for('weft.utf8Stdio');

export function toUtf8Buffer(chunk, encoding) {
  if (chunk == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  const enc = encoding && typeof encoding === 'string' ? encoding : 'utf8';
  return Buffer.from(String(chunk), enc);
}

export function wrapUtf8Write(stream) {
  if (!stream || typeof stream.write !== 'function') return stream;
  if (stream[MARK]) return stream;
  const orig = stream.write.bind(stream);
  stream.write = function writeUtf8(chunk, encoding, cb) {
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    if (typeof chunk === 'string') {
      chunk = toUtf8Buffer(chunk, encoding);
      encoding = undefined;
    }
    return orig(chunk, encoding, cb);
  };
  stream[MARK] = true;
  try { stream.setDefaultEncoding?.('utf8'); } catch { /* ignore */ }
  return stream;
}

export function installUtf8Stdio(proc = process) {
  wrapUtf8Write(proc.stdout);
  wrapUtf8Write(proc.stderr);
  return proc;
}
