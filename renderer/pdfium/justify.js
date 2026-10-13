// Layout math for editing a justified (spread) line of original text (pdfium/textedit.js). Pure functions:
// all widths and positions are in page points along the line's direction.

/** A line counts as spread (justified) when its word gaps average more than this times a normal space. */
export const SPREAD_RATIO = 1.3;

/** Whitespace-normalised line text, as the editor compares it: runs of whitespace -> one space, trimmed. */
export const normalizeLineText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const sameLineText = (a, b) => normalizeLineText(a) === normalizeLineText(b);
export const lineWords = (s) => normalizeLineText(s).split(' ').filter(Boolean);

/** Is a line of `gaps + 1` words whose words alone are `wordsWidth` wide, spread over `extent`? */
export function isSpread({ extent, wordsWidth, gaps, space }) {
  if (!(gaps >= 1) || !(space > 0) || !(extent > 0)) return false;
  return (extent - wordsWidth) / gaps > SPREAD_RATIO * space;
}

/** Word start positions across [start, end]: first word at start, last word ending at end, equal gaps of at
 *  least `space`. When the words do not fit (or there is one word) they are set from `start` with `space` gaps
 *  (spread: false), overflowing like an unjustified line. */
export function layoutWords({ start, end, widths, space }) {
  const total = widths.reduce((s, w) => s + w, 0);
  let gap = widths.length > 1 ? (end - start - total) / (widths.length - 1) : 0;
  const spread = widths.length > 1 && gap >= space;
  if (!spread) gap = space;
  const positions = [];
  let x = start;
  for (const w of widths) { positions.push(x); x += w + gap; }
  return { positions, gap, spread };
}
