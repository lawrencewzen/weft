// Minimal in-memory zip writer: deflate (or store when it does not shrink), UTF-8 names.
// No zip64, no encryption, no streaming. Callers keep the total small (the report is capped at ~50MB).
import { crc32, deflateRawSync } from 'node:zlib';

const UTF8_FLAG = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

function dosDateTime(date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * @param {Array<{ name: string, data: Buffer | string, date?: Date }>} entries
 * @returns {Buffer}
 */
export function createZip(entries, { now = new Date() } = {}) {
  if (entries.length > MAX_ENTRIES) throw new Error('too many zip entries');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const deflated = raw.length ? deflateRawSync(raw) : raw;
    const useDeflate = raw.length > 0 && deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    if (raw.length > MAX_BYTES || body.length > MAX_BYTES || offset > MAX_BYTES) throw new Error('zip entry too large');
    const method = useDeflate ? 8 : 0;
    const { time, day } = dosDateTime(entry.date ?? now);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(UTF8_FLAG, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(day, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}
