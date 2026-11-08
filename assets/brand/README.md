# Weft 品牌图标

- `weft-icon.svg`：大图版（光晕 + 渐变描边），用于 48px 及以上。
- `weft-icon-small.svg`：小图版（粗线、无光晕），用于 32px 及以下。
- `png/weft-icon-{16,24,32,48,64,128,256,512}.png`：16/24/32 取小图版，其余取大图版，圆角外透明。
- `weft.ico`：多帧，16/20/24/32 小图版，40/48/64/256 大图版，各帧 PNG 压缩。
- 网页 favicon 由同一脚本写入 `web/public/`：`favicon.svg`（小图版）、`favicon-32.png`、`apple-touch-icon.png`（180，大图版）。

重新生成（sharp 不在项目依赖里，临时装一份，产物入库）：

```sh
mkdir /tmp/sharptmp && (cd /tmp/sharptmp && npm init -y --name sharptmp && npm i sharp)
NODE_PATH=/tmp/sharptmp/node_modules node scripts/gen-brand-icons.mjs
rm -rf /tmp/sharptmp
```
