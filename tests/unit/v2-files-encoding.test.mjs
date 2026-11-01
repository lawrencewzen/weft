import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { validateResponse } from '../../src/v2/validate.ts';
import {
  contentVersion,
  readWorkspaceFile,
  saveWorkspaceFile,
  writeFileAtomic,
} from '../../src/v2/views/files.ts';
import { detect, UTF8_BOM } from '../../src/platform/win/text-encoding.mjs';
import { encodeWorkspaceSave } from '../../src/platform/win/workspace-files.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const DETECT = { WEFT_TEXT_ENCODING_DETECT: '1' };
const OFF = { WEFT_TEXT_ENCODING_DETECT: '' };
const TOKEN = 'v2-files-encoding-token';
const LINE1 = '打印("你好世界")\r\n';
const LINE2 = '# 未改动：中文镕〇\n';
const CHINESE = LINE1 + LINE2;
const GBK_NAME = 'notes.py';

function gbkBytes(text = CHINESE) {
  return iconv.encode(text, 'gbk');
}

function utf8BomBytes(text) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

async function tmpRoot() {
  return mkdtemp(path.join(tmpdir(), 'weft-v2-files-enc-'));
}

function assertChecked(apiPath, method, status, body) {
  const checked = validateResponse(apiPath, method, status, body);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
}

test('GBK file reads as Chinese when detection is on', async () => {
  const root = await tmpRoot();
  await writeFile(path.join(root, GBK_NAME), gbkBytes());
  const got = await readWorkspaceFile(root, GBK_NAME, DETECT);
  assert.equal(got.binary, false);
  assert.equal(got.tooLarge, false);
  assert.equal(got.text, CHINESE);
  assert.equal(got.text.includes('\uFFFD'), false);
  assert.equal(got.encoding, 'gbk');
  assert.equal(got.version, contentVersion(gbkBytes()));
  assert.notEqual(got.version, contentVersion(CHINESE));
});

test('GBK round-trip: edit one line, bytes of the rest stay, versions match, no false conflict', async () => {
  const root = await tmpRoot();
  const abs = path.join(root, GBK_NAME);
  const original = Buffer.concat([gbkBytes(LINE1), gbkBytes(LINE2)]);
  await writeFile(abs, original);

  const first = await readWorkspaceFile(root, GBK_NAME, DETECT);
  assert.equal(first.text, CHINESE);
  const edited = first.text.replace('你好世界', '你好 Weft');
  const saved = await saveWorkspaceFile({
    root,
    path: GBK_NAME,
    text: edited,
    baseVersion: first.version,
    env: DETECT,
  });

  const disk = await readFile(abs);
  assert.equal(detect(disk), 'gbk');
  const expected = Buffer.concat([gbkBytes('打印("你好 Weft")\r\n'), gbkBytes(LINE2)]);
  assert.deepEqual(disk, expected);
  assert.deepEqual(disk.subarray(disk.length - gbkBytes(LINE2).length), gbkBytes(LINE2));

  const second = await readWorkspaceFile(root, GBK_NAME, DETECT);
  assert.equal(second.text, edited);
  assert.equal(second.encoding, 'gbk');
  assert.equal(second.version, saved.version);
  assert.equal(second.version, contentVersion(disk));

  const again = await saveWorkspaceFile({
    root,
    path: GBK_NAME,
    text: edited,
    baseVersion: saved.version,
    env: DETECT,
  });
  assert.equal(again.version, saved.version);
  assert.deepEqual(await readFile(abs), expected);
});

