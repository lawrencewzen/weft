import { afterEach, describe, expect, it } from 'vitest';
import {
  clampNum,
  defaultLeftOpen,
  defaultRightOpen,
  isOverlayWidth,
  isRightOverlayWidth,
  LEFT_W_DEFAULT,
  LS_LEFT_OPEN,
  LS_LEFT_W,
  LS_OPEN_WORKSPACES,
  LS_RIGHT_OPEN,
  LS_RIGHT_TAB,
  LS_RIGHT_W,
  RIGHT_W_DEFAULT,
  readLeftWidth,
  readOpenWorkspaces,
  readRightTab,
  readRightWidth,
  writeLeftWidth,
  writeOpenWorkspaces,
  writeRightTab,
  writeRightWidth,
} from './layout';

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

describe('layout prefs', () => {
  afterEach(() => {
    // @ts-expect-error test stub
    globalThis.localStorage = undefined;
  });

  it('treats 860px and below as overlay and default-collapsed', () => {
    expect(isOverlayWidth(860)).toBe(true);
    expect(isOverlayWidth(859)).toBe(true);
    expect(isOverlayWidth(861)).toBe(false);
    expect(defaultLeftOpen(860)).toBe(false);
    expect(defaultLeftOpen(1440)).toBe(true);
  });

  it('defaults left width to 264 when nothing is stored', () => {
    const mem = new MemoryStorage();
    // @ts-expect-error test stub
    globalThis.localStorage = mem;
    expect(LEFT_W_DEFAULT).toBe(264);
    expect(readLeftWidth()).toBe(264);
  });

  it('clamps and persists width and open workspaces under weft_next_ keys', () => {
    const mem = new MemoryStorage();
    // @ts-expect-error test stub
    globalThis.localStorage = mem;
    writeLeftWidth(180);
    expect(readLeftWidth()).toBe(200);
    writeLeftWidth(500);
    expect(readLeftWidth()).toBe(420);
    writeLeftWidth(LEFT_W_DEFAULT);
    expect(mem.getItem(LS_LEFT_W)).toBe(String(LEFT_W_DEFAULT));
    writeOpenWorkspaces(['w1', 'w2']);
    expect(readOpenWorkspaces()).toEqual(['w1', 'w2']);
    expect(mem.getItem(LS_OPEN_WORKSPACES)).toContain('w1');
    expect(mem.getItem(LS_LEFT_OPEN)).toBeNull();
    expect(clampNum(Number.NaN, 200, 420)).toBe(200);
  });

  it('treats widths below 1180px as a right overlay and default-collapsed', () => {
    expect(isRightOverlayWidth(1179)).toBe(true);
    expect(isRightOverlayWidth(1180)).toBe(false);
    expect(defaultRightOpen(1179)).toBe(false);
    expect(defaultRightOpen(1440)).toBe(true);
  });

  it('clamps right width to 320–900 and persists tab under weft_next_ keys', () => {
    const mem = new MemoryStorage();
    // @ts-expect-error test stub
    globalThis.localStorage = mem;
    expect(readRightWidth()).toBe(RIGHT_W_DEFAULT);
    writeRightWidth(200);
    expect(readRightWidth()).toBe(320);
    writeRightWidth(1200);
    expect(readRightWidth()).toBe(900);
    writeRightWidth(RIGHT_W_DEFAULT);
    expect(mem.getItem(LS_RIGHT_W)).toBe(String(RIGHT_W_DEFAULT));
    writeRightTab('files');
    expect(readRightTab()).toBe('files');
    expect(mem.getItem(LS_RIGHT_TAB)).toBe('files');
    expect(mem.getItem(LS_RIGHT_OPEN)).toBeNull();
  });
});
