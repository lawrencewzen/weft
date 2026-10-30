import { SETTINGS_PAGES, type SettingsPage } from './data/settingsPages';

export type AppRoute =
  | { name: 'home' }
  | { name: 'conversation'; id: string }
  | { name: 'subagent'; conversationId: string; agentId: string }
  | { name: 'draft'; workspaceId: string }
  | { name: 'new' }
  | { name: 'settings'; page: SettingsPage };

function decodePart(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function asSettingsPage(raw: string | undefined): SettingsPage {
  if (raw && (SETTINGS_PAGES as readonly string[]).includes(raw)) return raw as SettingsPage;
  return 'general';
}

export function parseRoute(pathname: string): AppRoute {
  const raw = String(pathname || '');
  const trimmed = raw.replace(/\/+$/, '') || '/';
  const settings = /^\/settings(?:\/([^/]+))?$/.exec(trimmed);
  if (settings) {
    return { name: 'settings', page: asSettingsPage(settings[1]) };
  }
  const sub = /^\/c\/([^/]+)\/a\/([^/]+)$/.exec(trimmed);
  if (sub) {
    return { name: 'subagent', conversationId: decodePart(sub[1]), agentId: decodePart(sub[2]) };
  }
  const conv = /^\/c\/([^/]+)$/.exec(trimmed);
  if (conv) {
    return { name: 'conversation', id: decodePart(conv[1]) };
  }
  const draft = /^\/w\/([^/]+)\/new$/.exec(trimmed);
  if (draft) {
    return { name: 'draft', workspaceId: decodePart(draft[1]) };
  }
  if (trimmed === '/new') {
    return { name: 'new' };
  }
  return { name: 'home' };
}

/**
 * Settings is an overlay: keep showing the conversation / draft that was open
 * underneath, including the first paint after `/settings` replaces the path.
 */
export function viewRouteWhileSettings(
  previous: AppRoute | null | undefined,
  behindPath?: string | null,
): AppRoute {
  if (previous && previous.name !== 'home' && previous.name !== 'settings') return previous;
  if (behindPath) {
    const behind = parseRoute(behindPath);
    if (behind.name !== 'settings' && behind.name !== 'home') return behind;
  }
  return previous && previous.name !== 'settings' ? previous : { name: 'home' };
}
