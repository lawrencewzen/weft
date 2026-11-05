/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dropdown } from './Dropdown';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(node: Parameters<Root['render']>[0]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

async function cleanup() {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  if (host?.parentNode) host.parentNode.removeChild(host);
  host = null;
}

describe('Dropdown', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    document.documentElement.style.removeProperty('--ui-zoom');
    await cleanup();
  });

  it('flips up when space below is insufficient and space above is larger', async () => {
    // Set window height to 500
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 500 });
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1000 });

    const onSelect = vi.fn();
    await render(
      <Dropdown
        triggerTestId="test-trigger"
        triggerContent="Select"
        onSelect={onSelect}
        items={[
          { value: 'opt1', label: 'Option 1', testId: 'opt-1' },
          { value: 'opt2', label: 'Option 2', testId: 'opt-2' },
          { value: 'opt3', label: 'Option 3', testId: 'opt-3' },
        ]}
      />,
    );

    const trigger = host!.querySelector('[data-testid="test-trigger"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();

    // Mock button near bottom: top: 420, bottom: 460 (only 40px left below in 500px window)
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 420,
      bottom: 460,
      left: 100,
      right: 300,
      width: 200,
      height: 40,
      x: 100,
      y: 420,
      toJSON: () => {},
    });

    await act(async () => {
      trigger.click();
    });

    const menu = document.querySelector('[role="listbox"]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute('data-placement')).toBe('top');
    expect(menu.classList.contains('is-top')).toBe(true);
    expect(menu.style.bottom).toBeTruthy();
    expect(menu.style.top).toBe('');
  });

  it('expands downward when space below is sufficient', async () => {
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 600 });
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1000 });

    const onSelect = vi.fn();
    await render(
      <Dropdown
        triggerTestId="test-trigger"
        triggerContent="Select"
        onSelect={onSelect}
        items={[
          { value: 'opt1', label: 'Option 1', testId: 'opt-1' },
          { value: 'opt2', label: 'Option 2', testId: 'opt-2' },
        ]}
      />,
    );

    const trigger = host!.querySelector('[data-testid="test-trigger"]') as HTMLButtonElement;
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 50,
      bottom: 90,
      left: 100,
      right: 300,
      width: 200,
      height: 40,
      x: 100,
      y: 50,
      toJSON: () => {},
    });

    await act(async () => {
      trigger.click();
    });

    const menu = document.querySelector('[role="listbox"]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute('data-placement')).toBe('bottom');
    expect(menu.classList.contains('is-bottom')).toBe(true);
    expect(menu.style.top).toBeTruthy();
    expect(menu.style.bottom).toBe('');
  });

  it('closes on Escape and refocuses trigger', async () => {
    const onSelect = vi.fn();
    await render(
      <Dropdown
        triggerTestId="test-trigger"
        triggerContent="Select"
        onSelect={onSelect}
        items={[{ value: 'opt1', label: 'Option 1' }]}
      />,
    );

    const trigger = host!.querySelector('[data-testid="test-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('closes on click outside', async () => {
    const onSelect = vi.fn();
    await render(
      <Dropdown
        triggerTestId="test-trigger"
        triggerContent="Select"
        onSelect={onSelect}
        items={[{ value: 'opt1', label: 'Option 1' }]}
      />,
    );

    const trigger = host!.querySelector('[data-testid="test-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('closes on ancestor scroll and window resize, but not on menu internal scroll', async () => {
    const onSelect = vi.fn();
    await render(
      <Dropdown
        triggerTestId="test-trigger"
        triggerContent="Select"
        onSelect={onSelect}
        items={[{ value: 'opt1', label: 'Option 1' }]}
      />,
    );

    const trigger = host!.querySelector('[data-testid="test-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });
    const menu = document.querySelector('[role="listbox"]') as HTMLElement;
    expect(menu).not.toBeNull();

    // Internal scroll does not close
    await act(async () => {
      menu.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    // Ancestor scroll closes
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    // Reopen and test resize closes
    await act(async () => {
      trigger.click();
    });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('supports keyboard navigation: ArrowUp, ArrowDown, Enter to select', async () => {
    const onSelect = vi.fn();
    await render(
      <Dropdown
        triggerTestId="test-trigger"
        triggerContent="Select"
        onSelect={onSelect}
        items={[
          { value: 'opt1', label: 'Option 1', testId: 'opt-1' },
          { value: 'opt2', label: 'Option 2', testId: 'opt-2' },
          { value: 'opt3', label: 'Option 3', testId: 'opt-3' },
        ]}
      />,
    );

    const trigger = host!.querySelector('[data-testid="test-trigger"]') as HTMLButtonElement;

    // Press ArrowDown on closed trigger to open
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    // Press ArrowDown to move to second item
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const item2 = document.querySelector('[data-testid="opt-2"]') as HTMLElement;
    expect(item2.classList.contains('highlighted')).toBe(true);

    // Press ArrowUp to move back to first item
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    const item1 = document.querySelector('[data-testid="opt-1"]') as HTMLElement;
    expect(item1.classList.contains('highlighted')).toBe(true);

    // Press Enter to select
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('opt1', expect.objectContaining({ value: 'opt1' }));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('scrolls the selected option into view when opened', async () => {
    const scrollIntoViewMock = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;

    await render(
      <Dropdown
        triggerTestId="test-trigger"
        triggerContent="Select"
        value="opt2"
        onSelect={vi.fn()}
        items={[
          { value: 'opt1', label: 'Option 1', testId: 'opt-1' },
          { value: 'opt2', label: 'Option 2', testId: 'opt-2' },
        ]}
      />,
    );

    const trigger = host!.querySelector('[data-testid="test-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });

    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it('does not open when disabled', async () => {
    const onSelect = vi.fn();
    await render(
      <Dropdown
        disabled
        triggerTestId="test-trigger"
        triggerContent="Select"
        onSelect={onSelect}
        items={[{ value: 'opt1', label: 'Option 1' }]}
      />,
    );

    const trigger = host!.querySelector('[data-testid="test-trigger"]') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);

    await act(async () => {
      trigger.click();
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('correctly converts visual coordinates to CSS pixels when zoom = 0.9', async () => {
    document.documentElement.style.setProperty('--ui-zoom', '0.9');

    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 900 });
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });

    const onSelect = vi.fn();
    await render(
      <Dropdown
        variant="picker"
        align="right"
        minWidth={300}
        triggerTestId="test-trigger"
        triggerContent="Select"
        onSelect={onSelect}
        items={[
          { value: 'opt1', label: 'Option 1', testId: 'opt-1' },
          { value: 'opt2', label: 'Option 2', testId: 'opt-2' },
        ]}
      />,
    );

    const trigger = host!.querySelector('[data-testid="test-trigger"]') as HTMLButtonElement;

    // Visual coordinates for trigger button (what getBoundingClientRect returns under 0.9 zoom):
    // CSS left=1000 -> visual left = 900
    // CSS width=200 -> visual width = 180 (visual right = 1080, CSS right = 1200)
    // CSS top=200 -> visual top = 180
    // CSS height=40 -> visual height = 36 (visual bottom = 216, CSS bottom = 240)
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 180,
      bottom: 216,
      left: 900,
      right: 1080,
      width: 180,
      height: 36,
      x: 900,
      y: 180,
      toJSON: () => {},
    });

    await act(async () => {
      trigger.click();
    });

    const menu = document.querySelector('[role="listbox"]') as HTMLElement;
    expect(menu).not.toBeNull();
    // In CSS pixels:
    // rightCss = 1080 / 0.9 = 1200
    // calculatedWidth = max(300, 180 / 0.9 = 200) = 300
    // leftCss = 1200 - 300 = 900
    // bottomCss = 216 / 0.9 = 240
    // top = 240 + 4 = 244
    expect(menu.style.left).toBe('900px');
    expect(menu.style.top).toBe('244px');
    expect(menu.style.width).toBe('300px');
  });
});
