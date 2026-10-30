import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Prototype build: the same `web/src` product UI, but the entry installs the
 * in-browser mock backend and hash routing, and the output is one HTML file that
 * opens from `file://` with no server and no network.
 *
 * `emptyOutDir` stays off on purpose: `design/prototype/README.md` lives next to
 * the generated `index.html` and must survive a rebuild.
 */
const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, '..');
const protoRoot = path.resolve(webRoot, 'proto');
const require = createRequire(import.meta.url);
const brandIconsDir = path.join(
  path.dirname(require.resolve('@lobehub/icons-static-svg/package.json')),
  'icons',
);

function inlineScript(code: string): string {
  // A literal "</script" inside the bundle would end the inline block.
  return code.replace(/<\/script/gi, '<\\/script');
}

/** Fold every emitted JS/CSS asset into the HTML and drop the separate files. */
function singleFile(): Plugin {
  return {
    name: 'weft-proto-single-file',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlKey = Object.keys(bundle).find((key) => key.endsWith('.html'));
      const htmlAsset = htmlKey ? bundle[htmlKey] : undefined;
      if (!htmlKey || !htmlAsset || htmlAsset.type !== 'asset') {
        throw new Error('prototype build produced no index.html');
      }
      let html = String(htmlAsset.source);
      const scripts: string[] = [];
      const styles: string[] = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName === htmlKey) continue;
        if (output.type === 'chunk') {
          scripts.push(inlineScript(output.code));
          delete bundle[fileName];
          continue;
        }
        if (fileName.endsWith('.css')) {
          styles.push(String(output.source));
          delete bundle[fileName];
          continue;
        }
        // Everything else (source maps, stray assets) would break single-file output.
        delete bundle[fileName];
      }
      html = html
        .replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*><\/script>\s*/gi, '')
        .replace(/<link\b[^>]*\brel="(?:modulepreload|stylesheet)"[^>]*>\s*/gi, '');
      const bodyParts: string[] = [];
      if (styles.length) bodyParts.push(`<style>\n${styles.join('\n')}\n</style>`);
      if (scripts.length) bodyParts.push(`<script type="module">\n${scripts.join('\n')}\n</script>`);
      // A function replacement keeps `$&` / `$'` sequences in the bundle literal.
      html = html.replace('</body>', () => `${bodyParts.join('\n')}\n</body>`);
      htmlAsset.source = html;
    },
  };
}

export default defineConfig({
  root: protoRoot,
  base: './',
  publicDir: false,
  plugins: [react(), singleFile()],
  resolve: {
    alias: {
      '@lobehub/icons-static-svg/icons': brandIconsDir,
    },
  },
  build: {
    outDir: path.resolve(repoRoot, 'design/prototype'),
    emptyOutDir: false,
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
  },
});
