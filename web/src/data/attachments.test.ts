import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_COUNT,
  addImages,
  applyAtSelection,
  fileToImageAttachment,
  filterAtFiles,
  formatFileSize,
  insertFileRef,
  isFileRefInText,
  isImageFile,
  matchAtTrigger,
  matchProjectPath,
  mediaTypeOfFile,
  relativeToWorkspace,
  removeFileRef,
  resolveAtSelection,
  revokePreview,
  shouldResetAtActiveIndex,
  splitFilePath,
  stepAtActiveIndex,
  type ImageAttachment,
} from './attachments';

function image(partial: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: partial.id ?? 'a1',
    kind: 'image',
    name: partial.name ?? 'shot.png',
    size: partial.size ?? 12,
    mediaType: partial.mediaType ?? 'image/png',
    data: partial.data ?? 'AAAA',
    previewUrl: partial.previewUrl ?? 'blob:preview',
  };
}

describe('formatFileSize', () => {
  it('formats bytes, KB and MB the way the tags show', () => {
    expect(formatFileSize(248)).toBe('248 B');
    expect(formatFileSize(248 * 1024)).toBe('248 KB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('image file sniffing', () => {
  it('accepts png/jpeg/gif/webp by type or extension', () => {
    expect(isImageFile({ type: 'image/png', name: 'x' })).toBe(true);
    expect(isImageFile({ type: '', name: 'shot.JPG' })).toBe(true);
    expect(isImageFile({ type: 'text/plain', name: 'notes.md' })).toBe(false);
    expect(mediaTypeOfFile({ type: '', name: 'a.webp' })).toBe('image/webp');
  });
});

describe('project path matching', () => {
  it('turns an absolute workspace path into a relative path', () => {
    expect(relativeToWorkspace('D:\\work\\weft\\web\\src\\app.css', 'D:\\work\\weft')).toBe('web/src/app.css');
    expect(relativeToWorkspace('/tmp/out/secret.txt', '/tmp/weft')).toBeNull();
  });

  it('uses a unique tree filename when the OS path is missing', () => {
    expect(matchProjectPath({
      fileName: 'app.css',
      workspacePath: '/tmp/weft',
      treePaths: ['web/src/app.css', 'README.md'],
    })).toBe('web/src/app.css');
    expect(matchProjectPath({
      fileName: 'index.ts',
      workspacePath: '/tmp/weft',
      treePaths: ['src/index.ts', 'web/src/index.ts'],
    })).toBeNull();
  });
});

describe('file reference tokens', () => {
  it('inserts @path once and can take it back out', () => {
    expect(insertFileRef('', 'web/src/app.css')).toBe('@web/src/app.css');
    expect(insertFileRef('看一下', 'web/src/app.css')).toBe('看一下 @web/src/app.css');
    expect(insertFileRef('看一下 @web/src/app.css', 'web/src/app.css')).toBe('看一下 @web/src/app.css');
    expect(removeFileRef('看一下 @web/src/app.css 再改', 'web/src/app.css')).toBe('看一下 再改');
    expect(removeFileRef('@web/src/app.css 好的', 'web/src/app.css')).toBe('好的');
    expect(removeFileRef('@web/src/app.css', 'web/src/app.css')).toBe('');
    expect(removeFileRef('@web/src/app.css ', 'web/src/app.css')).toBe('');
    expect(removeFileRef('第一行\n@web/src/app.css 第二行', 'web/src/app.css')).toBe('第一行\n第二行');
  });

  it('matches @ triggers correctly', () => {
    expect(matchAtTrigger('', 0)).toBeNull();
    expect(matchAtTrigger('@', 1)).toEqual({ query: '', atIndex: 0, cursorIndex: 1 });
    expect(matchAtTrigger('hello @', 7)).toEqual({ query: '', atIndex: 6, cursorIndex: 7 });
    expect(matchAtTrigger('hello @store', 12)).toEqual({ query: 'store', atIndex: 6, cursorIndex: 12 });
    expect(matchAtTrigger('hello@store', 11)).toBeNull();
    expect(matchAtTrigger('@store done', 11)).toBeNull();
    expect(matchAtTrigger('hello\n@data/st', 14)).toEqual({ query: 'data/st', atIndex: 6, cursorIndex: 14 });
    expect(matchAtTrigger('a @b @c', 7)).toEqual({ query: 'c', atIndex: 5, cursorIndex: 7 });
  });

  it('computes @ query when draft content is completely replaced with new cursor position', () => {
    // Before: draft was '@', cursor was at 1
    const oldCursor = 1;
    // Entire text replaced (e.g. via fill / paste / IME) to '请查看 @store'
    const replacedText = '请查看 @store';
    // If evaluated with stale old cursor (1), it fails to detect @store
    expect(matchAtTrigger(replacedText, oldCursor)).toBeNull();
    // When updated with new cursor at end of replaced text (target.selectionStart ?? target.value.length)
    const newCursor = replacedText.length;
    expect(matchAtTrigger(replacedText, newCursor)).toEqual({
      query: 'store',
      atIndex: 4,
      cursorIndex: replacedText.length,
    });
  });

  it('filters files by query case-insensitively up to limit', () => {
    const files = [
      'README.md',
      'web/src/data/store.ts',
      'web/src/data/store.test.ts',
      'web/src/styles/app.css',
      'src/kernel/index.mjs',
      'src/kernel/subagents.mjs',
      'contract/openapi.json',
    ];
    expect(filterAtFiles(files, '', 3)).toEqual([
      'README.md',
      'web/src/data/store.ts',
      'web/src/data/store.test.ts',
    ]);
    expect(filterAtFiles(files, 'STORE')).toEqual([
      'web/src/data/store.ts',
      'web/src/data/store.test.ts',
    ]);
    expect(filterAtFiles(files, 'nonexistent')).toEqual([]);
  });

  it('splits file path into filename and directory', () => {
    expect(splitFilePath('web/src/data/store.ts')).toEqual({
      name: 'store.ts',
      dir: 'web/src/data/',
    });
    expect(splitFilePath('README.md')).toEqual({
      name: 'README.md',
      dir: '',
    });
    expect(splitFilePath('src/main.ts')).toEqual({
      name: 'main.ts',
      dir: 'src/',
    });
  });

  it('applies @ selection with trailing space and computes new cursor', () => {
    const trigger = { query: 'st', atIndex: 6, cursorIndex: 9 };
    const result = applyAtSelection('hello @st world', 'web/src/data/store.ts', trigger);
    expect(result.text).toBe('hello @web/src/data/store.ts  world');
    expect(result.nextCursor).toBe(29);

    const fromStart = applyAtSelection('@', 'README.md', { atIndex: 0, cursorIndex: 1 });
    expect(fromStart.text).toBe('@README.md ');
    expect(fromStart.nextCursor).toBe(11);
  });

  it('detects whether @path is complete in text', () => {
    expect(isFileRefInText('@web/src/store.ts', 'web/src/store.ts')).toBe(true);
    expect(isFileRefInText('@web/src/store.ts ', 'web/src/store.ts')).toBe(true);
    expect(isFileRefInText('hello @web/src/store.ts world', 'web/src/store.ts')).toBe(true);
    expect(isFileRefInText('hello @web/src/store.ts\nworld', 'web/src/store.ts')).toBe(true);
    // Incomplete / deleted / altered
    expect(isFileRefInText('@web/src/store.tsx', 'web/src/store.ts')).toBe(false);
    expect(isFileRefInText('@web/src/store', 'web/src/store.ts')).toBe(false);
    expect(isFileRefInText('my@web/src/store.ts', 'web/src/store.ts')).toBe(false);
    expect(isFileRefInText('plain text without path', 'web/src/store.ts')).toBe(false);
  });

  it('steps active index with ArrowDown/ArrowUp and wraps around', () => {
    expect(stepAtActiveIndex(0, 2, 'down')).toBe(1);
    expect(stepAtActiveIndex(1, 2, 'down')).toBe(0);
    expect(stepAtActiveIndex(0, 2, 'up')).toBe(1);
    expect(stepAtActiveIndex(1, 2, 'up')).toBe(0);
    expect(stepAtActiveIndex(0, 0, 'down')).toBe(0);
  });

  it('only resets active index on opening or query change, preserving highlight across cursor moves', () => {
    // When opening fresh -> reset to 0
    expect(shouldResetAtActiveIndex(null, 'store', true)).toBe(true);

    // While open and query remains unchanged (e.g. cursor moves, arrow keys, selection updates) -> do not reset
    expect(shouldResetAtActiveIndex('store', 'store', false)).toBe(false);

    // When query actually changes -> reset to 0
    expect(shouldResetAtActiveIndex('store', 'store.', false)).toBe(true);
    expect(shouldResetAtActiveIndex('store', '', false)).toBe(true);
  });

  it('navigates with ArrowDown to second item and selects second item on Enter', () => {
    const matchedFiles = ['web/src/data/store.ts', 'web/src/data/store.test.ts'];
    let activeIndex = 0;
    const initialQuery = 'store';

    // User presses ArrowDown -> active index moves to 1 (second item)
    activeIndex = stepAtActiveIndex(activeIndex, matchedFiles.length, 'down');
    expect(activeIndex).toBe(1);

    // Textarea selection/cursor changes occur, but query is still 'store' -> should NOT reset
    const mustReset = shouldResetAtActiveIndex(initialQuery, 'store', false);
    expect(mustReset).toBe(false);
    if (mustReset) activeIndex = 0;
    expect(activeIndex).toBe(1);

    // User presses Enter -> resolves second item
    const picked = resolveAtSelection(matchedFiles, activeIndex);
    expect(picked).toBe('web/src/data/store.test.ts');

    // Applies to text correctly
    const trigger = { query: 'store', atIndex: 4, cursorIndex: 10 };
    const applied = applyAtSelection('请查看 @store', picked!, trigger);
    expect(applied.text).toBe('请查看 @web/src/data/store.test.ts ');
  });
});

describe('addImages', () => {
  it('caps at six and revokes the extras', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const current = Array.from({ length: 5 }, (_, i) => image({ id: `c${i}`, previewUrl: `blob:c${i}` }));
    const incoming = [image({ id: 'n1', previewUrl: 'blob:n1' }), image({ id: 'n2', previewUrl: 'blob:n2' })];
    const added = addImages(current, incoming);
    expect(added.next).toHaveLength(IMAGE_MAX_COUNT);
    expect(added.hint?.kind).toBe('too_many');
    expect(revoke).toHaveBeenCalledWith('blob:n2');
    revoke.mockRestore();
  });
});

describe('fileToImageAttachment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects files over 5MB before reading', async () => {
    const file = new File([new Uint8Array(8)], 'big.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: IMAGE_MAX_BYTES + 1 });
    await expect(fileToImageAttachment(file)).resolves.toEqual({
      hint: { kind: 'too_large', name: 'big.png' },
    });
  });

  it('reads a small png into an attachment', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:shot');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    class FakeReader {
      result = 'data:image/png;base64,QUFB';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onload?.();
      }
    }
    vi.stubGlobal('FileReader', FakeReader);
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const result = await fileToImageAttachment(file);
    expect(result).toMatchObject({
      kind: 'image',
      name: 'shot.png',
      mediaType: 'image/png',
      data: 'QUFB',
      previewUrl: 'blob:shot',
    });
    if ('previewUrl' in result) revokePreview(result);
  });
});
