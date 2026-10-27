/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeSettings,
  navigate,
  openSettings,
  peekSettingsBehind,
  readAddressPath,
  rememberSettingsBehind,
  setAddressMode,
  subscribeAddress,
} from './nav';

describe('openSettings', () => {
  afterEach(() => {
    rememberSettingsBehind(null);
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('remembers the conversation under the overlay', () => {
    window.history.replaceState(null, '', '/c/c-rich');
    openSettings('general');
    expect(peekSettingsBehind()).toBe('/c/c-rich');
    expect(window.location.pathname).toBe('/settings/general');
  });

  it('does not overwrite the remembered page when switching settings tabs', () => {
    window.history.replaceState(null, '', '/w/ws1/new');
    openSettings('general');
    openSettings('providers');
    expect(peekSettingsBehind()).toBe('/w/ws1/new');
  });
});

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

describe('hash address mode', () => {
  afterEach(() => {
    setAddressMode('path');
    window.history.replaceState(null, '', '/');
  });

  it('reads and writes the fragment while keeping the pathname', () => {
    window.history.replaceState(null, '', '/before');
    setAddressMode('hash');
    expect(readAddressPath()).toBe('/');
    navigate('/c/c1');
    expect(readAddressPath()).toBe('/c/c1');
    expect(window.location.pathname).toBe('/before');
    navigate('/settings/general', { replace: true });
    expect(readAddressPath()).toBe('/settings/general');
  });

  it('notifies subscribers on navigate', () => {
    setAddressMode('hash');
    const fn = vi.fn();
    const off = subscribeAddress(fn);
    navigate('/c/c2');
    expect(fn).toHaveBeenCalled();
    off();
    fn.mockClear();
    navigate('/c/c3');
    expect(fn).not.toHaveBeenCalled();
  });
});
