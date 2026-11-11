// hashline-style read / edit for the Pi Durable kernel.
// read prints every text line as `LINE#HASH:content`; edit addresses lines by
// those anchors and refuses (E_STALE_ANCHOR) when the file moved on, so the
// model re-reads instead of patching the wrong lines. The anchor core is
// src/vendor/hashline (see its README). File IO goes through api.env only, so
// the workspace path checks and the encoding/CRLF handling of the env apply.
import { arr, num, obj, opt, str } from '@earendil-works/pi-schema';
import { defineTool } from '@earendil-works/pi-durable';
import { FileError, getOrThrow } from '@earendil-works/pi-durable/env';
import { createEditTool, createReadTool } from '@earendil-works/pi-durable/tools';
import { applyHashlineEdits } from '../vendor/hashline/apply.mjs';
import { computeAffectedLineRange, formatHashlineRegion, splitVisibleLines } from '../vendor/hashline/format.mjs';
import { computeLineHash } from '../vendor/hashline/hash.mjs';
import { resolveEditAnchors } from '../vendor/hashline/parse.mjs';
import { diffStats } from '../core/diff.mjs';

export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50 * 1024;
const MAX_TEXT_FILE_BYTES = 32 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const ANCHOR_BLOCK_BYTES = 50 * 1024;

export function requireEnv(api) {
  if (!api?.env) throw new FileError('invalid', 'E_SANDBOX: conversation cwd is not set');
  return api.env;
}

// ---------------------------------------------------------------------------
// text helpers (same semantics as the official edit tool)

export function stripBom(content) {
  return content.startsWith('﻿') ? { bom: '﻿', text: content.slice(1) } : { bom: '', text: content };
}

export function detectLineEnding(content) {
  const lf = content.indexOf('\n');
  if (lf === -1) return '\n';
  const crlf = content.indexOf('\r\n');
  return crlf !== -1 && crlf < lf ? '\r\n' : '\n';
}

