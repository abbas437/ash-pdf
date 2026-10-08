// Geometry for the Edit text tool (ui/textedit.js): where a PDFium text line (bbox in PDF user space)
// sits on the displayed page, which line is under the pointer, and where in the line a click landed.
// `g` is { view, rotate } as pdf.js gives them (see imgedit-lib.js). Pure: usable in Node tests.
import { pdfBoxToPage, pageToPdf } from './imgedit-lib.js';

/** Line box in page space {x, y, w, h} (points, y down, /Rotate applied). */
export const linePageBox = (g, bbox) => pdfBoxToPage(g, bbox);

/**
 * The line's PDF bbox, grown to a usable height when PDFium reports a flat one (seen for subset
 * TrueType fonts without glyph boxes): baseline - 0.2 x size .. baseline + 0.8 x size across the text.
 */
export function lineBox({ bbox: [l, b, r, t], size = 0, rotation = 0 }) {
  const rot = ((rotation % 360) + 360) % 360, lo = 0.2 * size, hi = 0.8 * size;
  if (rot === 90 || rot === 270) {
    if (r - l >= 0.5 * size) return [l, b, r, t];
    return rot === 90 ? [l - hi, b, r + lo, t] : [l - lo, b, r + hi, t];
  }
  if (t - b >= 0.5 * size) return [l, b, r, t];
  return rot === 180 ? [l, b - hi, r, t + lo] : [l, b - lo, r, t + hi];
}

/**
 * Inline editor placement in CSS px relative to the unrotated page view at `scale` CSS px per point:
 * {left, top, width, height, fontSize}. The font size is the line size times the scale.
 */
export function editorPlacement(g, bbox, size, scale) {
  const b = linePageBox(g, bbox);
  return { left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale, fontSize: size * scale };
}

/** The line whose page box contains page point (x, y), with `pad` points of slack; the smallest wins. */
export function lineAt(g, lines, x, y, pad = 1) {
  let best = null, area = Infinity;
  for (const l of lines) {
    const b = linePageBox(g, lineBox(l));
    if (x < b.x - pad || x > b.x + b.w + pad || y < b.y - pad || y > b.y + b.h + pad) continue;
    if (b.w * b.h < area) { best = l; area = b.w * b.h; }
  }
  return best;
}

/** Character index in the line text nearest to page point (x, y), along the line's writing direction. */
export function charIndexAt(g, line, x, y) {
  const [X, Y] = pageToPdf(g, x, y);
  const [l, b, r, t] = line.bbox;
  const rot = (((line.rotation ?? 0) % 360) + 360) % 360;
  const frac = rot === 90 ? (Y - b) / (t - b) : rot === 180 ? (r - X) / (r - l) : rot === 270 ? (t - Y) / (t - b) : (X - l) / (r - l);
  return Math.max(0, Math.min(line.text.length, Math.round((Number.isFinite(frac) ? frac : 0) * line.text.length)));
}

/** [start, end) of the word around character index i (all of the text if the word is empty). */
export function wordAt(text, i) {
  const isW = (c) => !!c && !/\s/.test(c);
  let s = i, e = i;
  while (s > 0 && isW(text[s - 1])) s--;
  while (e < text.length && isW(text[e])) e++;
  return s === e ? [0, text.length] : [s, e];
}
