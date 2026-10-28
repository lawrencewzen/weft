import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_COUNT,
  addImages,
  fileToImageAttachment,
  formatFileSize,
  insertFileRef,
  isImageFile,
  matchProjectPath,
  mediaTypeOfFile,
  relativeToWorkspace,
  removeFileRef,
  revokePreview,
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
    expect(removeFileRef('看一下 @web/src/app.css 再改', 'web/src/app.css')).toBe('看一下  再改'.replace(/[ \t]{2,}/g, ' '));
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
