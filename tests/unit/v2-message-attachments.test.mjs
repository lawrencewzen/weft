import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractPasteTexts,
  formatAttachedFilesBlock,
  formatPasteBlock,
  parseAttachedFilesBlock,
  parsePasteBlock,
  parseUserMessageParts,
  sanitizeUploadName,
} from '../../src/core/user-message-parts.mjs';
import { assembleUserContent } from '../../src/v2/views/message-images.ts';
import {
  parseSendFiles,
  parseSendPastes,
  parseUploadBody,
  resolveSendFiles,
  saveWorkspaceUpload,
  PASTE_MAX_BYTES,
  PASTE_MAX_COUNT,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
} from '../../src/v2/views/uploads.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('sanitizeUploadName takes basename and strips controls and separators', () => {
  assert.equal(sanitizeUploadName('notes.txt'), 'notes.txt');
  assert.equal(sanitizeUploadName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeUploadName('a\\b/c.txt'), 'c.txt');
  assert.equal(sanitizeUploadName('foo\u0000bar.txt'), 'foobar.txt');
  assert.equal(sanitizeUploadName(''), 'file');
  assert.equal(sanitizeUploadName('///'), 'file');
  assert.equal(sanitizeUploadName('.'), 'file');
  assert.equal(sanitizeUploadName('..'), 'file');
  assert.equal(sanitizeUploadName('\n\t'), 'file');
});

