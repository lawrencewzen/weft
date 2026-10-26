import { describe, expect, it } from 'vitest';
import {
  dirBasename,
  emptyGitForm,
  formFromConnection,
  gitlabComUrl,
  gitlabTokenPage,
  gitWriteBody,
  hostLabel,
  isGitlabKind,
} from './gitSettings';
import type { GitConnection } from './api';

function conn(extra?: Partial<GitConnection>): GitConnection {
  return {
    id: 'g1',
    name: 'Corp',
    kind: 'gitlab-self',
    baseUrl: 'https://gitlab.example.com',
    token: 'glpat-••••9k3q',
    hasToken: true,
    allowHttp: true,
    caFile: '',
    lastTest: { ok: true, username: 'zhangsan', error: '', errorText: '', at: '1' },
    ...extra,
  };
}

describe('git settings helpers', () => {
  it('builds a GitLab token page from the instance origin', () => {
    expect(gitlabTokenPage('https://gitlab.example.com/group/proj')).toBe(
      'https://gitlab.example.com/-/user_settings/personal_access_tokens',
    );
    expect(gitlabTokenPage('gitlab.com')).toBe(
      'https://gitlab.com/-/user_settings/personal_access_tokens',
    );
    expect(gitlabTokenPage('')).toBe('');
    expect(gitlabTokenPage('not a url ://')).toBe('');
  });

  it('omits the token when it was not edited', () => {
    const form = formFromConnection(conn());
    expect(form.token).toBe('');
    expect(gitWriteBody(form, { includeToken: false })).toEqual({
      kind: 'gitlab-self',
      name: 'Corp',
      baseUrl: 'https://gitlab.example.com',
      allowHttp: true,
      caFile: '',
    });
    expect(gitWriteBody({ ...form, token: 'glpat-new' }, { includeToken: true, id: 'g1' })).toEqual({
      id: 'g1',
      kind: 'gitlab-self',
      name: 'Corp',
      baseUrl: 'https://gitlab.example.com',
      allowHttp: true,
      caFile: '',
      token: 'glpat-new',
    });
  });

  it('pins GitLab.com and drops http unless the kind is self-hosted', () => {
    const form = emptyGitForm();
    form.kind = 'gitlab-com';
    form.name = 'GitLab.com';
    form.baseUrl = 'https://example.net';
    form.allowHttp = true;
    expect(gitWriteBody(form, { includeToken: true }).baseUrl).toBe(gitlabComUrl());
    expect(gitWriteBody(form, { includeToken: true }).allowHttp).toBe(false);
    expect(isGitlabKind('gitlab-com')).toBe(true);
    expect(isGitlabKind('other')).toBe(false);
    expect(hostLabel('https://gitlab.example.com')).toBe('gitlab.example.com');
    expect(dirBasename('D:\\work\\widget\\')).toBe('widget');
    expect(dirBasename('/tmp/alpha')).toBe('alpha');
  });
});