test('UTF-8, UTF-8 BOM, new file, and real binary stay the same with detection on', async () => {
  const root = await tmpRoot();
  await writeFile(path.join(root, 'utf8.txt'), 'utf8 中文\n', 'utf8');
  await writeFile(path.join(root, 'bom.txt'), utf8BomBytes('bom 中文\n'));
  await writeFile(path.join(root, 'nul.bin'), Buffer.from([0x00, 0x61, 0xff]));
  await writeFile(path.join(root, 'bad.bin'), Buffer.from([0xff, 0xfe, 0xfd]));

  const utf8 = await readWorkspaceFile(root, 'utf8.txt', DETECT);
  assert.equal(utf8.binary, false);
  assert.equal(utf8.text, 'utf8 中文\n');
  assert.equal(utf8.encoding, 'utf8');
  const utf8Saved = await saveWorkspaceFile({
    root,
    path: 'utf8.txt',
    text: 'utf8 改\n',
    baseVersion: utf8.version,
    env: DETECT,
  });
  assert.equal(await readFile(path.join(root, 'utf8.txt'), 'utf8'), 'utf8 改\n');
  assert.equal(utf8Saved.version, contentVersion('utf8 改\n'));

  const bom = await readWorkspaceFile(root, 'bom.txt', DETECT);
  assert.equal(bom.binary, false);
  assert.equal(bom.encoding, 'utf8-bom');
  assert.equal(bom.text, '\uFEFFbom 中文\n');
  const bomSaved = await saveWorkspaceFile({
    root,
    path: 'bom.txt',
    text: bom.text.replace('bom', 'hi'),
    baseVersion: bom.version,
    env: DETECT,
  });
  const bomDisk = await readFile(path.join(root, 'bom.txt'));
  assert.equal(detect(bomDisk), 'utf8-bom');
  assert.equal(bomDisk[0], 0xef);
  assert.equal(bomDisk[1], 0xbb);
  assert.equal(bomDisk[2], 0xbf);
  assert.equal(bomDisk.includes(Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf])), false);
  const rereadBom = await readWorkspaceFile(root, 'bom.txt', DETECT);
  assert.equal(rereadBom.version, bomSaved.version);
  assert.equal(rereadBom.text, '\uFEFFhi 中文\n');

  const created = await saveWorkspaceFile({
    root,
    path: 'nested/new.txt',
    text: '新建 中文\n',
    env: DETECT,
  });
  const newDisk = await readFile(path.join(root, 'nested', 'new.txt'));
  assert.equal(detect(newDisk), 'utf8');
  assert.deepEqual(newDisk, Buffer.from('新建 中文\n', 'utf8'));
  assert.equal(created.version, contentVersion('新建 中文\n'));

  const nul = await readWorkspaceFile(root, 'nul.bin', DETECT);
  assert.equal(nul.binary, true);
  assert.equal(nul.text, null);
  assert.equal(nul.encoding, undefined);

  const bad = await readWorkspaceFile(root, 'bad.bin', DETECT);
  assert.equal(bad.binary, true);
  assert.equal(bad.text, null);
  assert.equal(bad.encoding, undefined);
});

test('saving emoji into a GBK file returns 4xx and leaves the file untouched', async () => {
  const root = await tmpRoot();
  const abs = path.join(root, GBK_NAME);
  const original = gbkBytes();
  await writeFile(abs, original);
  const current = await readWorkspaceFile(root, GBK_NAME, DETECT);
  await assert.rejects(
    () => saveWorkspaceFile({
      root,
      path: GBK_NAME,
      text: `${current.text}😀`,
      baseVersion: current.version,
      env: DETECT,
    }),
    (err) => {
      assert.equal(err.code, 'E_BAD_REQUEST');
      assert.match(err.message, /GBK/);
      assert.match(err.message, /😀|U\+1F600/i);
      return true;
    },
  );
  assert.deepEqual(await readFile(abs), original);
  const after = await readWorkspaceFile(root, GBK_NAME, DETECT);
  assert.equal(after.version, current.version);
  assert.equal(after.text, CHINESE);
});

