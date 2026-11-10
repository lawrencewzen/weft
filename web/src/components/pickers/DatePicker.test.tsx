/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatePicker } from './DatePicker';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('DatePicker component', () => {
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
    // Clean up any remaining popups
    document.querySelectorAll('.picker-popup').forEach((el) => el.remove());
  });

  it('normalizes 2026/11/10 and 20261110 on blur', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<DatePicker value="2026-11-01" onChange={onChange} testId="date-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="date-in"]');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('2026-11-01');

    act(() => {
      setInputValue(input!, '2026/11/10');
    });
    act(() => {
      input?.focus();
      input?.blur();
    });

    expect(onChange).toHaveBeenCalledWith('2026-11-10');
    expect(input?.value).toBe('2026-11-10');

    act(() => {
      setInputValue(input!, '20261115');
    });
    act(() => {
      input?.focus();
      input?.blur();
    });

    expect(onChange).toHaveBeenCalledWith('2026-11-15');
    expect(input?.value).toBe('2026-11-15');
  });

  it('reverts invalid date or date before min on blur', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <DatePicker value="2026-11-10" min="2026-11-05" onChange={onChange} testId="date-in" />,
      );
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="date-in"]');

    // Invalid date
    act(() => {
      setInputValue(input!, 'not-a-date');
    });
    act(() => {
      input?.focus();
      input?.blur();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(input?.value).toBe('2026-11-10');

    // Date earlier than min
    act(() => {
      setInputValue(input!, '2026-11-02');
    });
    act(() => {
      input?.focus();
      input?.blur();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(input?.value).toBe('2026-11-10');
  });

  it('opens popup, displays month header in zh and en, starts weekdays on Monday', () => {
    act(() => {
      root?.render(<DatePicker value="2026-11-10" onChange={vi.fn()} testId="date-in" lang="zh" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="date-in"]');
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    let popup = document.querySelector('.date-picker-popup');
    expect(popup).not.toBeNull();
    const title = popup?.querySelector('[data-testid="date-picker-header-title"]');
    expect(title?.textContent).toBe('2026年11月');

    // Check en header
    act(() => {
      root?.render(<DatePicker value="2026-11-10" onChange={vi.fn()} testId="date-in" lang="en" />);
    });
    popup = document.querySelector('.date-picker-popup');
    const titleEn = popup?.querySelector('[data-testid="date-picker-header-title"]');
    expect(titleEn?.textContent).toBe('November 2026');
  });

  it('marks dates before min as disabled and ignores clicking them', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <DatePicker value="2026-11-10" min="2026-11-08" onChange={onChange} testId="date-in" />,
      );
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="date-in"]');
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const popup = document.querySelector('.date-picker-popup');
    const disabledCell = popup?.querySelector<HTMLButtonElement>('[data-testid="date-picker-cell-2026-11-05"]');
    expect(disabledCell?.disabled).toBe(true);
    expect(disabledCell?.classList.contains('is-disabled')).toBe(true);

    act(() => {
      disabledCell?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clicking a valid date calls onChange and closes popup', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <DatePicker value="2026-11-10" min="2026-11-01" onChange={onChange} testId="date-in" />,
      );
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="date-in"]');
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const popup = document.querySelector('.date-picker-popup');
    const cell18 = popup?.querySelector<HTMLButtonElement>('[data-testid="date-picker-cell-2026-11-18"]');
    expect(cell18).not.toBeNull();

    act(() => {
      cell18?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith('2026-11-18');
    expect(document.querySelector('.date-picker-popup')).toBeNull();
  });

  it('navigates previous and next month buttons', () => {
    act(() => {
      root?.render(<DatePicker value="2026-11-10" onChange={vi.fn()} testId="date-in" lang="zh" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="date-in"]');
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const popup = document.querySelector('.date-picker-popup');
    const prevBtn = popup?.querySelector<HTMLButtonElement>('[data-testid="date-picker-prev-month"]');
    const nextBtn = popup?.querySelector<HTMLButtonElement>('[data-testid="date-picker-next-month"]');
    const title = popup?.querySelector('[data-testid="date-picker-header-title"]');

    // Click prev month -> 2026年10月
    act(() => {
      prevBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(title?.textContent).toBe('2026年10月');

    // Click next month twice -> 2026年12月
    act(() => {
      nextBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      nextBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(title?.textContent).toBe('2026年12月');
  });

  it('supports keyboard navigation with arrow keys, PageUp/Down, and Enter', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<DatePicker value="2026-11-10" onChange={onChange} testId="date-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="date-in"]');
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const trigger = host?.querySelector<HTMLDivElement>('.picker-trigger');

    // ArrowRight: 2026-11-10 -> 2026-11-11
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    // ArrowDown: 2026-11-11 -> 2026-11-18 (+7 days)
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });

    // Enter commits 2026-11-18 and closes
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith('2026-11-18');
    const popup = document.querySelector('.date-picker-popup');
    expect(popup).toBeNull();
  });

  it('Esc closes popup without committing', () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<DatePicker value="2026-11-10" onChange={onChange} testId="date-in" />);
    });

    const input = host?.querySelector<HTMLInputElement>('input[data-testid="date-in"]');
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    let popup = document.querySelector('.date-picker-popup');
    expect(popup).not.toBeNull();

    const trigger = host?.querySelector<HTMLDivElement>('.picker-trigger');
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    popup = document.querySelector('.date-picker-popup');
    expect(popup).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
