import type { components } from '../../../src/v2/contract.gen';
import { reportFileList } from '../../src/data/reportDialog';
import type { MockDb } from './types';

type ReportRequest = components['schemas']['DiagnosticsReportRequest'];

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal store-only (no compression) zip writer. */
export function buildZip(entries: Array<{ name: string; text: string }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (arr: Uint8Array) => { chunks.push(arr); offset += arr.length; };
  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const data = enc.encode(entry.text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    const head = new Uint8Array(local.buffer);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    push(head);
    push(name);
    push(data);
  }
  const cdStart = offset;
  for (const c of central) push(c);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, offset - cdStart, true);
  end.setUint32(16, cdStart, true);
  push(new Uint8Array(end.buffer));
  const out = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

export function buildMockReport(db: MockDb, req: ReportRequest, version: string): Uint8Array {
  const placeholder = (name: string): string => {
    if (name === 'report.txt') return `Weft ${version}\n\n${req.description || '(no description)'}\n`;
    if (name === 'system.txt') return 'prototype: mock system info\n';
    if (name === 'doctor.txt') return 'prototype: mock doctor output\n';
    if (name === 'settings.json') return JSON.stringify({ ...db.settings, apiKeys: '[redacted]' }, null, 2);
    if (name.startsWith('conversation-')) return JSON.stringify({ id: req.conversationId, mock: true }, null, 2);
    return 'prototype: mock log\n';
  };
  const names = reportFileList(req).map((n) => n.replace('…', ''));
  return buildZip(names.map((name) => ({ name, text: placeholder(name) })));
}
