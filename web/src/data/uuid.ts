function getCrypto(): (Crypto | { randomUUID?: () => string; getRandomValues?: (arr: Uint8Array) => Uint8Array }) | undefined {
  if (typeof globalThis !== 'undefined' && globalThis.crypto) {
    return globalThis.crypto;
  }
  if (typeof window !== 'undefined' && window.crypto) {
    return window.crypto;
  }
  return undefined;
}

function formatUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) {
      out += '-';
    }
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function pseudoRandomBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function randomId(): string {
  const c = getCrypto();
  if (c) {
    if (typeof c.randomUUID === 'function') {
      try {
        return c.randomUUID();
      } catch {
        // Fall back to getRandomValues
      }
    }
    if (typeof c.getRandomValues === 'function') {
      try {
        const bytes = new Uint8Array(16);
        c.getRandomValues(bytes);
        return formatUuid(bytes);
      } catch {
        // Fall back to Math.random
      }
    }
  }
  return formatUuid(pseudoRandomBytes());
}
