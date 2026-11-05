import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecentFiles,
  getRecentFiles,
  recordRecentFile,
} from './recentFiles';

describe('recentFiles', () => {
  beforeEach(() => {
    clearRecentFiles();
  });

  it('records recent files in most-recent-first order', () => {
    recordRecentFile('ws1', 'a.txt');
    recordRecentFile('ws1', 'b.txt');
    recordRecentFile('ws1', 'c.txt');
    expect(getRecentFiles('ws1')).toEqual(['c.txt', 'b.txt', 'a.txt']);
  });

  it('deduplicates when an existing file is recorded again', () => {
    recordRecentFile('ws1', 'a.txt');
    recordRecentFile('ws1', 'b.txt');
    recordRecentFile('ws1', 'a.txt');
    expect(getRecentFiles('ws1')).toEqual(['a.txt', 'b.txt']);
  });

  it('keeps at most 8 recent files per workspace', () => {
    for (let i = 1; i <= 12; i += 1) {
      recordRecentFile('ws1', `file${i}.txt`);
    }
    const recent = getRecentFiles('ws1');
    expect(recent).toHaveLength(8);
    expect(recent[0]).toBe('file12.txt');
    expect(recent[7]).toBe('file5.txt');
  });

  it('isolates recent files across different workspaces', () => {
    recordRecentFile('ws1', 'file1.txt');
    recordRecentFile('ws2', 'file2.txt');
    expect(getRecentFiles('ws1')).toEqual(['file1.txt']);
    expect(getRecentFiles('ws2')).toEqual(['file2.txt']);
  });

  it('handles empty workspaceId or filePath gracefully', () => {
    recordRecentFile('', 'a.txt');
    recordRecentFile('ws1', '');
    expect(getRecentFiles('')).toEqual([]);
    expect(getRecentFiles('ws1')).toEqual([]);
  });
});
