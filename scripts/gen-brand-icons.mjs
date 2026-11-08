// 由 assets/brand/*.svg 生成各尺寸 PNG、weft.ico 与网页 favicon。
// 用法见 assets/brand/README.md（sharp 不在 package.json 依赖里，临时安装；产物入库）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brand = path.join(root, 'assets/brand');
const webPublic = path.join(root, 'web/public');
const sharp = createRequire(import.meta.url)('sharp');

const big = readFileSync(path.join(brand, 'weft-icon.svg'));
const small = readFileSync(path.join(brand, 'weft-icon-small.svg'));
const SMALL_MAX = 32;

async function png(size) {
  const svg = size <= SMALL_MAX ? small : big;
  // 4 倍密度渲染后缩放，小尺寸边缘更平滑。
  return sharp(svg, { density: 72 * 4 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

mkdirSync(path.join(brand, 'png'), { recursive: true });
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) {
  writeFileSync(path.join(brand, 'png', `weft-icon-${s}.png`), await png(s));
}

// ICO：各帧均为 PNG 压缩，256 帧在目录项里写作 0。
const frames = [];
for (const s of [16, 20, 24, 32, 40, 48, 64, 256]) frames.push({ s, data: await png(s) });
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(frames.length, 4);
const dir = Buffer.alloc(16 * frames.length);
let offset = 6 + dir.length;
frames.forEach(({ s, data }, i) => {
  const o = i * 16;
  dir[o] = s >= 256 ? 0 : s;
  dir[o + 1] = s >= 256 ? 0 : s;
  dir.writeUInt16LE(1, o + 4);
  dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(data.length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += data.length;
});
writeFileSync(path.join(brand, 'weft.ico'), Buffer.concat([head, dir, ...frames.map((f) => f.data)]));

// 网页 favicon：SVG 用小图版，PNG 32 兜底，apple-touch-icon 180 用大图版。
mkdirSync(webPublic, { recursive: true });
writeFileSync(path.join(webPublic, 'favicon.svg'), small);
writeFileSync(path.join(webPublic, 'favicon-32.png'), await png(32));
writeFileSync(
  path.join(webPublic, 'apple-touch-icon.png'),
  await sharp(big, { density: 72 * 4 }).resize(180, 180).png({ compressionLevel: 9 }).toBuffer(),
);
console.log('done');
