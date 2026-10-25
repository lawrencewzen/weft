/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { workspaceFileUrl } from './api';
import { isWorkspaceFileRequest, pathChipFromElement } from './pathChip';

describe('path chip click', () => {
  it('reads only data-path and data-line from a chip', () => {
    const chip = document.createElement('code');
    chip.className = 'md-path';
    chip.setAttribute('data-path', 'notes/today.md');
    chip.setAttribute('data-line', '3');
    const inner = document.createElement('span');
    chip.appendChild(inner);
    expect(pathChipFromElement(inner)).toEqual({ path: 'notes/today.md', line: 3 });
  });

  it('omits an invalid or missing line and ignores non-chips', () => {
    const chip = document.createElement('code');
    chip.className = 'md-path';
    chip.setAttribute('data-path', 'notes.txt');
    expect(pathChipFromElement(chip)).toEqual({ path: 'notes.txt' });
    chip.setAttribute('data-line', '0');
    expect(pathChipFromElement(chip)).toEqual({ path: 'notes.txt' });
    expect(pathChipFromElement(document.createElement('span'))).toBeNull();
  });

  it('hands a forged path to the files API and nowhere else', () => {
    const chip = document.createElement('code');
    chip.className = 'md-path';
    chip.setAttribute('data-path', '../../etc/passwd');
    const ref = pathChipFromElement(chip);
    expect(ref).toEqual({ path: '../../etc/passwd' });
    const url = workspaceFileUrl('ws1', ref!.path);
    expect(url).toBe('/api/v2/workspaces/ws1/files?path=..%2F..%2Fetc%2Fpasswd');
    expect(isWorkspaceFileRequest(url)).toBe(true);
    expect(url.startsWith('/api/v2/workspaces/')).toBe(true);
    expect(url).not.toMatch(/\/etc\/passwd$/);
    expect(isWorkspaceFileRequest('/etc/passwd')).toBe(false);
    expect(isWorkspaceFileRequest('file:///etc/passwd')).toBe(false);
    expect(isWorkspaceFileRequest('/api/v2/conversations/c1/diff?path=../../etc/passwd')).toBe(false);
  });
});
