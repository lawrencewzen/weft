import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from './uuid';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('randomId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('generates a valid UUID v4 with crypto.randomUUID', () => {
    const id = randomId();
    expect(id).toMatch(UUID_V4_REGEX);

    const set = new Set<string>();
    for (let i = 0; i < 200; i++) {
      set.add(randomId());
    }
    expect(set.size).toBe(200);
  });

  it('falls back to crypto.getRandomValues when crypto.randomUUID is undefined', () => {
    const realCrypto = globalThis.crypto;
    const getRandomValuesSpy = vi.fn((arr: Uint8Array) => realCrypto.getRandomValues(arr));

    vi.stubGlobal('crypto', {
      randomUUID: undefined,
      getRandomValues: getRandomValuesSpy,
    });

    const id = randomId();
    expect(id).toMatch(UUID_V4_REGEX);
    expect(getRandomValuesSpy).toHaveBeenCalled();

    const set = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const generated = randomId();
      expect(generated).toMatch(UUID_V4_REGEX);
      set.add(generated);
    }
    expect(set.size).toBe(200);
  });

  it('falls back to Math.random when entire crypto is undefined', () => {
    vi.stubGlobal('crypto', undefined);

    const id = randomId();
    expect(id).toMatch(UUID_V4_REGEX);

    const set = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const generated = randomId();
      expect(generated).toMatch(UUID_V4_REGEX);
      set.add(generated);
    }
    expect(set.size).toBe(200);
  });

  it('falls back to getRandomValues if crypto.randomUUID throws', () => {
    const realCrypto = globalThis.crypto;
    const getRandomValuesSpy = vi.fn((arr: Uint8Array) => realCrypto.getRandomValues(arr));

    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new Error('randomUUID disabled');
      },
      getRandomValues: getRandomValuesSpy,
    });

    const id = randomId();
    expect(id).toMatch(UUID_V4_REGEX);
    expect(getRandomValuesSpy).toHaveBeenCalled();
  });

  it('falls back to Math.random if crypto.getRandomValues throws', () => {
    vi.stubGlobal('crypto', {
      randomUUID: undefined,
      getRandomValues: () => {
        throw new Error('getRandomValues failed');
      },
    });

    const id = randomId();
    expect(id).toMatch(UUID_V4_REGEX);
  });
});
