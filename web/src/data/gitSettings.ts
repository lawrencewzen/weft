import type { GitConnection, GitConnectionWrite } from './api';

export type GitKind = GitConnection['kind'];

export const GIT_KINDS: GitKind[] = ['gitlab-self', 'gitlab-com', 'other'];

export function gitlabTokenPage(baseUrl: string): string {
  const text = String(baseUrl || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}/-/user_settings/personal_access_tokens`;
  } catch {
    return '';
  }
}

export function hostLabel(baseUrl: string): string {
  return String(baseUrl || '').replace(/^https?:\/\//, '');
}

export function dirBasename(input: string): string {
  const text = String(input || '').replace(/[\\/]+$/, '');
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || text;
}

export function gitlabComUrl(): string {
  return 'https://gitlab.com';
}

export type GitForm = {
  kind: GitKind;
  name: string;
  baseUrl: string;
  token: string;
  allowHttp: boolean;
  caFile: string;
};

export function emptyGitForm(): GitForm {
  return {
    kind: 'gitlab-self',
    name: '',
    baseUrl: '',
    token: '',
    allowHttp: false,
    caFile: '',
  };
}

export function formFromConnection(conn: GitConnection): GitForm {
  return {
    kind: conn.kind,
    name: conn.name || '',
    baseUrl: conn.kind === 'gitlab-com' ? gitlabComUrl() : (conn.baseUrl || ''),
    token: '',
    allowHttp: conn.allowHttp === true,
    caFile: conn.caFile || '',
  };
}

export function gitWriteBody(form: GitForm, opts: { includeToken: boolean; id?: string }): GitConnectionWrite {
  const body: GitConnectionWrite = {
    kind: form.kind,
    name: form.name.trim(),
    baseUrl: form.kind === 'gitlab-com' ? gitlabComUrl() : form.baseUrl.trim(),
    allowHttp: form.kind === 'gitlab-self' && form.allowHttp,
    caFile: form.caFile.trim(),
  };
  if (opts.id) body.id = opts.id;
  if (opts.includeToken) body.token = form.token;
  return body;
}

export function isGitlabKind(kind: string | undefined): boolean {
  return kind === 'gitlab-self' || kind === 'gitlab-com';
}
