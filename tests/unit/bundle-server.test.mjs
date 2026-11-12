import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bundleServer } from '../../scripts/bundle-server.mjs';
import { bundledPackageJson } from '../../scripts/pack-release.mjs';
import { runSmoke } from '../../scripts/smoke-packaged.mjs';

// 内网包用 esbuild 打包服务端。这里真打一遍，再起打出来的 server.mjs 走一次冒烟，
// 确认按文件路径找资源的地方（brand-data、openapi、pwsh 包装脚本、插件）在 bundle 布局下都还对。
test('bundleServer 产物能起服务并跑完一次对话、shell 和 grep', { timeout: 110_000 }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'weft-bundle-'));
  try {
    const { files } = await bundleServer({ outDir: out });
    for (const rel of [
      'server.mjs',
      'bin/weft.mjs',
      'src/platform/win/pwsh-utf8-wrapper.mjs',
      'plugins/ask/index.mjs',
      'plugins/ask/plugin.json',
      'src/v2/views/brand-data.json',
      'contract/openapi.json',
    ]) {
      assert.ok(files.includes(rel), `产物清单缺 ${rel}`);
      await access(path.join(out, rel));
    }
    // 项目自有源码里的 import.meta.url 都换成了虚拟位置；留着的只有 node_modules 里的和 banner 里的。
    const server = await readFile(path.join(out, 'server.mjs'), 'utf8');
    assert.match(server, /new URL\("server\.mjs", __weftAppRoot\)/);
    await writeFile(path.join(out, 'package.json'), JSON.stringify(bundledPackageJson(JSON.parse(await readFile('package.json', 'utf8')))));
    const result = await runSmoke({ app: out, label: 'unit' });
    assert.ok(result.importsMs >= 0);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
