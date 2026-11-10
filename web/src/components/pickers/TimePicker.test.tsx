/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computePopupPosition } from './pickerUtils';
import { TimePicker } from './TimePicker';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('TimePicker component', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (host) {
      host.remove();
      host = null;
    }
    // Clean up any left over portal popups
    document.querySelectorAll('.picker-popup').forEach((el) => el.remove());
  });

  it('normalizes 9:5 to 09:05 on blur', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<TimePicker value="09:00" onChange={onChange} testId="time-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="time-in"]');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('09:00');

    act(() => {
      setInputValue(input!, '9:5');
    });
    act(() => {
      input?.focus();
      input?.blur();
    });

    expect(onChange).toHaveBeenCalledWith('09:05');
    expect(input?.value).toBe('09:05');
  });

  it('normalizes 0905 and single digit 9 on blur', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<TimePicker value="10:00" onChange={onChange} testId="time-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="time-in"]');

    act(() => {
      setInputValue(input!, '0905');
    });
    act(() => {
      input?.focus();
      input?.blur();
    });
    expect(onChange).toHaveBeenCalledWith('09:05');

    act(() => {
      setInputValue(input!, '9');
    });
    act(() => {
      input?.focus();
      input?.blur();
    });
    expect(onChange).toHaveBeenCalledWith('09:00');
  });

  it('reverts invalid input on blur without calling onChange', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<TimePicker value="10:30" onChange={onChange} testId="time-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="time-in"]');

    act(() => {
      setInputValue(input!, '25:00');
    });
    act(() => {
      input?.focus();
      input?.blur();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(input?.value).toBe('10:30');

    act(() => {
      setInputValue(input!, 'invalid');
    });
    act(() => {
      input?.focus();
      input?.blur();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(input?.value).toBe('10:30');
  });

  it('opens popup on click, shows hours and minutes', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<TimePicker value="14:20" onChange={onChange} testId="time-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="time-in"]');

    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const popup = document.querySelector('.time-picker-popup');
    expect(popup).not.toBeNull();

    // Check selected hour (14) and selected minute (20)
    const selHour = popup?.querySelector('[data-testid="time-in-hour-14"]');
    expect(selHour?.classList.contains('is-selected')).toBe(true);

    const selMin = popup?.querySelector('[data-testid="time-in-min-20"]');
    expect(selMin?.classList.contains('is-selected')).toBe(true);
  });

  it('does not select any minute when minute is not a multiple of 5', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<TimePicker value="14:23" onChange={onChange} testId="time-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="time-in"]');

    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const popup = document.querySelector('.time-picker-popup');
    const minCol = popup?.querySelector('[data-testid="time-picker-minutes-col"]');
    const selectedMin = minCol?.querySelector('.is-selected');
    expect(selectedMin).toBeNull();
  });

  it('clicking hour updates hour without closing popup; clicking minute updates minute and closes popup', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<TimePicker value="09:00" onChange={onChange} testId="time-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="time-in"]');

    // Open popup
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    let popup = document.querySelector('.time-picker-popup');
    expect(popup).not.toBeNull();

    // Click hour 11
    const hour11 = popup?.querySelector<HTMLButtonElement>('[data-testid="time-in-hour-11"]');
    act(() => {
      hour11?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith('11:00');
    // Popup still open
    popup = document.querySelector('.time-picker-popup');
    expect(popup).not.toBeNull();

    // Click minute 45
    const min45 = popup?.querySelector<HTMLButtonElement>('[data-testid="time-in-min-45"]');
    act(() => {
      min45?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith('11:45');
    // Popup closed
    popup = document.querySelector('.time-picker-popup');
    expect(popup).toBeNull();
  });

  it('Esc closes popup and returns focus to input', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<TimePicker value="09:00" onChange={onChange} testId="time-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="time-in"]');
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    let popup = document.querySelector('.time-picker-popup');
    expect(popup).not.toBeNull();

    const trigger = host?.querySelector<HTMLDivElement>('.picker-trigger');
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    popup = document.querySelector('.time-picker-popup');
    expect(popup).toBeNull();
  });

  it('supports keyboard navigation with arrow keys and Enter', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<TimePicker value="09:00" onChange={onChange} testId="time-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="time-in"]');
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const trigger = host?.querySelector<HTMLDivElement>('.picker-trigger');

    // Arrow down increments hour (09 -> 10)
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('10:00');

    // Arrow right switches to minute column
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    // Arrow down in minute column steps 5 min (00 -> 05)
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('10:05');

    // Enter commits and closes
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    const popup = document.querySelector('.time-picker-popup');
    expect(popup).toBeNull();
  });

  it('opens with 09 highlighted and both columns scrolled to center the selection', () => {
    act(() => {
      root?.render(<TimePicker value="09:00" onChange={() => {}} testId="time-in" />);
    });
    const input = host?.querySelector<HTMLInputElement>('input[data-testid="time-in"]');
    act(() => {
      input?.click();
    });
    const hour09 = document.querySelector<HTMLElement>('[data-testid="time-in-hour-09"]');
    const min00 = document.querySelector<HTMLElement>('[data-testid="time-in-min-00"]');
    expect(hour09?.classList.contains('is-selected')).toBe(true);
    expect(min00?.classList.contains('is-selected')).toBe(true);
    // jsdom has no layout: clientHeight falls back to 192, item pitch is 30px.
    // 09 -> top 2 + 9*30 = 272, centered => 272 - 96 + 14 = 190.
    const hourCol = document.querySelector<HTMLElement>('[data-testid="time-picker-hours-col"]');
    expect(hourCol?.scrollTop).toBe(190);
    const hour09Top = 2 + 9 * 30;
    expect(hour09Top).toBeGreaterThanOrEqual(hourCol!.scrollTop);
    expect(hour09Top + 28).toBeLessThanOrEqual(hourCol!.scrollTop + 192);
    const minCol = document.querySelector<HTMLElement>('[data-testid="time-picker-minutes-col"]');
    expect(minCol?.scrollTop).toBe(0);
  });
});

describe('computePopupPosition', () => {
  it('anchors under the trigger and converts visual px to css px by zoom', () => {
    const c = computePopupPosition({ left: 450, top: 600, bottom: 630 }, { width: 135, height: 185 }, { width: 1440, height: 900 }, 0.9);
    expect(c.left).toBeCloseTo(500, 5);
    expect(c.top).toBeCloseTo((630 + 4) / 0.9, 5);
  });
  it('flips above when no room below and clamps horizontally', () => {
    const c = computePopupPosition({ left: 1430, top: 800, bottom: 830 }, { width: 135, height: 185 }, { width: 1440, height: 900 }, 1);
    expect(c.top).toBe(800 - 4 - 185);
    expect(c.left).toBe(1440 - 8 - 135);
  });
});
