import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import iconv from 'iconv-lite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createEditTool, createReadTool } from '@earendil-works/pi-durable/tools';
import { createWorkspaceEnv } from '../../src/kernel/workspace-env.mjs';
import {
  GBK_BINARY_VIEW_MAX_BYTES,
  decode,
  detect,
  encode,
  isTextEncodingDetectEnabled,
} from '../../src/platform/win/text-encoding.mjs';

/** 1×1 PNG; IHDR is valid so createReadTool treats it as an image. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** JPEG SOI + APP0 so the header matches the official sniffer. */
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

const context = BACKGROUND_CONTEXT;
const CHINESE = '打印("你好世界")\r\n# 未改动：中文镕〇\n';
const GBK_NAME = 'notes.py';

function gbkBytes(text = CHINESE) {
  return iconv.encode(text, 'gbk');
}

async function withDetectEnv(enabled, use) {
  const previous = process.env.WEFT_TEXT_ENCODING_DETECT;
  if (enabled) process.env.WEFT_TEXT_ENCODING_DETECT = '1';
  else delete process.env.WEFT_TEXT_ENCODING_DETECT;
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-gbk-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  try {
    await use({ dir, env });
  } finally {
    if (previous === undefined) delete process.env.WEFT_TEXT_ENCODING_DETECT;
    else process.env.WEFT_TEXT_ENCODING_DETECT = previous;
    await env.cleanup(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

function toolText(result) {
  return (result?.output ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('');
}

function readToolApi(env) {
  return {
    env,
    async agent() {
      return { model: undefined };
    },
    models: { getModel() { return undefined; } },
  };
}

async function readOpenBinaryAll(env, name) {
  const opened = await env.openBinaryReader(name, undefined, context);
  assert.equal(opened.ok, true, opened.ok ? '' : opened.error.message);
  try {
    const info = await opened.value.info(context);
    assert.equal(info.ok, true, info.ok ? '' : info.error.message);
    const bytes = await opened.value.read(0, info.value.size, context);
    assert.equal(bytes.ok, true, bytes.ok ? '' : bytes.error.message);
    return Buffer.from(bytes.value);
  } finally {
    await opened.value.close(context);
  }
}

test('detect: BOM, utf8, ascii, gbk, NUL binary, and invalid fallback', () => {
  assert.equal(detect(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), 'utf8-bom');
  assert.equal(detect(Buffer.from('hello 你好', 'utf8')), 'utf8');
  assert.equal(detect(Buffer.from('ascii only')), 'utf8');
  assert.equal(detect(gbkBytes()), 'gbk');
  assert.equal(detect(Buffer.from([0xff, 0xfe, 0x00, 0x81])), 'utf8');
  assert.equal(detect(Buffer.concat([gbkBytes(), Buffer.from([0x00])])), 'utf8');
});

test('encode gbk rejects unencodable characters with a clear error', () => {
  assert.throws(
    () => encode('hello😀', 'gbk'),
    (error) => {
      assert.match(error.message, /GBK/);
      assert.match(error.message, /😀|U\+1F600/i);
      return true;
    },
  );
  assert.deepEqual(encode(CHINESE, 'gbk'), gbkBytes());
});

test('decode/encode utf8-bom does not double the BOM', () => {
  const text = '\uFEFF# title\n';
  const bytes = encode(text, 'utf8-bom');
  assert.equal(bytes[0], 0xef);
  assert.equal(bytes[1], 0xbb);
  assert.equal(bytes[2], 0xbf);
  assert.equal(bytes.subarray(0, 6).equals(Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf])), false);
  assert.equal(decode(bytes, 'utf8-bom'), text);
});

test('isTextEncodingDetectEnabled: win32 always, else only WEFT_TEXT_ENCODING_DETECT=1', () => {
  assert.equal(isTextEncodingDetectEnabled('win32', {}), true);
  assert.equal(isTextEncodingDetectEnabled('win32', { WEFT_TEXT_ENCODING_DETECT: '0' }), true);
  assert.equal(isTextEncodingDetectEnabled('linux', {}), false);
  assert.equal(isTextEncodingDetectEnabled('linux', { WEFT_TEXT_ENCODING_DETECT: '1' }), true);
  assert.equal(isTextEncodingDetectEnabled('linux', { WEFT_TEXT_ENCODING_DETECT: 'true' }), false);
});

test('read GBK as Chinese; utf8 / utf8-bom / ascii unchanged', async () => {
  await withDetectEnv(true, async ({ dir, env }) => {
    await writeFile(path.join(dir, GBK_NAME), gbkBytes());
    await writeFile(path.join(dir, 'utf8.txt'), 'utf8 中文\n', 'utf8');
    await writeFile(path.join(dir, 'bom.txt'), Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('bom 中文\n', 'utf8'),
    ]));
    await writeFile(path.join(dir, 'ascii.txt'), 'plain ascii\n');

    const gbk = await env.readTextFile(GBK_NAME, context);
    assert.equal(gbk.ok, true, gbk.ok ? '' : gbk.error.message);
    assert.equal(gbk.value, CHINESE);
    assert.equal(gbk.value.includes('\uFFFD'), false);

    const utf8 = await env.readTextFile('utf8.txt', context);
    assert.equal(utf8.ok, true);
    assert.equal(utf8.value, 'utf8 中文\n');

    const bom = await env.readTextFile('bom.txt', context);
    assert.equal(bom.ok, true);
    assert.equal(bom.value, '\uFEFFbom 中文\n');

    const ascii = await env.readTextFile('ascii.txt', context);
    assert.equal(ascii.ok, true);
    assert.equal(ascii.value, 'plain ascii\n');

    const lines = await env.readTextLines(GBK_NAME, undefined, context);
    assert.equal(lines.ok, true);
    assert.deepEqual(lines.value, ['打印("你好世界")\r', '# 未改动：中文镕〇']);
  });
});

