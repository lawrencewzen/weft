// Builds the single-file prototype: app CSS inlined, every captured state in a
// fixed 1440x900 frame, and a small toolbar. No external URLs of any kind.
import fs from 'node:fs/promises';
import path from 'node:path';

const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

const MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** `/vendor/brand-icons/x.svg` → data URI, so the file opens without a server. */
export async function inlineAssets(html, repoRoot = process.cwd()) {
  let out = html;
  const refs = new Set([...html.matchAll(/src="(\/vendor\/[^"]+)"/g)].map((m) => m[1]));
  for (const ref of refs) {
    const file = path.join(repoRoot, 'public', ref.replace(/^\//, ''));
    const buf = await fs.readFile(file);
    const mime = MIME[path.extname(file)] || 'application/octet-stream';
    out = out.split(`src="${ref}"`).join(`src="data:${mime};base64,${buf.toString('base64')}"`);
  }
  return out.split('src="x"').join(`src="${TRANSPARENT_GIF}"`);
}

const URL_ATTR = /(?:src|href)="([^"]*)"/g;
const CSS_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;

/** Fail loudly while capturing if anything would need the network. */
export function assertSelfContained(html, where) {
  const bad = [];
  for (const match of html.matchAll(URL_ATTR)) {
    const value = match[1];
    if (!value || /^(data:|#|blob:)/.test(value)) continue;
    bad.push(match[0]);
  }
  for (const match of html.matchAll(CSS_URL)) {
    const value = match[1];
    if (!value || /^(data:|#|blob:)/.test(value)) continue;
    bad.push(match[0]);
  }
  if (bad.length) {
    throw new Error(`${where} 里还有外部引用：${bad.slice(0, 5).join(', ')}`);
  }
}

const PROTO_CSS = String.raw`
/* ===== 原型外壳（独立前缀，不覆盖网页端样式） ===== */
html, body {
  margin: 0; padding: 0; width: 100%; height: auto; overflow: auto;
  background: #f1f1f0; color: #1f1f1f;
}
html[data-theme$="dark"], html[data-theme$="dark"] body { background: #111; color: #ddd; }
body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Helvetica, "Segoe UI", sans-serif; }

.wp-bar {
  position: sticky; top: 0; z-index: 100; display: flex; align-items: center;
  justify-content: space-between; gap: 16px; box-sizing: border-box;
  min-height: 46px; padding: 7px 18px; border-bottom: 1px solid var(--line, #e6e6e6);
  background: var(--panel, #fff); color: var(--ink, #1f1f1f);
  font-size: 12px; line-height: 1.4;
}
html[data-theme$="dark"] .wp-bar { background: #1c1c1c; border-bottom-color: #2b2b2b; color: #e4e4e4; }
.wp-bar-left, .wp-bar-right { display: flex; align-items: center; gap: 10px; min-width: 0; }
.wp-bar-right { flex-shrink: 0; }
.wp-brand { font-weight: 600; letter-spacing: .01em; white-space: nowrap; }
.wp-brand em { font-style: normal; font-weight: 400; color: var(--mute, #6e6e6e); margin-left: 6px; }
html[data-theme$="dark"] .wp-brand em { color: #8f8f8f; }
.wp-select {
  font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--bd2, #dcdcdc); background: var(--panel, #fff); color: inherit;
  max-width: 210px;
}
html[data-theme$="dark"] .wp-select { border-color: #343434; background: #232323; }
.wp-select:disabled { opacity: .45; cursor: default; }
.wp-seg { display: flex; overflow: hidden; border: 1px solid var(--bd2, #dcdcdc); border-radius: 7px; }
html[data-theme$="dark"] .wp-seg { border-color: #343434; }
.wp-seg button {
  font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; border: none;
  background: transparent; color: var(--mute, #6e6e6e);
}
html[data-theme$="dark"] .wp-seg button { color: #9a9a9a; }
.wp-seg button.is-on { background: var(--accent, #2b2b2b); color: var(--on-accent, #fff); }
html[data-theme$="dark"] .wp-seg button.is-on { background: #e4e4e4; color: #181818; }
.wp-note {
  min-width: 0; max-width: 46ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--mute, #6e6e6e);
}
html[data-theme$="dark"] .wp-note { color: #8f8f8f; }
.wp-tag {
  flex-shrink: 0; padding: 1px 6px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--line, #e6e6e6); color: var(--mute, #6e6e6e);
}
html[data-theme$="dark"] .wp-tag { border-color: #2f2f2f; color: #8f8f8f; }

.wp-viewport { padding: 22px 0 40px; }
.wp-state { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 0 auto 28px; }
.wp-state[hidden] { display: none !important; }
.wp-label {
  display: flex; align-items: baseline; gap: 10px; padding: 0 2px; width: fit-content;
  max-width: min(1440px, calc(100vw - 48px)); font-size: 12px; color: #6e6e6e;
}
html[data-theme$="dark"] .wp-label { color: #8f8f8f; }
.wp-label b { font-weight: 600; color: #2b2b2b; font-size: 12px; }
html[data-theme$="dark"] .wp-label b { color: #e4e4e4; }
.wp-label code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; opacity: .8; }
.wp-label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wp-label .wp-proposal {
  flex-shrink: 0; padding: 1px 6px; border-radius: 999px; font-size: 11px;
  border: 1px solid #e0d3c4; background: #fbf5ee; color: #96602a;
}
html[data-theme$="dark"] .wp-label .wp-proposal { border-color: #4a3a28; background: #2a2118; color: #d6a05f; }
.wp-scaler { position: relative; width: 1440px; height: 900px; }
.wp-frame {
  position: absolute; top: 0; left: 0; width: 1440px; height: 900px; overflow: hidden;
  transform-origin: top left; border-radius: 12px; background: #fff;
  box-shadow: 0 6px 26px rgba(0, 0, 0, .12); border: 1px solid #dedede;
}
html[data-theme$="dark"] .wp-frame { border-color: #262626; background: #181818; box-shadow: 0 6px 26px rgba(0, 0, 0, .5); }
.wp-root { width: 1440px; height: 900px; overflow: hidden; }
`;

const TOOLBAR_JS = String.raw`
(function () {
  var meta = JSON.parse(document.getElementById('wp-meta').textContent);
  var groups = meta.groups;
  var byId = {};
  for (var i = 0; i < meta.states.length; i += 1) byId[meta.states[i].id] = meta.states[i];

  var groupSelect = document.getElementById('wp-group');
  var stateSelect = document.getElementById('wp-state');
  var note = document.getElementById('wp-note');
  var bar = document.getElementById('wp-bar');
  var stages = Array.prototype.slice.call(document.querySelectorAll('.wp-state'));
  var scalers = Array.prototype.slice.call(document.querySelectorAll('.wp-scaler'));
  var zoom = 'fit';
  var memory = {};

  function statesOf(group) {
    return meta.states.filter(function (state) { return state.group === group; });
  }

  function fillStateSelect(group, current) {
    stateSelect.textContent = '';
    var list = statesOf(group);
    for (var i = 0; i < list.length; i += 1) {
      var option = document.createElement('option');
      option.value = list[i].id;
      option.textContent = list[i].title;
      stateSelect.appendChild(option);
    }
    stateSelect.disabled = group === 'all';
    if (group !== 'all' && list.length) {
      stateSelect.value = current && byId[current] && byId[current].group === group ? current : list[0].id;
    }
  }

  function visibleIds() {
    return stages.filter(function (el) { return !el.hidden; }).map(function (el) { return el.getAttribute('data-state'); });
  }

  function syncScroll() {
    var shown = stages.filter(function (el) { return !el.hidden; });
    for (var i = 0; i < shown.length; i += 1) {
      var threads = shown[i].querySelectorAll('.center-thread');
      for (var j = 0; j < threads.length; j += 1) threads[j].scrollTop = threads[j].scrollHeight;
    }
  }

  function setNote(state) {
    if (!state) {
      note.textContent = meta.states.length + ' 个状态（从上往下排）';
      return;
    }
    note.textContent = state.note;
  }

  function show(target, push) {
    var group = 'baseline';
    var current = null;
    if (target === 'all') group = 'all';
    else if (byId[target]) { group = byId[target].group; current = target; }

    groupSelect.value = group;
    if (group === 'all') {
      for (var i = 0; i < stages.length; i += 1) stages[i].hidden = false;
      stateSelect.disabled = true;
      fillStateSelect('all', null);
      setNote(null);
    } else {
      var list = statesOf(group);
      current = current || memory[group] || (list[0] && list[0].id);
      memory[group] = current;
      for (var k = 0; k < stages.length; k += 1) {
        stages[k].hidden = stages[k].getAttribute('data-state') !== current;
      }
      fillStateSelect(group, current);
      stateSelect.value = current;
      setNote(byId[current]);
    }
    applyZoom();
    syncScroll();
    if (push !== false) {
      var next = group === 'all' ? '#all' : '#' + current;
      if (location.hash !== next) history.replaceState(null, '', next);
    }
  }

  function fitScale() {
    var availW = document.documentElement.clientWidth - 48;
    var availH = window.innerHeight - bar.offsetHeight - 60;
    var scale = Math.min(availW / 1440, availH / 900, 1);
    return scale > 0.2 ? scale : 0.2;
  }

  function applyZoom() {
    var scale = zoom === 'fit' ? fitScale() : 1;
    for (var i = 0; i < scalers.length; i += 1) {
      var frame = scalers[i].firstElementChild;
      frame.style.transform = 'scale(' + scale + ')';
      scalers[i].style.width = Math.round(1440 * scale) + 'px';
      scalers[i].style.height = Math.round(900 * scale) + 'px';
    }
    var fit = document.getElementById('wp-zoom-fit');
    var full = document.getElementById('wp-zoom-full');
    if (fit && full) {
      fit.classList.toggle('is-on', zoom === 'fit');
      full.classList.toggle('is-on', zoom !== 'fit');
    }
  }

  var light = document.getElementById('wp-theme-light');
  var dark = document.getElementById('wp-theme-dark');

  function applyTheme(mode) {
    var family = (document.documentElement.getAttribute('data-theme') || 'white-light').split('-')[0];
    document.documentElement.setAttribute('data-theme', family + '-' + mode);
    light.classList.toggle('is-on', mode === 'light');
    dark.classList.toggle('is-on', mode === 'dark');
    try { localStorage.setItem('weft_proto_theme', mode); } catch (err) { /* file:// may refuse */ }
  }

  groupSelect.addEventListener('change', function () {
    if (groupSelect.value === 'all') show('all');
    else show(memory[groupSelect.value] || (statesOf(groupSelect.value)[0] || {}).id);
  });
  stateSelect.addEventListener('change', function () { show(stateSelect.value); });
  document.getElementById('wp-zoom-fit').addEventListener('click', function () { zoom = 'fit'; applyZoom(); });
  document.getElementById('wp-zoom-full').addEventListener('click', function () { zoom = '100'; applyZoom(); });
  light.addEventListener('click', function () { applyTheme('light'); });
  dark.addEventListener('click', function () { applyTheme('dark'); });
  window.addEventListener('resize', applyZoom);
  window.addEventListener('hashchange', function () { show(location.hash.slice(1) || meta.states[0].id, false); });

  var stored = null;
  try { stored = localStorage.getItem('weft_proto_theme'); } catch (err) { stored = null; }
  applyTheme(stored === 'dark' ? 'dark' : 'light');

  var initial = decodeURIComponent(location.hash.slice(1)) || meta.states[0].id;
  show(initial, false);
}());
`;

const GROUP_LABEL = { baseline: '基线', proposal: '提案（未实现）' };

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function stateSection(state) {
  const proposal = state.group === 'proposal';
  const label = proposal
    ? '<span class="wp-proposal">提案（未实现）</span>'
    : '';
  return [
    `  <section class="wp-state" data-state="${escapeHtml(state.id)}" data-group="${state.group}" hidden>`,
    '    <div class="wp-label">',
    `      <b>${escapeHtml(state.title)}</b>`,
    `      <code>${escapeHtml(state.id)}</code>`,
    `      <span>${escapeHtml(state.note)}</span>`,
    `      ${label}`,
    '    </div>',
    '    <div class="wp-scaler"><div class="wp-frame"><div class="wp-root">',
    state.html,
    '    </div></div></div>',
    '  </section>',
  ].join('\n');
}

/**
 * `states` items: { id, title, note, group, html }.
 */
export function buildDocument({ css, states }) {
  const meta = {
    groups: [
      { id: 'all', label: '全部（从上往下）' },
      { id: 'baseline', label: GROUP_LABEL.baseline },
      { id: 'proposal', label: GROUP_LABEL.proposal },
    ],
    states: states.map((state) => ({
      id: state.id,
      title: state.title,
      note: state.note,
      group: state.group,
    })),
  };
  const groupOptions = meta.groups
    .map((group) => `<option value="${group.id}">${escapeHtml(group.label)}</option>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="white-light" data-font-size="md">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weft · 网页端原型</title>
<style>${css}</style>
<style>${PROTO_CSS}</style>
</head>
<body>
<header class="wp-bar" id="wp-bar">
  <div class="wp-bar-left">
    <span class="wp-brand">Weft 原型<em>网页端</em></span>
    <select class="wp-select" id="wp-group" aria-label="分组">${groupOptions}</select>
    <select class="wp-select" id="wp-state" aria-label="状态"></select>
    <span class="wp-note" id="wp-note"></span>
  </div>
  <div class="wp-bar-right">
    <div class="wp-seg" id="wp-zoom">
      <button type="button" id="wp-zoom-fit" class="is-on">适应窗口</button>
      <button type="button" id="wp-zoom-full">100%</button>
    </div>
    <div class="wp-seg" id="wp-theme">
      <button type="button" id="wp-theme-light" class="is-on">浅色</button>
      <button type="button" id="wp-theme-dark">深色</button>
    </div>
  </div>
</header>
<div class="wp-viewport" id="wp-viewport">
${states.map(stateSection).join('\n')}
</div>
<script type="application/json" id="wp-meta">${JSON.stringify(meta).replaceAll('<', '\\u003c')}</script>
<script>${TOOLBAR_JS}</script>
</body>
</html>
`;
}
