export type HighlightSpan = {
  text: string;
  highlight: boolean;
};

export type HighlightedPath = {
  dir: string;
  name: string;
  dirSpans: HighlightSpan[];
  nameSpans: HighlightSpan[];
};

export function splitFilePath(filePath: string): { dir: string; name: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx === -1) {
    return { dir: '', name: normalized };
  }
  return {
    dir: normalized.slice(0, idx),
    name: normalized.slice(idx + 1),
  };
}

export function spansFromIndices(text: string, indices: number[]): HighlightSpan[] {
  if (!text) return [];
  if (!indices || indices.length === 0) {
    return [{ text, highlight: false }];
  }
  const set = new Set(indices);
  const spans: HighlightSpan[] = [];
  let curHighlight = set.has(0);
  let curText = text[0];

  for (let i = 1; i < text.length; i += 1) {
    const isHl = set.has(i);
    if (isHl === curHighlight) {
      curText += text[i];
    } else {
      spans.push({ text: curText, highlight: curHighlight });
      curHighlight = isHl;
      curText = text[i];
    }
  }
  spans.push({ text: curText, highlight: curHighlight });
  return spans;
}

export function findMatchIndices(text: string, query: string): number[] | null {
  if (!query) return [];
  if (!text) return null;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // 1. Exact substring check gives cleaner contiguous highlights
  const exact = lowerText.indexOf(lowerQuery);
  if (exact !== -1) {
    const idxs: number[] = [];
    for (let i = 0; i < query.length; i += 1) {
      idxs.push(exact + i);
    }
    return idxs;
  }

  // 2. Subsequence match (case-insensitive)
  const indices: number[] = [];
  let ti = 0;
  for (let qi = 0; qi < lowerQuery.length; qi += 1) {
    const ch = lowerQuery[qi];
    const found = lowerText.indexOf(ch, ti);
    if (found === -1) return null;
    indices.push(found);
    ti = found + 1;
  }
  return indices;
}

export function highlightFilePath(filePath: string, query: string): HighlightedPath {
  const { dir, name } = splitFilePath(filePath);
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      dir,
      name,
      dirSpans: dir ? [{ text: dir, highlight: false }] : [],
      nameSpans: [{ text: name, highlight: false }],
    };
  }

  // First, try matching within the filename alone
  const nameIndices = findMatchIndices(name, trimmed);
  if (nameIndices) {
    return {
      dir,
      name,
      dirSpans: dir ? [{ text: dir, highlight: false }] : [],
      nameSpans: spansFromIndices(name, nameIndices),
    };
  }

  // Next, try matching across the entire filePath (useful if query includes dir characters or '/')
  const pathIndices = findMatchIndices(filePath, trimmed);
  if (pathIndices) {
    const sepIdx = filePath.lastIndexOf('/');
    const dirIdxs: number[] = [];
    const nameIdxs: number[] = [];
    for (const idx of pathIndices) {
      if (idx < sepIdx) {
        dirIdxs.push(idx);
      } else if (idx > sepIdx) {
        nameIdxs.push(idx - sepIdx - 1);
      }
    }
    return {
      dir,
      name,
      dirSpans: dir ? spansFromIndices(dir, dirIdxs) : [],
      nameSpans: spansFromIndices(name, nameIdxs),
    };
  }

  // Fallback: no match
  return {
    dir,
    name,
    dirSpans: dir ? [{ text: dir, highlight: false }] : [],
    nameSpans: [{ text: name, highlight: false }],
  };
}