export function normalizeToLF(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text, ending) {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

const UNICODE_SPACES = /[  -   　]/g;

function toolPath(value) {
  if (typeof value !== 'string' || value === '') throw new Error('"path" is required.');
  const text = value.replace(UNICODE_SPACES, ' ');
  return text.startsWith('@') ? text.slice(1) : text;
}

async function resolveReadable(env, value, context) {
  return getOrThrow(await env.absolutePath(toolPath(value), context));
}

function isImageHead(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;
  return false;
}

/** One writer per file at a time, so two edits in one turn do not interleave. */
const queues = new Map();
async function withFileQueue(key, work) {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

// ---------------------------------------------------------------------------
// read

const READ_DESCRIPTION = [
  'Read a text file. Every line returns as `LINE#HASH:content`; copy those anchors verbatim into `edit` - they are the only way edits address lines.',
  '',
  `Page large files with \`offset\` (1-based line) and \`limit\`. \`offset\` is simply the line to start from: compute it yourself to jump to a known region (lines 440-569 -> offset=440, limit=130), or use the reported offset to continue truncated output. Output is capped at ${READ_MAX_LINES} lines or ${READ_MAX_BYTES / 1024}KB; continuation notices come after it.`,
  '',
  'Images (jpg, png, gif, webp) return as attachments without anchors. Binary files and directories are rejected. An empty file returns an advisory: insert content with edit `prepend`/`append`, omitting `pos`.',
  '',
  'Use read before edit whenever you do not hold current LINE#HASH anchors for the file.',
].join('\n');

/**
 * Text files come back as hashline lines; images go to the official read tool.
 * `official` is injectable for tests.
 */
export function createHashlineReadTool({ official = createReadTool() } = {}) {
  return defineTool({
    name: 'read',
    description: READ_DESCRIPTION,
    parameters: obj({
      path: str({ description: 'Path to the file to read (relative or absolute)' }),
      offset: opt(num({ description: 'Line number to start reading from (1-indexed)' })),
      limit: opt(num({ description: 'Maximum number of lines to read' })),
    }, { open: true }),
    async execute(args, api, context) {
      const env = requireEnv(api);
      const absolutePath = await resolveReadable(env, args.path, context);
      const info = getOrThrow(await env.fileInfo(absolutePath, context));
      if (info.kind === 'directory') {
        throw new Error(`${args.path} is a directory. Use ls to list it.`);
      }
      let head = new Uint8Array(0);
      const reader = getOrThrow(await env.openBinaryReader(absolutePath, undefined, context));
      try {
        head = getOrThrow(await reader.read(0, SNIFF_BYTES, context));
      } finally {
        await reader.close(context);
      }
      if (isImageHead(head)) return official.execute(args, api, context);
      if (head.includes(0)) {
        throw new Error(`${args.path} is a binary file; read only handles text files and images.`);
      }
      if (info.size > MAX_TEXT_FILE_BYTES) {
        throw new Error(`${args.path} is ${Math.round(info.size / 1024 / 1024)}MB; too large for read. Use bash (sed -n / head) for a slice.`);
      }
      const raw = getOrThrow(await env.readTextFile(absolutePath, context));
      const lines = splitVisibleLines(normalizeToLF(stripBom(raw).text));
      return renderRead(lines, args);
    },
  });
}

/** The read result for already-split lines: anchors, paging, truncation notices. */
export function renderRead(lines, args) {
  const total = lines.length;
  if (total === 0) {
    return {
      output: [],
      diagnostics: [{ severity: 'info', code: 'empty', message: 'File is empty. Insert content with edit prepend/append, omitting pos.' }],
    };
  }
  const offset = Number.isFinite(args.offset) && args.offset > 1 ? Math.floor(args.offset) : 1;
  if (offset > total) throw new Error(`Offset ${args.offset} is beyond end of file (${total} lines total)`);
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : undefined;
  const wanted = limit === undefined ? total : Math.min(total, offset + limit - 1);
  const width = String(Math.min(wanted, offset + READ_MAX_LINES - 1)).length;

  const out = [];
  let bytes = 0;
  let last = offset - 1;
  let byteCut = false;
  let firstLineCut = false;
  for (let n = offset; n <= wanted; n++) {
    if (out.length >= READ_MAX_LINES) break;
    const prefix = `${String(n).padStart(width, ' ')}#${computeLineHash(lines, n - 1)}:`;
    let text = prefix + lines[n - 1];
    let size = Buffer.byteLength(text, 'utf8') + (out.length ? 1 : 0);
    if (bytes + size > READ_MAX_BYTES) {
      if (out.length === 0) {
        // A single line over the cap: show its start rather than nothing.
        text = Buffer.from(text, 'utf8').subarray(0, READ_MAX_BYTES).toString('utf8').replace(/�$/, '');
        size = Buffer.byteLength(text, 'utf8');
        firstLineCut = true;
      } else {
        byteCut = true;
        break;
      }
    }
    out.push(text);
    bytes += size;
    last = n;
    if (firstLineCut) break;
  }

  const diagnostics = [];
  if (firstLineCut) {
    diagnostics.push({
      severity: 'warn',
      code: 'truncated',
      message: `Line ${offset} exceeds ${READ_MAX_BYTES / 1024}KB; only its start is shown. Use bash to inspect the rest.`,
    });
  }
  if (last < wanted) {
    diagnostics.push({
      severity: 'info',
      code: 'truncated',
      message: `Showing lines ${offset}-${last} of ${total}${byteCut ? ` (${READ_MAX_BYTES / 1024}KB limit)` : ''}. Use offset=${last + 1} to continue.`,
    });
  } else if (wanted < total) {
    diagnostics.push({
      severity: 'info',
      message: `${total - wanted} more lines in file. Use offset=${wanted + 1} to continue.`,
    });
  }
  const text = out.join('\n');
  return { output: [{ type: 'text', text }], structuredOutput: text, diagnostics };
}

// ---------------------------------------------------------------------------
// edit

const EDIT_DESCRIPTION = [
  'Patch a text file at `LINE#HASH` anchors copied verbatim from the latest read/grep result or the anchors block of a previous edit.',
  '',
  'Batch every change to a file into one `edit` call: all operations go in the `edits` array, every edit sets `op`, and all anchors must come from the same pre-edit read. Edits validate against one snapshot and apply together, so line numbers never shift between entries of the same call.',
  '',
  'Ops:',
  '- `replace`: replace the single line at `pos`, or the inclusive span `pos`..`end`. `lines` is the complete new content for the whole span; `lines: []` deletes it. Without `end`, exactly one line is replaced no matter how many entries `lines` has.',
  '- `append`: insert `lines` after `pos`; omit `pos` to append at end of file.',
  '- `prepend`: insert `lines` before `pos`; omit `pos` to insert at start of file.',
  '',
  'Example, single-line and span replace in one call:',
  '{"path":"src/main.ts","edits":[{"op":"replace","pos":"12#MQQ","lines":["const x = 1;"]},{"op":"replace","pos":"5#VRQ","end":"8#QVQ","lines":["function greet(name) {","  return `Hello, ${name}`;","}"]}]}',
  '',
  'Rules:',
  '- `lines` is literal file content with exact indentation. Never include `LINE#HASH:` or bare `HHH:` prefixes, diff `+`/`-` markers, or a copy of a neighboring line; the `:content` part of an anchor is context for you, not payload, and repeating a boundary line duplicates it in the file.',
  '- Anchors are opaque: copy them exactly, never compute, shift, or guess one.',
  '- An anchor may keep the `:content` suffix from read output ("12#MQQ:const x = 1;"). The runtime cross-checks that content against the file, so keep it for high-risk anchors such as range endpoints. Copy it exactly as rendered; if you shorten it, keep the start of the line and mark the cut with `...`.',
  '- Edits in one call must not overlap or touch adjacent lines; merge such changes into a single edit.',
  '- Never reuse anchors from an earlier read or edit once a newer one exists for the same file. After a successful edit, the returned anchors block replaces a re-read for nearby follow-up edits.',
  '- On [E_STALE_ANCHOR], re-read the file to get current anchors before retrying.',
].join('\n');

const editItemSchema = obj({
  op: opt(str({ description: '"replace", "append" or "prepend".' })),
  pos: opt(str({ description: 'Start anchor (LINE#HASH from read). Required for replace. Omit to append at EOF or prepend at BOF.' })),
  end: opt(str({ description: 'Inclusive end anchor (LINE#HASH) of the range to replace. Only replace supports end.' })),
  lines: opt(arr(str(), { description: 'Replacement content, one array entry per line, no LINE#HASH prefix.' })),
  // Old text-replace shape, still run as before for calls recorded by older versions.
  oldText: opt(str()),
  newText: opt(str()),
}, { open: true });

const editSchema = obj({
  path: str({ description: 'Path to the file to edit (relative or absolute)' }),
  edits: arr(editItemSchema, { description: 'Hashline edits over $path.' }),
}, { open: true });

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLegacyItem(item) {
  return isRecord(item) && (typeof item.oldText === 'string' || typeof item.newText === 'string');
}

function anchorsBlock(resultLines, range) {
  if (!range) return 'Anchors omitted; use read for subsequent edits.';
  const block = `--- Anchors ${range.start}-${range.end} ---\n${formatHashlineRegion(resultLines, range.start, range.end)}`;
  return Buffer.byteLength(block, 'utf8') <= ANCHOR_BLOCK_BYTES ? block : 'Anchors omitted; use read for subsequent edits.';
}

function warningsBlock(warnings) {
  return warnings?.length ? `Warnings:\n${warnings.join('\n')}` : '';
}

/**
 * Hashline edit. Calls in the old `{ oldText, newText }` shape (recorded by
 * earlier versions, or sent by a model that still uses it) are handed to the
 * official text-replace edit unchanged, so history and replay keep working.
 */
export function createHashlineEditTool({ official = createEditTool() } = {}) {
  return defineTool({
    name: 'edit',
    description: EDIT_DESCRIPTION,
    parameters: editSchema,
    prepareArguments(input) {
      if (!isRecord(input)) return input;
      let args = official.prepareArguments ? official.prepareArguments(input) : { ...input };
      if (!isRecord(args)) return args;
      args = { ...args };
      if (typeof args.path !== 'string' && typeof args.file_path === 'string') {
        args.path = args.file_path;
        delete args.file_path;
      }
      if (typeof args.edits === 'string') {
        try {
          const parsed = JSON.parse(args.edits);
          if (Array.isArray(parsed)) args.edits = parsed;
        } catch { /* validation reports it */ }
      }
      if (isRecord(args.edits)) args.edits = [args.edits];
      if (Array.isArray(args.edits)) {
        args.edits.forEach((item, index) => {
          if (isRecord(item) && item.lines === null) {
            throw new Error(`Edit ${index}: "lines" is null. "lines" is required content; provide an array of lines.`);
          }
        });
      }
      return args;
    },
    async execute(args, api, context) {
      const edits = args?.edits;
      if (!Array.isArray(edits) || edits.length === 0) throw new Error('No edits provided.');
      const legacy = edits.filter(isLegacyItem).length;
      if (legacy > 0) {
        if (legacy !== edits.length) {
          throw new Error('Do not mix oldText/newText edits with hashline edits in one call; use LINE#HASH anchors.');
        }
        return official.execute(args, api, context);
      }
      const env = requireEnv(api);
      const absolutePath = getOrThrow(await env.absolutePath(toolPath(args.path), context));
      return withFileQueue(absolutePath, async () => {
        if (context?.abortSignal?.aborted) throw new Error('Operation aborted');
        const info = await env.fileInfo(absolutePath, context);
        if (!info.ok) {
          if (info.error?.code === 'not_found') {
            throw new Error(`File not found: ${args.path}. Use the write tool to create new files.`);
          }
          throw new Error(`Could not edit file: ${args.path}. Error code: ${info.error?.code}.`, { cause: info.error });
        }
        if (info.value.kind !== 'file' && info.value.kind !== 'symlink') {
          throw new Error(`Could not edit file: ${args.path}. Path is not a file.`);
        }
        const read = await env.readTextFile(absolutePath, context);
        if (!read.ok) throw new Error(`Could not edit file: ${args.path}. Error code: ${read.error?.code}.`, { cause: read.error });
        const { bom, text } = stripBom(read.value);
        if (text.includes('\0')) throw new Error(`${args.path} is a binary file; hashline edit only supports text files.`);
        const ending = detectLineEnding(text);
        const before = normalizeToLF(text);

        const applied = applyHashlineEdits(before, resolveEditAnchors(edits), context?.abortSignal);
        const warnings = applied.warnings ?? [];
        if (applied.content === before) {
          const noop = applied.noopEdits?.length
            ? applied.noopEdits.map((e) => `Edit ${e.editIndex}: replacement for ${e.loc} is identical to current content.`).join('\n')
            : 'The edits produced identical content.';
          return {
            output: [{ type: 'text', text: [`No changes made to ${args.path}`, noop, warningsBlock(warnings)].filter(Boolean).join('\n') }],
            details: { path: args.path, warnings },
          };
        }
        if (context?.abortSignal?.aborted) throw new Error('Operation aborted');
        const write = await env.writeFile(absolutePath, bom + restoreLineEndings(applied.content, ending), context);
        if (!write.ok) throw new Error(`Could not edit file: ${args.path}. Error code: ${write.error?.code}.`, { cause: write.error });

        const { added, removed } = diffStats(before, applied.content);
        const resultLines = splitVisibleLines(applied.content);
        const range = computeAffectedLineRange(applied.firstChangedLine, applied.lastChangedLine, resultLines.length);
        const sections = [
          `Edited ${args.path} (+${added} −${removed})`,
          anchorsBlock(resultLines, range),
          warningsBlock(warnings),
        ].filter(Boolean);
        return {
          output: [{ type: 'text', text: sections.join('\n\n') }],
          details: { path: args.path, firstChangedLine: applied.firstChangedLine, warnings },
        };
      });
    },
  });
}
