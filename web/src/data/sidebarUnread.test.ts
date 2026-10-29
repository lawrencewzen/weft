import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONV_LAST_OPENED_STORAGE_KEY,
  isConversationUnread,
  readLastOpenedMap,
  writeLastOpened,
} from './sidebarUnread';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}

describe('sidebarUnread', () => {
  let mem: MemoryStorage;

  beforeEach(() => {
    mem = new MemoryStorage();
    // @ts-expect-error test stub
    globalThis.localStorage = mem;
  });

  afterEach(() => {
    // @ts-expect-error test stub
    globalThis.localStorage = undefined;
  });

  describe('isConversationUnread', () => {
    it('returns false if the conversation is currently active', () => {
      expect(isConversationUnread({ id: 'c1', updatedAt: 2000 }, 'c1', { c1: 1000 })).toBe(false);
    });

    it('returns true if updatedAt is greater than lastOpened timestamp', () => {
      expect(isConversationUnread({ id: 'c1', updatedAt: 2000 }, 'other', { c1: 1000 })).toBe(true);
    });

    it('returns false if updatedAt is less than or equal to lastOpened timestamp', () => {
      expect(isConversationUnread({ id: 'c1', updatedAt: 1000 }, 'other', { c1: 1000 })).toBe(false);
      expect(isConversationUnread({ id: 'c1', updatedAt: 900 }, 'other', { c1: 1000 })).toBe(false);
    });

    it('returns false if lastOpened is not recorded (fails gracefully)', () => {
      expect(isConversationUnread({ id: 'c1', updatedAt: 2000 }, 'other', {})).toBe(false);
    });

    it('returns false for missing or non-positive updatedAt', () => {
      expect(isConversationUnread({ id: 'c1', updatedAt: 0 }, 'other', { c1: 1000 })).toBe(false);
      expect(isConversationUnread({ id: 'c1', updatedAt: null }, 'other', { c1: 1000 })).toBe(false);
      expect(isConversationUnread({ id: 'c1', updatedAt: undefined }, 'other', { c1: 1000 })).toBe(false);
    });
  });

  describe('readLastOpenedMap & writeLastOpened', () => {
    it('reads and writes to localStorage', () => {
      writeLastOpened('conv-1', 12345);
      expect(readLastOpenedMap()).toEqual({ 'conv-1': 12345 });

      writeLastOpened('conv-2', 67890);
      expect(readLastOpenedMap()).toEqual({ 'conv-1': 12345, 'conv-2': 67890 });
    });

    it('handles localStorage absence gracefully without throwing', () => {
      // @ts-expect-error test stub
      globalThis.localStorage = undefined;
      expect(readLastOpenedMap()).toEqual({});
      expect(() => writeLastOpened('c1', 100)).not.toThrow();
    });

    it('handles corrupt JSON in localStorage', () => {
      mem.setItem(CONV_LAST_OPENED_STORAGE_KEY, 'corrupt-json{{{');
      expect(readLastOpenedMap()).toEqual({});
    });
  });
});
