import { describe, expect, it } from 'vitest';
import { shortenWorkspacePath } from './workspacePath';

describe('shortenWorkspacePath', () => {
  it('replaces a mac home prefix with ~ and keeps a short rest', () => {
    expect(shortenWorkspacePath('/Users/alice/Documents/weft')).toBe('~/Documents/weft');
    expect(shortenWorkspacePath('/Users/alice/weft', { home: '/Users/alice' })).toBe('~/weft');
    expect(shortenWorkspacePath('/Users/alice')).toBe('~');
  });

  it('keeps the last directory and ellipsizes the middle of a long mac path', () => {
    expect(shortenWorkspacePath(
      '/Users/alice/code/team/monorepo/apps/desktop/weft',
      { max: 18 },
    )).toBe('~/…/weft');
  });

  it('replaces a Windows home prefix with ~ and keeps a short rest', () => {
    expect(shortenWorkspacePath('C:\\Users\\bob\\Documents\\weft')).toBe('~\\Documents\\weft');
    expect(shortenWorkspacePath('C:\\Users\\bob\\weft', { home: 'C:\\Users\\bob' })).toBe('~\\weft');
    expect(shortenWorkspacePath('C:/Users/bob/Documents/weft')).toBe('~\\Documents\\weft');
  });

  it('keeps the last directory and ellipsizes the middle of a long Windows path', () => {
    expect(shortenWorkspacePath(
      'C:\\Users\\bob\\code\\team\\monorepo\\apps\\desktop\\weft',
    )).toBe('~\\…\\weft');
    expect(shortenWorkspacePath(
      'C:\\Users\\bob\\code\\team\\monorepo\\apps\\desktop\\weft',
      { max: 18 },
    )).toBe('~\\…\\weft');
  });

  it('uses an explicit home when the server provides one', () => {
    expect(shortenWorkspacePath('/home/alice/src/weft', { home: '/home/alice' })).toBe('~/src/weft');
    expect(shortenWorkspacePath('D:\\work\\weft', { home: 'D:\\work' })).toBe('~\\weft');
  });

  it('leaves a short non-home path unchanged', () => {
    expect(shortenWorkspacePath('/tmp/alpha')).toBe('/tmp/alpha');
    expect(shortenWorkspacePath('D:\\data\\weft')).toBe('D:\\data\\weft');
  });
});
