import { describe, expect, it } from 'vitest';
import { parseRoute, viewRouteWhileSettings } from './route';

describe('parseRoute', () => {
  it('treats / and unknown paths as home', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/some/deep/route')).toEqual({ name: 'home' });
  });

  it('reads /c/<id> without a router library', () => {
    expect(parseRoute('/c/abc')).toEqual({ name: 'conversation', id: 'abc' });
    expect(parseRoute('/c/abc/')).toEqual({ name: 'conversation', id: 'abc' });
    expect(parseRoute('/c/cid%2F1')).toEqual({ name: 'conversation', id: 'cid/1' });
  });

  it('reads /c/<cid>/a/<aid> as a subagent view', () => {
    expect(parseRoute('/c/abc/a/abc:sub:1')).toEqual({
      name: 'subagent',
      conversationId: 'abc',
      agentId: 'abc:sub:1',
    });
    expect(parseRoute('/c/c%2F1/a/a%2F2/')).toEqual({
      name: 'subagent',
      conversationId: 'c/1',
      agentId: 'a/2',
    });
  });

  it('reads /w/<workspace id>/new as a draft', () => {
    expect(parseRoute('/w/ws1/new')).toEqual({ name: 'draft', workspaceId: 'ws1' });
    expect(parseRoute('/w/ws%2F1/new/')).toEqual({ name: 'draft', workspaceId: 'ws/1' });
  });

  it('reads /new as a no-project draft', () => {
    expect(parseRoute('/new')).toEqual({ name: 'new' });
    expect(parseRoute('/new/')).toEqual({ name: 'new' });
  });

  it('reads /settings/<page>', () => {
    expect(parseRoute('/settings')).toEqual({ name: 'settings', page: 'general' });
    expect(parseRoute('/settings/')).toEqual({ name: 'settings', page: 'general' });
    expect(parseRoute('/settings/providers')).toEqual({ name: 'settings', page: 'providers' });
    expect(parseRoute('/settings/git/')).toEqual({ name: 'settings', page: 'git' });
    expect(parseRoute('/settings/plugins')).toEqual({ name: 'settings', page: 'plugins' });
    expect(parseRoute('/settings/skills')).toEqual({ name: 'settings', page: 'skills' });
    expect(parseRoute('/settings/about')).toEqual({ name: 'settings', page: 'about' });
    expect(parseRoute('/settings/nope')).toEqual({ name: 'settings', page: 'general' });
  });
});

describe('viewRouteWhileSettings', () => {
  it('keeps the conversation that was open under the overlay', () => {
    expect(viewRouteWhileSettings({ name: 'conversation', id: 'c-rich' })).toEqual({
      name: 'conversation',
      id: 'c-rich',
    });
  });

  it('keeps a draft under the overlay', () => {
    expect(viewRouteWhileSettings({ name: 'draft', workspaceId: 'ws1' })).toEqual({
      name: 'draft',
      workspaceId: 'ws1',
    });
  });

  it('keeps a no-project draft under the overlay', () => {
    expect(viewRouteWhileSettings({ name: 'new' })).toEqual({ name: 'new' });
    expect(viewRouteWhileSettings({ name: 'home' }, '/new')).toEqual({ name: 'new' });
  });

  it('falls back to the path remembered before opening settings', () => {
    expect(viewRouteWhileSettings({ name: 'home' }, '/c/abc')).toEqual({
      name: 'conversation',
      id: 'abc',
    });
    expect(viewRouteWhileSettings(null, '/w/ws1/new')).toEqual({
      name: 'draft',
      workspaceId: 'ws1',
    });
  });

  it('does not treat /settings itself as the background', () => {
    expect(viewRouteWhileSettings({ name: 'settings', page: 'general' }, '/settings/providers')).toEqual({
      name: 'home',
    });
  });
});
