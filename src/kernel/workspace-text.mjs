/**
 * Bytes of a workspace file or a snapshot blob, as text.
 * Disk reads and git blobs both go through here, so the intranet GBK decoder
 * (src/platform/win/workspace-files.mjs) is a single edit.
 * The utf8 decode keeps a leading BOM as U+FEFF and replaces invalid sequences.
 */
export function decodeWorkspaceBytes(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  return bytes.toString('utf8');
}