test('without detection GBK is binary on non-Windows; Windows always detects', async () => {
  const root = await tmpRoot();
  await writeFile(path.join(root, GBK_NAME), gbkBytes());
  await writeFile(path.join(root, 'ok.txt'), 'hello\n');
  const gbk = await readWorkspaceFile(root, GBK_NAME, OFF);
  const ok = await readWorkspaceFile(root, 'ok.txt', OFF);
  assert.equal(ok.binary, false);
  assert.equal(ok.text, 'hello\n');
  if (process.platform === 'win32') {
    // win32 always enables detection, even with WEFT_TEXT_ENCODING_DETECT unset.
    assert.equal(ok.encoding, 'utf8');
    assert.equal(gbk.binary, false);
    assert.equal(gbk.text, CHINESE);
    assert.equal(gbk.encoding, 'gbk');
  } else {
    assert.equal(ok.encoding, undefined);
    assert.equal(gbk.binary, true);
    assert.equal(gbk.text, null);
    assert.equal(gbk.encoding, undefined);
    const saved = await saveWorkspaceFile({
      root,
      path: GBK_NAME,
      text: 'rewritten\n',
      env: OFF,
    });
    assert.equal(await readFile(path.join(root, GBK_NAME), 'utf8'), 'rewritten\n');
    assert.equal(saved.version, contentVersion('rewritten\n'));
  }
});

test('writeFileAtomic writes Buffer bytes (GBK) and falls back without recoding', async () => {
  const root = await tmpRoot();
  const abs = path.join(root, GBK_NAME);
  const bytes = gbkBytes();
  await writeFile(abs, Buffer.from('old'));
  await writeFileAtomic(abs, bytes);
  assert.deepEqual(await readFile(abs), bytes);

  let renameCalls = 0;
  const fallback = path.join(root, 'fallback.py');
  await writeFile(fallback, Buffer.from('old'));
  await writeFileAtomic(fallback, bytes, {
    writeFile: async (file, data, encoding) => {
      await writeFile(file, data, encoding);
    },
    rename: async () => {
      renameCalls += 1;
      const err = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    },
    sleep: async () => {},
  });
  assert.equal(renameCalls > 0, true);
  assert.deepEqual(await readFile(fallback), bytes);
});

