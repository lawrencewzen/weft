/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSettings, rememberSettingsBehind } from './nav';

describe('closeSettings', () => {
  afterEach(() => {
    rememberSettingsBehind(null);
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('returns to the remembered page when /settings was opened directly', () => {
    window.history.replaceState(null, '', '/settings/providers');
    rememberSettingsBehind('/w/ws1/new');
    closeSettings();
    expect(window.location.pathname).toBe('/w/ws1/new');
  });

  it('uses history.back when settings was opened from the app', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    window.history.replaceState({ weftSettings: true }, '', '/settings/general');
    closeSettings();
    expect(back).toHaveBeenCalledTimes(1);
  });
});
