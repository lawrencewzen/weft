import { describe, expect, it } from 'vitest';
import { mockPathname, stripDriveLetter } from './mockPath';

describe('stripDriveLetter', () => {
  it('去掉 Windows 盘符', () => {
    expect(stripDriveLetter('/C:/api/v2/workspaces')).toBe('/api/v2/workspaces');
    expect(stripDriveLetter('/d:/api/settings')).toBe('/api/settings');
  });

  it('无盘符的路径不变', () => {
    expect(stripDriveLetter('/api/v2/workspaces')).toBe('/api/v2/workspaces');
    expect(stripDriveLetter('/')).toBe('/');
  });

  it('路径中间含冒号不误伤', () => {
    expect(stripDriveLetter('/api/a:b/c')).toBe('/api/a:b/c');
    expect(stripDriveLetter('/api/C:/x')).toBe('/api/C:/x');
    expect(stripDriveLetter('/ab:/x')).toBe('/ab:/x');
    expect(stripDriveLetter('/C:foo')).toBe('/C:foo');
  });
});

describe('mockPathname', () => {
  it('file URL 的盘符被去掉', () => {
    const url = new URL('/api/v2/workspaces', 'file:///C:/Users/a/x.html');
    expect(url.pathname).toBe('/C:/api/v2/workspaces');
    expect(mockPathname(url)).toBe('/api/v2/workspaces');
  });
});
