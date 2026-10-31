import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './copyText';

describe('copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText,
      },
    });

    const result = await copyText('hello world');
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello world');
  });

  it('falls back to document.execCommand when navigator.clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', {});

    const execCommand = vi.fn().mockReturnValue(true);
    const appendChild = vi.fn();
    const remove = vi.fn();
    const select = vi.fn();

    vi.stubGlobal('document', {
      createElement: () => ({
        setAttribute: vi.fn(),
        style: {},
        select,
        remove,
      }),
      body: {
        appendChild,
      },
      execCommand,
    });

    const result = await copyText('fallback test');
    expect(result).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns false when both clipboard and execCommand fail', async () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('document', undefined);

    const result = await copyText('fail test');
    expect(result).toBe(false);
  });
});
