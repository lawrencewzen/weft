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

  it('reads /next/c/<cid>/a/<aid> as a subagent view', () => {
    expect(parseRoute('/next/c/abc/a/abc:sub:1')).toEqual({
      name: 'subagent',
      conversationId: 'abc',
      agentId: 'abc:sub:1',
    });
    expect(parseRoute('/next/c/c%2F1/a/a%2F2/')).toEqual({
      name: 'subagent',
      conversationId: 'c/1',
      agentId: 'a/2',
    });
  });

  it('reads /next/w/<workspace id>/new as a draft', () => {
    expect(parseRoute('/next/w/ws1/new')).toEqual({ name: 'draft', workspaceId: 'ws1' });
    expect(parseRoute('/next/w/ws%2F1/new/')).toEqual({ name: 'draft', workspaceId: 'ws/1' });
  });

  it('reads /next/settings/<page>', () => {
    expect(parseRoute('/next/settings')).toEqual({ name: 'settings', page: 'general' });
    expect(parseRoute('/next/settings/')).toEqual({ name: 'settings', page: 'general' });
    expect(parseRoute('/next/settings/providers')).toEqual({ name: 'settings', page: 'providers' });
    expect(parseRoute('/next/settings/git/')).toEqual({ name: 'settings', page: 'git' });
    expect(parseRoute('/next/settings/plugins')).toEqual({ name: 'settings', page: 'plugins' });
    expect(parseRoute('/next/settings/skills')).toEqual({ name: 'settings', page: 'skills' });
    expect(parseRoute('/next/settings/about')).toEqual({ name: 'settings', page: 'about' });
    expect(parseRoute('/next/settings/nope')).toEqual({ name: 'settings', page: 'general' });
  });
});
