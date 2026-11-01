export const SETTINGS_PAGES = ['general', 'providers', 'git', 'glab', 'plugins', 'skills', 'about'] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];