test('edit flow keeps GBK bytes for unchanged Chinese and keeps UTF-8 BOM', async () => {
  await withDetectEnv(true, async ({ dir, env }) => {
    const original = gbkBytes('a = 1\nprint("你好世界")\nprint("未改动")\n');
    await writeFile(path.join(dir, GBK_NAME), original);
    const before = await env.readTextFile(GBK_NAME, context);
    assert.equal(before.ok, true);
    const next = before.value.replace('a = 1', 'a = 2');
    const wrote = await env.writeFile(GBK_NAME, next, context);
    assert.equal(wrote.ok, true, wrote.ok ? '' : wrote.error.message);

    const onDisk = await readFile(path.join(dir, GBK_NAME));
    const expected = gbkBytes('a = 2\nprint("你好世界")\nprint("未改动")\n');
    assert.deepEqual(onDisk, expected);
    assert.equal(detect(onDisk), 'gbk');
    const unchanged = gbkBytes('print("你好世界")\nprint("未改动")\n');
    assert.equal(onDisk.includes(unchanged), true);

    const bomPath = path.join(dir, 'bom.txt');
    await writeFile(bomPath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('keep 中文\nflag = 0\n', 'utf8'),
    ]));
    const bomRead = await env.readTextFile('bom.txt', context);
    assert.equal(bomRead.ok, true);
    const bomWrite = await env.writeFile('bom.txt', bomRead.value.replace('flag = 0', 'flag = 1'), context);
    assert.equal(bomWrite.ok, true, bomWrite.ok ? '' : bomWrite.error.message);
    const bomDisk = await readFile(bomPath);
    assert.equal(bomDisk[0], 0xef);
    assert.equal(bomDisk[1], 0xbb);
    assert.equal(bomDisk[2], 0xbf);
    assert.equal(bomDisk.subarray(3).toString('utf8'), 'keep 中文\nflag = 1\n');
  });
});

test('new files are written as UTF-8', async () => {
  await withDetectEnv(true, async ({ dir, env }) => {
    const wrote = await env.writeFile('new.txt', '新建 中文\n', context);
    assert.equal(wrote.ok, true, wrote.ok ? '' : wrote.error.message);
    const onDisk = await readFile(path.join(dir, 'new.txt'));
    assert.deepEqual(onDisk, Buffer.from('新建 中文\n', 'utf8'));
    assert.equal(detect(onDisk), 'utf8');
  });
});

test('writing emoji into a GBK file errors and leaves bytes unchanged', async () => {
  await withDetectEnv(true, async ({ dir, env }) => {
    const original = gbkBytes();
    await writeFile(path.join(dir, GBK_NAME), original);
    const wrote = await env.writeFile(GBK_NAME, `${CHINESE}😀\n`, context);
    assert.equal(wrote.ok, false);
    assert.equal(wrote.error.code, 'invalid');
    assert.match(String(wrote.error.message), /GBK/);
    assert.match(String(wrote.error.message), /😀|U\+1F600/i);
    assert.deepEqual(await readFile(path.join(dir, GBK_NAME)), original);
  });
});

test('detection off: GBK is still mis-decoded as utf8 (status quo)', { skip: process.platform === 'win32' }, async () => {
  await withDetectEnv(false, async ({ dir, env }) => {
    const original = gbkBytes();
    await writeFile(path.join(dir, GBK_NAME), original);
    const read = await env.readTextFile(GBK_NAME, context);
    assert.equal(read.ok, true);
    assert.equal(read.value, original.toString('utf8'));
    assert.equal(read.value.includes('\uFFFD'), true);
    const wrote = await env.writeFile(GBK_NAME, read.value.replace('a', 'b'), context);
    assert.equal(wrote.ok, true);
    const onDisk = await readFile(path.join(dir, GBK_NAME));
    assert.equal(onDisk.includes(Buffer.from([0xef, 0xbf, 0xbd])) || onDisk.toString('utf8').includes('\uFFFD'), true);
  });
});

