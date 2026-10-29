export const SETTINGS_PAGES = ['general', 'providers', 'git', 'plugins', 'skills', 'about'] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];
