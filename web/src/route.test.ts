import { describe, expect, it } from 'vitest';
import { parseRoute } from './route';

describe('parseRoute', () => {
  it('treats /next/ and unknown paths as home', () => {
    expect(parseRoute('/next/')).toEqual({ name: 'home' });
    expect(parseRoute('/next')).toEqual({ name: 'home' });
    expect(parseRoute('/next/some/deep/route')).toEqual({ name: 'home' });
    expect(parseRoute('/')).toEqual({ name: 'home' });
  });

  it('reads /next/c/<id> without a router library', () => {
    expect(parseRoute('/next/c/abc')).toEqual({ name: 'conversation', id: 'abc' });
    expect(parseRoute('/next/c/abc/')).toEqual({ name: 'conversation', id: 'abc' });
    expect(parseRoute('/next/c/cid%2F1')).toEqual({ name: 'conversation', id: 'cid/1' });
  });

  it('reads /next/w/<workspace id>/new as a draft', () => {
    expect(parseRoute('/next/w/ws1/new')).toEqual({ name: 'draft', workspaceId: 'ws1' });
    expect(parseRoute('/next/w/ws%2F1/new/')).toEqual({ name: 'draft', workspaceId: 'ws/1' });
  });
});
