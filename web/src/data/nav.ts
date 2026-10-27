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

/**
 * Where the current route lives. The product uses the pathname; the prototype
 * (`web/proto`) opens a single file from `file://`, where pushState cannot change
 * the path, so it switches to the fragment (`#/c/<id>`) instead.
 */
export type AddressMode = 'path' | 'hash';

let addressMode: AddressMode = 'path';
let addressBound = false;
const addressListeners = new Set<() => void>();

function notifyAddress(): void {
  for (const listener of [...addressListeners]) listener();
}

function onAddressEvent(): void {
  notifyAddress();
}

function bindAddressEvents(): void {
  if (addressBound) return;
  addressBound = true;
  window.addEventListener('popstate', onAddressEvent);
  if (addressMode === 'hash') window.addEventListener('hashchange', onAddressEvent);
}

/** Prototype entry calls this before rendering; product code keeps the default. */
export function setAddressMode(mode: AddressMode): void {
  addressMode = mode;
  bindAddressEvents();
}

/** Current route path, always in the `/c/<id>` shape `parseRoute` understands. */
export function readAddressPath(): string {
  if (addressMode === 'hash') {
    const raw = window.location.hash.replace(/^#/, '');
    return raw || homePath();
  }
  return window.location.pathname;
}

/** Re-run `fn` on back/forward and on `navigate()`. Product used to listen on popstate itself. */
export function subscribeAddress(fn: () => void): () => void {
  bindAddressEvents();
  addressListeners.add(fn);
  return () => {
    addressListeners.delete(fn);
  };
}

export type NavigateOpts = { replace?: boolean; state?: unknown };

export function navigate(path: string, opts: NavigateOpts = {}): void {
  const url = path.startsWith('/') ? path : `/${path}`;
  const state = opts.state === undefined ? window.history.state : opts.state;
  if (addressMode === 'hash') {
    const target = `#${url}`;
    try {
      if (opts.replace) window.history.replaceState(state, '', target);
      else window.history.pushState(state, '', target);
    } catch {
      // file:// browsers that refuse history writes for fragments still accept this.
      if (opts.replace) window.location.replace(target);
      else window.location.hash = target;
    }
    notifyAddress();
    return;
  }
  if (opts.replace) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function openSettings(page: SettingsPage = 'general'): void {
  const current = readAddressPath();
  if (!/^\/settings(?:\/|$)/.test(current)) rememberSettingsBehind(current);
  navigate(settingsPath(page), { state: { weftSettings: true } });
}

let settingsBehindPath: string | null = null;

export function rememberSettingsBehind(path: string | null): void {
  settingsBehindPath = path;
}

export function peekSettingsBehind(): string | null {
  return settingsBehindPath;
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