test('readBinaryFile still returns on-disk GBK bytes', async () => {
  await withDetectEnv(true, async ({ dir, env }) => {
    const original = gbkBytes();
    await writeFile(path.join(dir, GBK_NAME), original);
    const binary = await env.readBinaryFile(GBK_NAME, context);
    assert.equal(binary.ok, true);
    assert.deepEqual(Buffer.from(binary.value), original);
  });
});

test('official createReadTool reads GBK Chinese', async () => {
  await withDetectEnv(true, async ({ dir, env }) => {
    await writeFile(path.join(dir, GBK_NAME), gbkBytes('print("你好世界")\n'));
    const tool = createReadTool();
    const result = await tool.execute({ path: GBK_NAME }, { env }, context);
    const text = toolText(result);
    assert.equal(result?.isError, undefined);
    assert.equal(text.includes('你好世界'), true, text);
    assert.equal(text.includes('\uFFFD'), false, text);
  });
});

test('official createEditTool keeps GBK encoding after a targeted edit', async () => {
  await withDetectEnv(true, async ({ dir, env }) => {
    const original = gbkBytes('a = 1\nprint("你好世界")\nprint("未改动的中文")\n');
    await writeFile(path.join(dir, GBK_NAME), original);
    const tool = createEditTool();
    const result = await tool.execute({
      path: GBK_NAME,
      edits: [{ oldText: 'a = 1', newText: 'a = 2' }],
    }, { env }, context);
    assert.equal(result?.isError, undefined, JSON.stringify(result));
    assert.match(toolText(result), /Successfully replaced/);
    const onDisk = await readFile(path.join(dir, GBK_NAME));
    const expected = gbkBytes('a = 2\nprint("你好世界")\nprint("未改动的中文")\n');
    assert.deepEqual(onDisk, expected);
    assert.equal(detect(onDisk), 'gbk');
  });
});

test('appendFile encodes the extra text with the existing file encoding', async () => {
  await withDetectEnv(true, async ({ dir, env }) => {
    await writeFile(path.join(dir, GBK_NAME), gbkBytes('你好\n'));
    const appended = await env.appendFile(GBK_NAME, '世界\n', context);
    assert.equal(appended.ok, true, appended.ok ? '' : appended.error.message);
    assert.deepEqual(await readFile(path.join(dir, GBK_NAME)), gbkBytes('你好\n世界\n'));
  });
});

test('openBinaryReader leaves PNG, JPEG, NUL binary, and oversized files as on-disk bytes', async () => {
  await withDetectEnv(true, async ({ dir, env }) => {
    const nulBinary = Buffer.from([0x81, 0x40, 0x00, 0xff, 0xc4, 0xe3, 0x80, 0x20]);
    const oversized = Buffer.alloc(GBK_BINARY_VIEW_MAX_BYTES + 2);
    for (let i = 0; i < oversized.length; i += 2) {
      oversized[i] = 0xc4;
      oversized[i + 1] = 0xe3;
    }
    await writeFile(path.join(dir, 'dot.png'), PNG_1X1);
    await writeFile(path.join(dir, 'dot.jpg'), JPEG_HEADER);
    await writeFile(path.join(dir, 'blob.bin'), nulBinary);
    await writeFile(path.join(dir, 'huge.gbk'), oversized);

    assert.deepEqual(await readOpenBinaryAll(env, 'dot.png'), PNG_1X1);
    assert.deepEqual(await readOpenBinaryAll(env, 'dot.jpg'), JPEG_HEADER);
    assert.deepEqual(await readOpenBinaryAll(env, 'blob.bin'), nulBinary);
    assert.deepEqual(await readOpenBinaryAll(env, 'huge.gbk'), oversized);
    assert.equal(detect(nulBinary), 'utf8');
    assert.equal(detect(oversized), 'gbk');
  });
});

test('official createReadTool reads a PNG as an image', async () => {
  await withDetectEnv(true, async ({ dir, env }) => {
    await writeFile(path.join(dir, 'dot.png'), PNG_1X1);
    const tool = createReadTool();
    const result = await tool.execute({ path: 'dot.png' }, readToolApi(env), context);
    assert.equal(result?.isError, undefined, JSON.stringify(result));
    const image = (result?.output ?? []).find((part) => part?.type === 'image');
    assert.equal(image?.mimeType, 'image/png');
    assert.equal(image?.type, 'image');
    assert.deepEqual(Buffer.from(image.data, 'base64'), PNG_1X1);
  });
});
