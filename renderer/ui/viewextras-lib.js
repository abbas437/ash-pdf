// Pure helpers of viewextras.js (no DOM, no pdf.js), unit-tested in test/viewextras.test.js.
import { parseRanges } from '../../src/core/pdfOps.js';

/**
 * Layer tree from a pdf.js OptionalContentConfig-like object ({getOrder(), getGroup(id)}).
 * getOrder() entries are group ids or {name, order} (a nested /Order array). A nested array
 * without a name belongs to the item before it (PDF 32000 8.11.4.3); a named one is a heading.
 * Returns [{id, name, children}] and [{id: null, name, children}] for headings; [] = no layers.
 */
export function layerTree(cfg) {
  const order = cfg?.getOrder?.() ?? null;
  if (!order) return [];
  const walk = (list) => {
    const out = [];
    for (const item of list) {
      if (typeof item === 'string') {
        const g = cfg.getGroup(item);
        if (g) out.push({ id: item, name: g.name || item, children: [] });
      } else if (item && Array.isArray(item.order)) {
        const children = walk(item.order);
        if (!children.length) continue;
        if (item.name == null && out.length && out[out.length - 1].id) out[out.length - 1].children.push(...children);
        else if (item.name == null) out.push(...children);
        else out.push({ id: null, name: String(item.name), children });
      }
    }
    return out;
  };
  return walk(order);
}

/** All group ids of a layer tree, depth first. */
export function layerIds(tree) {
  return tree.flatMap((n) => [...(n.id ? [n.id] : []), ...layerIds(n.children)]);
}

/**
 * 0-based page indices to print. mode: 'all' | 'current' | 'range' | 'odd' | 'even'
 * (odd/even by page number). Throws RangeError (from parseRanges) for a bad range.
 */
export function printPageIndices({ mode, range, current, count }) {
  const all = Array.from({ length: count }, (_, i) => i);
  switch (mode) {
    case 'current': return [Math.min(Math.max(0, current), count - 1)];
    case 'range': return parseRanges(range ?? '', count);
    case 'odd': return all.filter((i) => i % 2 === 0);
    case 'even': return all.filter((i) => i % 2 === 1);
    default: return all;
  }
}

/** Text of one pdf.js getTextContent() result: item strings in order, a line break after hasEOL items. */
export function pageText(content) {
  return (content?.items ?? []).map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : '')).join('');
}

// Han ideographs, Hiragana and Katakana are written without spaces between words, so each such
// character counts as one word (as word processors do). Hangul, Arabic, Latin, Cyrillic etc. use
// spaces between words and go through the plain whitespace rule.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WORDISH = /[\p{L}\p{N}]/u;

/**
 * Word and character counts of a string. Rules:
 * - words: runs of non-whitespace; a run with no letter or digit (e.g. "—", "•") is not a word;
 *   inside a run every CJK character (Han, Hiragana, Katakana) is one word and the other characters
 *   between them form words of their own ("Windows版" = 2, "日本語" = 3). Arabic words, including
 *   diacritics and tatweel, count once per space-separated run.
 * - chars: Unicode code points except line breaks (\r, \n), which come from layout, not the text.
 * - charsNoSpaces: code points that are not whitespace.
 */
export function textStats(text) {
  const s = String(text ?? '');
  let words = 0;
  for (const run of s.split(/\s+/u)) {
    if (!run) continue;
    const cjk = run.match(CJK)?.length ?? 0;
    words += cjk + run.split(CJK).filter((part) => WORDISH.test(part)).length;
  }
  let chars = 0, charsNoSpaces = 0;
  for (const ch of s) {
    if (ch !== '\n' && ch !== '\r') chars++;
    if (!/\s/u.test(ch)) charsNoSpaces++;
  }
  return { words, chars, charsNoSpaces };
}

/** Sum of textStats() results. */
export function addStats(...list) {
  return list.reduce((a, b) => ({ words: a.words + b.words, chars: a.chars + b.chars, charsNoSpaces: a.charsNoSpaces + b.charsNoSpaces }), { words: 0, chars: 0, charsNoSpaces: 0 });
}

/**
 * Snapshot rectangle in page space from two drag points, clamped to the page ({width, height}).
 * Returns {x, y, w, h} or null when the area is smaller than `min` points either way (a click).
 */
export function snapRect(a, b, { width, height }, min = 2) {
  const cx = (v) => Math.min(Math.max(v, 0), width), cy = (v) => Math.min(Math.max(v, 0), height);
  const x0 = cx(Math.min(a.x, b.x)), x1 = cx(Math.max(a.x, b.x));
  const y0 = cy(Math.min(a.y, b.y)), y1 = cy(Math.max(a.y, b.y));
  return x1 - x0 < min || y1 - y0 < min ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
