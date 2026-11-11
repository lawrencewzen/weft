/**
 * Hash computation: NIBBLE_STR alphabet, xxh32, per-line hash.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi), via
 * @deathbeam/pi-hashline 0.0.12 (MIT). See ./README.md.
 */


// xxh32 (seed 0), written out here so the vendored code needs no xxhashjs.
// Output is identical to `XXH.h32(0).update(str).digest().toNumber() >>> 0`
// for UTF-8 input; tests/unit/hashline-core.test.mjs pins known vectors.
const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;
const rotl = (x, r) => ((x << r) | (x >>> (32 - r))) >>> 0;
function round(acc, lane) {
    return Math.imul(rotl((acc + Math.imul(lane, P2)) >>> 0, 13), P1) >>> 0;
}
export function xxh32(bytes, seed = 0) {
    const len = bytes.length;
    const read32 = (i) => (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
    let i = 0;
    let h;
    if (len >= 16) {
        let v1 = (seed + P1 + P2) >>> 0;
        let v2 = (seed + P2) >>> 0;
        let v3 = seed >>> 0;
        let v4 = (seed - P1) >>> 0;
        for (; i <= len - 16; i += 16) {
            v1 = round(v1, read32(i));
            v2 = round(v2, read32(i + 4));
            v3 = round(v3, read32(i + 8));
            v4 = round(v4, read32(i + 12));
        }
        h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
    }
    else {
        h = (seed + P5) >>> 0;
    }
    h = (h + len) >>> 0;
    for (; i <= len - 4; i += 4) {
        h = Math.imul(rotl((h + Math.imul(read32(i), P3)) >>> 0, 17), P4) >>> 0;
    }
    for (; i < len; i++) {
        h = Math.imul(rotl((h + Math.imul(bytes[i], P5)) >>> 0, 11), P1) >>> 0;
    }
    h ^= h >>> 15;
    h = Math.imul(h, P2) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, P3) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
}

/**
 * Fixed session hash length. 3 characters = 12 bits of the 3-line-window
 * xxh32 has a 2^-12 silent false-accept floor per stale anchor, on top of the
 * line-number primary key and the textHint content veto.
 */
export const HASH_LENGTH = 3;
/**
 * One character per nibble: an N-char hash reads the low 4*N bits of xxh32 directly. The alphabet
 * excludes hex digits, lookalikes, and vowels so hashes rarely coincide with real uppercase tokens.
 */
export const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
/** Anchor hashes are displayed uppercase; input matching tolerates any case. */
export const HASH_ALPHABET_RE = new RegExp(`^[${NIBBLE_STR}]+$`, "i");
/** True when a line contains at least one letter or digit. */
export const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;
/** Fuzzy-match Unicode replacement regexes for anchor textHint validation. */
const FUZZY_SINGLE_QUOTES_RE = /[\u2018\u2019\u201A\u201B]/g;
const FUZZY_DOUBLE_QUOTES_RE = /[\u201C\u201D\u201E\u201F]/g;
const FUZZY_HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const FUZZY_UNICODE_SPACES_RE = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;
/** First ASCII "..." or Unicode U+2026 in a hint marks it as model-truncated content. */
const ELLIPSIS_RE = /\.{3}|…/;
/**
 * Normalize a line for hash input: strip \r, trimEnd. Leading indentation
 * IS hashed; two lines differing only in indent get different hashes.
 */
export function normalizeHashInput(line) {
    return line.replace(/\r/g, "").trimEnd();
}
/**
 * Compute the hash from a line's content and its immediate neighbors.
 * Using prev + "\0" + curr + "\0" + next as the hash input ensures:
 * - Distant edits no longer invalidate anchors (only same/adjacent lines affected).
 * - Adjacent-edit invalidation is intentional: editing near an anchor makes it stale.
 * - Silent collisions now require the entire 3-line window to match.
 * All three inputs must already be normalized via normalizeHashInput.
 */
export function computeHashFromContext(prev, curr, next) {
    const h = xxh32(Buffer.from(prev + "\0" + curr + "\0" + next, "utf8"), 0);
    // Extract HASH_LENGTH nibbles from the low 4*HASH_LENGTH bits.
    let result = "";
    for (let i = HASH_LENGTH - 1; i >= 0; i--) {
        result += NIBBLE_STR[(h >>> (i * 4)) & 0x0f];
    }
    return result;
}
/**
 * Compute the hash for a line at a given 0-based index within a file.
 * Neighbors outside the file boundaries use "" as their normalized value.
 */
export function computeLineHash(fileLines, index) {
    const prev = normalizeHashInput(index > 0 ? fileLines[index - 1] : "");
    const curr = normalizeHashInput(fileLines[index]);
    const next = normalizeHashInput(index < fileLines.length - 1 ? fileLines[index + 1] : "");
    return computeHashFromContext(prev, curr, next);
}
/**
 * Whitespace on BOTH ends is normalized away. Trailing drift is classic
 * copy noise; leading drift covers both a space typed after the ":"
 * separator of an anchor ("12#ABC: content") and re-typed indentation.
 * Hashes themselves stay whitespace-exact; see normalizeHashInput.
 */
function normalizeFuzzyLine(text) {
    return text
        .trim()
        .replace(FUZZY_SINGLE_QUOTES_RE, "'")
        .replace(FUZZY_DOUBLE_QUOTES_RE, '"')
        .replace(FUZZY_HYPHENS_RE, "-")
        .replace(FUZZY_UNICODE_SPACES_RE, " ");
}
export function isFuzzyEquivalentLine(expected, actual) {
    return normalizeFuzzyLine(expected) === normalizeFuzzyLine(actual);
}
/** Fuzzy-normalized hint text before its first ellipsis, and whether it was truncated there. */
function hintPrefix(hint) {
    const normalized = normalizeFuzzyLine(hint);
    const ellipsisIndex = normalized.search(ELLIPSIS_RE);
    return ellipsisIndex === -1
        ? { prefix: normalized, truncated: false }
        : { prefix: normalized.slice(0, ellipsisIndex), truncated: true };
}
/**
 * Match a textHint against an actual file line for anchor validation.
 *
 * A full hint must be fuzzy-equivalent to the line. A hint containing an
 * ellipsis is treated as truncated content copied by the model (e.g.
 * "console.log(...)" for "console.log('hello world')"): only the
 * fuzzy-normalized prefix before the first ellipsis must match the start of
 * the line. An ellipsis-leading hint has an empty prefix and never vetoes.
 */
export function hintMatchesLine(hint, line) {
    const { prefix, truncated } = hintPrefix(hint);
    const normalizedLine = normalizeFuzzyLine(line);
    return truncated ? normalizedLine.startsWith(prefix) : normalizedLine === prefix;
}
/**
 * True when a hint can discriminate between lines: non-empty content before
 * any ellipsis. No-signal hints (empty or ellipsis-leading) would match every
 * line, so candidate scanning must skip them.
 */
export function hintHasSignal(hint) {
    return hintPrefix(hint).prefix.length > 0;
}
