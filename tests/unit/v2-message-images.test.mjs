import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_COUNT,
  assembleUserContent,
  decodedBase64Bytes,
  extractMessageImages,
  conversationImageUrl,
  imageDisplayName,
  parseSendImages,
  pendingThreadImages,
  redactSendBody,
  redactUserContent,
  toThreadUserImages,
} from '../../src/v2/views/message-images.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function image(extra = {}) {
  return { mediaType: 'image/png', data: PNG, name: 'shot.png', ...extra };
}

test('parseSendImages accepts up to 6 png/jpeg/gif/webp and rejects the rest', () => {
  assert.deepEqual(parseSendImages(null), { ok: true, images: [] });
  assert.equal(parseSendImages({}).ok, false);
  const ok = parseSendImages([image(), { mimeType: 'image/jpg', data: PNG }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.images[0].mediaType, 'image/png');
  assert.equal(ok.images[1].mediaType, 'image/jpeg');

  const tooMany = parseSendImages(Array.from({ length: IMAGE_MAX_COUNT + 1 }, () => image()));
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'E_BAD_REQUEST');
  assert.match(tooMany.error, /6/);

  const badType = parseSendImages([{ mediaType: 'image/svg+xml', data: PNG }]);
  assert.equal(badType.ok, false);
  assert.equal(badType.code, 'E_BAD_REQUEST');

  const oversize = 'A'.repeat(Math.ceil((IMAGE_MAX_BYTES + 1) / 3) * 4);
  const large = parseSendImages([{ mediaType: 'image/png', data: oversize }]);
  assert.equal(large.ok, false);
  assert.equal(large.code, 'E_TOO_LARGE');
  assert.match(large.error, /5MB/);
});

test('assembleUserContent builds Pi Durable [text, image...] and omits empty text', () => {
  assert.equal(assembleUserContent('  hello  ', []), 'hello');
  assert.equal(assembleUserContent('   ', []), '');
  const withText = assembleUserContent('see this', [image()]);
  assert.deepEqual(withText, [
    { type: 'text', text: 'see this' },
    { type: 'image', data: PNG, mimeType: 'image/png', name: 'shot.png' },
  ]);
  const onlyImage = assembleUserContent('  ', [image({ name: 'a.png' })]);
  assert.equal(Array.isArray(onlyImage), true);
  assert.equal(onlyImage[0].type, 'image');
  assert.equal(onlyImage.length, 1);
});

test('extractMessageImages reads Pi ImageContent and a nested source', () => {
  const fromPi = extractMessageImages([
    { type: 'text', text: 'hi' },
    { type: 'image', data: PNG, mimeType: 'image/png', name: 'a.png' },
  ]);
  assert.equal(fromPi.length, 1);
  assert.equal(fromPi[0].name, 'a.png');
  const nested = extractMessageImages([
    { type: 'image', source: { mediaType: 'image/webp', data: PNG } },
  ]);
  assert.equal(nested[0].mediaType, 'image/webp');
});

test('redact helpers never keep the raw base64 in logs', () => {
  const body = { text: 'hi', images: [image()], requestId: 'r1' };
  const redacted = redactSendBody(body);
  const dump = JSON.stringify(redacted);
  assert.equal(dump.includes(PNG), false);
  assert.match(dump, /redacted/);
  assert.equal(redacted.text, 'hi');
  assert.equal(redacted.images[0].name, 'shot.png');
  assert.equal(decodedBase64Bytes(PNG) > 0, true);

  const content = assembleUserContent('hi', [image()]);
  const contentDump = JSON.stringify(redactUserContent(content));
  assert.equal(contentDump.includes(PNG), false);
  assert.match(contentDump, /redacted/);
});

test('toThreadUserImages drops base64 and points at the image GET', () => {
  const converted = toThreadUserImages([image()], 'c1', 'u1');
  assert.equal(converted.length, 1);
  assert.equal(converted[0].index, 0);
  assert.equal(converted[0].name, 'shot.png');
  assert.equal(converted[0].url, conversationImageUrl('c1', 'u1', 0));
  assert.equal(Object.hasOwn(converted[0], 'data'), false);
  assert.equal(JSON.stringify(converted).includes(PNG), false);
  const pending = pendingThreadImages([image()]);
  assert.equal(pending[0].url.startsWith('data:image/png;base64,'), true);
  assert.equal(Object.hasOwn(pending[0], 'data'), false);
});

test('imageDisplayName falls back to a typed filename', () => {
  assert.equal(imageDisplayName({ mediaType: 'image/png', name: '  a.png  ' }), 'a.png');
  assert.equal(imageDisplayName({ mediaType: 'image/jpeg' }), 'image.jpg');
  assert.equal(imageDisplayName({ mediaType: 'image/webp' }, 1), 'image-2.webp');
});
