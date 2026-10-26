import type { SettingsPage } from './providerWizard';

export function conversationPath(id: string): string {
  return `/c/${encodeURIComponent(id)}`;
}

export function subagentPath(cid: string, agentId: string): string {
  return `/c/${encodeURIComponent(cid)}/a/${encodeURIComponent(agentId)}`;
}

export function draftPath(workspaceId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/new`;
}

export function homePath(): string {
  return '/';
}

export function settingsPath(page: SettingsPage = 'general'): string {
  return `/settings/${page}`;
}

export type NavigateOpts = { replace?: boolean; state?: unknown };

export function navigate(path: string, opts: NavigateOpts = {}): void {
  const url = path.startsWith('/') ? path : `/${path}`;
  const state = opts.state === undefined ? window.history.state : opts.state;
  if (opts.replace) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function openSettings(page: SettingsPage = 'general'): void {
  navigate(settingsPath(page), { state: { weftSettings: true } });
}

let settingsBehindPath: string | null = null;

export function rememberSettingsBehind(path: string | null): void {
  settingsBehindPath = path;
}

export function closeSettings(): void {
  const state = window.history.state as { weftSettings?: boolean } | null;
  if (state && state.weftSettings) {
    window.history.back();
    return;
  }
  const behind = settingsBehindPath;
  settingsBehindPath = null;
  navigate(behind || homePath(), { replace: true, state: null });
}