test('GET/PUT files API: GBK Chinese, keep GBK on save, emoji 400', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_TEXT_ENCODING_DETECT: '1' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'v2-files-enc' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const wid = ws.body.id;
    const root = ws.body.path;
    await mkdir(path.join(root, 'src'), { recursive: true });
    const abs = path.join(root, 'src', GBK_NAME);
    await writeFile(abs, gbkBytes());

    const res = await fetch(
      `${srv.base}/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('src/notes.py')}`,
      { headers: { authorization: `Bearer ${discovery.token}` } },
    );
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'GET', 200, body);
    assert.equal(body.binary, false);
    assert.equal(body.text, CHINESE);
    assert.equal(body.encoding, 'gbk');

    const edited = body.text.replace('你好世界', '你好 Weft');
    const saved = await fetch(`${srv.base}/api/v2/workspaces/${wid}/files`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${discovery.token}`,
      },
      body: JSON.stringify({ path: 'src/notes.py', text: edited, baseVersion: body.version }),
    });
    const savedBody = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(savedBody));
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'PUT', 200, savedBody);
    const disk = await readFile(abs);
    assert.equal(detect(disk), 'gbk');
    assert.deepEqual(disk.subarray(disk.length - gbkBytes(LINE2).length), gbkBytes(LINE2));

    const again = await fetch(
      `${srv.base}/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('src/notes.py')}`,
      { headers: { authorization: `Bearer ${discovery.token}` } },
    );
    const againBody = await again.json();
    assert.equal(againBody.version, savedBody.version);

    const second = await fetch(`${srv.base}/api/v2/workspaces/${wid}/files`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${discovery.token}`,
      },
      body: JSON.stringify({ path: 'src/notes.py', text: edited, baseVersion: savedBody.version }),
    });
    assert.equal(second.status, 200, await second.text());

    const beforeEmoji = await readFile(abs);
    const emoji = await fetch(`${srv.base}/api/v2/workspaces/${wid}/files`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${discovery.token}`,
      },
      body: JSON.stringify({ path: 'src/notes.py', text: `${edited}😀`, baseVersion: savedBody.version }),
    });
    const emojiBody = await emoji.json();
    assert.equal(emoji.status, 400, JSON.stringify(emojiBody));
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'PUT', 400, emojiBody);
    assert.equal(emojiBody.code, 'E_BAD_REQUEST');
    assert.match(String(emojiBody.error), /GBK/);
    assert.match(String(emojiBody.error), /😀|U\+1F600/i);
    assert.deepEqual(await readFile(abs), beforeEmoji);
  } finally {
    await stopServer(srv);
  }
});

test('encodeWorkspaceSave and saveWorkspaceFile write new .ps1 with UTF-8 BOM', async () => {
  const encoded = encodeWorkspaceSave("Write-Output '中文自检'\n", null, DETECT, 'linux', 'hi.ps1');
  assert.equal(encoded.bytes.subarray(0, 3).equals(UTF8_BOM), true);
  assert.equal(detect(encoded.bytes), 'utf8-bom');
  assert.equal(encoded.bytes.toString('utf8').includes('中文自检'), true);

  const existingUtf8 = Buffer.from("Write-Output '旧'\n", 'utf8');
  const upgraded = encodeWorkspaceSave("Write-Output '中文自检'\n", existingUtf8, DETECT, 'linux', 'hi.ps1');
  assert.equal(upgraded.bytes.subarray(0, 3).equals(UTF8_BOM), true);
  assert.equal(upgraded.bytes.includes(Buffer.concat([UTF8_BOM, UTF8_BOM])), false);

  const root = await tmpRoot();
  const saved = await saveWorkspaceFile({
    root,
    path: 'nested/hi.ps1',
    text: "Write-Output '中文自检'\n",
    env: DETECT,
  });
  const disk = await readFile(path.join(root, 'nested', 'hi.ps1'));
  assert.equal(detect(disk), 'utf8-bom');
  assert.equal(disk.subarray(0, 3).equals(UTF8_BOM), true);
  assert.equal(disk.toString('utf8').includes('中文自检'), true);
  assert.equal(saved.version, contentVersion(disk));

  const current = await readWorkspaceFile(root, 'nested/hi.ps1', DETECT);
  const again = await saveWorkspaceFile({
    root,
    path: 'nested/hi.ps1',
    text: "Write-Output '中文自检'\nflag = 1\n",
    baseVersion: current.version,
    env: DETECT,
  });
  const rewritten = await readFile(path.join(root, 'nested', 'hi.ps1'));
  assert.equal(detect(rewritten), 'utf8-bom');
  assert.equal(rewritten.subarray(0, 3).equals(UTF8_BOM), true);
  assert.equal(rewritten.includes(Buffer.concat([UTF8_BOM, UTF8_BOM])), false);
  assert.equal(again.version, contentVersion(rewritten));
});

test('saveWorkspaceFile keeps existing GBK .ps1 as GBK', async () => {
  const root = await tmpRoot();
  const abs = path.join(root, 'legacy.ps1');
  const original = gbkBytes("Write-Output '你好世界'\n");
  await writeFile(abs, original);
  const first = await readWorkspaceFile(root, 'legacy.ps1', DETECT);
  const saved = await saveWorkspaceFile({
    root,
    path: 'legacy.ps1',
    text: first.text.replace('你好世界', '你好 Weft'),
    baseVersion: first.version,
    env: DETECT,
  });
  const disk = await readFile(abs);
  assert.equal(detect(disk), 'gbk');
  assert.equal(disk.subarray(0, 3).equals(UTF8_BOM), false);
  assert.deepEqual(disk, gbkBytes("Write-Output '你好 Weft'\n"));
  assert.equal(saved.version, contentVersion(disk));
});

test('saveWorkspaceFile new .ps1 has no BOM when detection is off', { skip: process.platform === 'win32' }, async () => {
  const encoded = encodeWorkspaceSave("Write-Output '中文自检'\n", null, OFF, 'linux', 'hi.ps1');
  assert.deepEqual(encoded.bytes, Buffer.from("Write-Output '中文自检'\n", 'utf8'));

  const root = await tmpRoot();
  await saveWorkspaceFile({
    root,
    path: 'hi.ps1',
    text: "Write-Output '中文自检'\n",
    env: OFF,
  });
  const disk = await readFile(path.join(root, 'hi.ps1'));
  assert.deepEqual(disk, Buffer.from("Write-Output '中文自检'\n", 'utf8'));
  assert.equal(detect(disk), 'utf8');
});
