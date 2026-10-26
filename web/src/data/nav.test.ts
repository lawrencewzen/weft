/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSettings, rememberSettingsBehind } from './nav';

describe('closeSettings', () => {
  afterEach(() => {
    rememberSettingsBehind(null);
    window.history.replaceState(null, '', '/next/');
    vi.restoreAllMocks();
  });

  it('returns to the remembered page when /next/settings was opened directly', () => {
    window.history.replaceState(null, '', '/next/settings/providers');
    rememberSettingsBehind('/next/w/ws1/new');
    closeSettings();
    expect(window.location.pathname).toBe('/next/w/ws1/new');
  });

  it('uses history.back when settings was opened from the app', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    window.history.replaceState({ weftSettings: true }, '', '/next/settings/general');
    closeSettings();
    expect(back).toHaveBeenCalledTimes(1);
  });
});