test('parseUploadBody accepts base64 and rejects oversize with 413', () => {
  const ok = parseUploadBody({ name: 'a.txt', data: Buffer.from('hi').toString('base64') });
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'a.txt');
  assert.equal(ok.bytes, 2);

  const missing = parseUploadBody({ name: 'a.txt' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 400);

  const bad = parseUploadBody({ name: 'a.txt', data: '%%%' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_BAD_REQUEST');

  const oversize = 'A'.repeat(Math.ceil((UPLOAD_MAX_BYTES + 1) / 3) * 4);
  const large = parseUploadBody({ name: 'big.bin', data: oversize });
  assert.equal(large.ok, false);
  assert.equal(large.status, 413);
  assert.equal(large.code, 'E_TOO_LARGE');
});

test('paste and attached_files blocks round-trip for the model and the view', () => {
  const paste = 'line1\nline2\nline3';
  const block = formatPasteBlock(paste);
  assert.equal(block, `<pasted_text lines="3">\n${paste}\n</pasted_text>`);
  const parsed = parsePasteBlock(block);
  assert.equal(parsed.text, paste);
  assert.equal(parsed.lines, 3);
  assert.equal(parsed.chars, paste.length);
  assert.equal(parsed.preview, paste);

  const files = [
    { path: '.weft/uploads/20261028-030000-abc123/a.pdf', bytes: 12 },
    { path: '.weft/uploads/20261028-030001-def456/b.txt', bytes: 4 },
  ];
  const filesBlock = formatAttachedFilesBlock(files);
  assert.match(filesBlock, /^<attached_files>\n/);
  assert.match(filesBlock, /用户附上了这些文件，需要时用读文件工具读取：/);
  assert.match(filesBlock, /- \.weft\/uploads\/20261028-030000-abc123\/a\.pdf（12 字节）/);
  const parsedFiles = parseAttachedFilesBlock(filesBlock);
  assert.equal(parsedFiles.length, 2);
  assert.equal(parsedFiles[0].name, 'a.pdf');
  assert.equal(parsedFiles[0].bytes, 12);
});

test('assembleUserContent builds text / pasted_text / attached_files / images in order', () => {
  const pastes = ['alpha\nbeta', 'only'];
  const files = [{ path: '.weft/uploads/20261028-030000-abc123/doc.txt', name: 'doc.txt', bytes: 8 }];
  const content = assembleUserContent('请看', [{ mediaType: 'image/png', data: PNG, name: 'shot.png' }], {
    pastes,
    files,
  });
  assert.equal(Array.isArray(content), true);
  assert.deepEqual(content[0], { type: 'text', text: '请看' });
  assert.equal(content[1].type, 'text');
  assert.equal(content[1].text, formatPasteBlock(pastes[0]));
  assert.equal(content[2].text, formatPasteBlock(pastes[1]));
  assert.equal(content[3].text, formatAttachedFilesBlock(files));
  assert.equal(content[4].type, 'image');

  const filesOnly = assembleUserContent('  ', [], { files });
  assert.equal(filesOnly[0].text.startsWith('<attached_files>'), true);
  assert.equal(filesOnly.length, 1);

  const pastesOnly = assembleUserContent('', [], { pastes: ['hello'] });
  assert.equal(pastesOnly[0].text, formatPasteBlock('hello'));
});

test('parseUserMessageParts keeps body text and paste/file metadata without paste bodies', () => {
  const long = Array.from({ length: 20 }, (_, i) => `row-${i + 1}`).join('\n');
  const content = assembleUserContent('正文', [], {
    pastes: [long],
    files: [{ path: '.weft/uploads/stamp/notes.md', bytes: 32 }],
  });
  const parts = parseUserMessageParts(content);
  assert.equal(parts.text, '正文');
  assert.equal(parts.pastes.length, 1);
  assert.equal(parts.pastes[0].lines, 20);
  assert.equal(parts.pastes[0].chars, long.length);
  assert.equal(parts.pastes[0].preview, long.split('\n').slice(0, 8).join('\n'));
  assert.equal(JSON.stringify(parts.pastes).includes('row-12'), false);
  assert.equal(parts.files[0].path, '.weft/uploads/stamp/notes.md');
  assert.equal(parts.files[0].name, 'notes.md');
  assert.equal(parts.files[0].bytes, 32);
  assert.deepEqual(extractPasteTexts(content), [long]);
  assert.equal(JSON.stringify({ text: parts.text, pastes: parts.pastes, files: parts.files }).includes(long), false);
});

test('parseSendFiles and parseSendPastes enforce count and size', () => {
  assert.deepEqual(parseSendFiles(null), { ok: true, files: [] });
  assert.equal(parseSendFiles({}).ok, false);
  const tooManyFiles = parseSendFiles(Array.from({ length: UPLOAD_MAX_FILES + 1 }, (_, i) => ({
    path: `.weft/uploads/s/f${i}.txt`,
  })));
  assert.equal(tooManyFiles.ok, false);
  assert.match(tooManyFiles.error, /20/);

  assert.deepEqual(parseSendPastes(null), { ok: true, pastes: [] });
  const tooManyPastes = parseSendPastes(Array.from({ length: PASTE_MAX_COUNT + 1 }, () => 'x'));
  assert.equal(tooManyPastes.ok, false);
  assert.match(tooManyPastes.error, /10/);

  const huge = 'x'.repeat(PASTE_MAX_BYTES + 1);
  const tooBig = parseSendPastes([huge]);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /1MB/);
});

test('saveWorkspaceUpload writes under .weft/uploads and gitignore only once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'weft-upload-'));
  const first = await saveWorkspaceUpload(root, {
    name: 'notes.txt',
    data: Buffer.from('hello').toString('base64'),
  });
  assert.match(first.path, /^\.weft\/uploads\/\d{8}-\d{6}-[0-9a-f]{6}\/notes\.txt$/);
  assert.equal(first.name, 'notes.txt');
  assert.equal(first.bytes, 5);
  assert.equal(first.mediaType, 'text/plain');
  const abs = path.join(root, ...first.path.split('/'));
  assert.equal(await readFile(abs, 'utf8'), 'hello');
  const gitignore = path.join(root, '.weft', '.gitignore');
  assert.equal(await readFile(gitignore, 'utf8'), '*\n');

  await writeFile(gitignore, '# keep\n');
  const second = await saveWorkspaceUpload(root, {
    name: 'other.txt',
    data: Buffer.from('x').toString('base64'),
  });
  assert.equal(await readFile(gitignore, 'utf8'), '# keep\n');
  assert.notEqual(second.path, first.path);

  const resolved = await resolveSendFiles(root, [{ path: first.path }]);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.files[0].bytes, 5);
  assert.equal(resolved.files[0].name, 'notes.txt');

  const outside = await resolveSendFiles(root, [{ path: 'notes.txt' }]);
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'E_BAD_REQUEST');

  await mkdir(path.join(root, 'other'), { recursive: true });
  await writeFile(path.join(root, 'other', 'secret.txt'), 'nope');
  const escaped = await resolveSendFiles(root, [{ path: '.weft/uploads/../other/secret.txt' }]);
  assert.equal(escaped.ok, false);
});
