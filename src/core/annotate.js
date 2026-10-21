// Overlay-object flattening ("burn in") for ASH PDF Studio.
// Objects use VISIBLE page coordinates: points, origin top-left, y down, after /Rotate.
import {
  StandardFonts,
  StandardFontEmbedder,
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  setLineJoin,
  setGraphicsState,
  beginText,
  endText,
  setFillingColor,
  setFontAndSize,
  setTextMatrix,
  PDFOperator,
  PDFOperatorNames,
  rgb,
} from 'pdf-lib';
import { loadPdf, saveEdited, pageGeometry, visibleUpMatrix, parseColor, coreError, ContentMap } from './internal.js';
import { calloutArrowHead } from './arrowhead.js';
import { stampLayout } from './stamps.js';
import { cloudPath } from './cloud.js';
import { STYLE_KEYS, boxStyle, runsOf } from './richtext.js';

// ---------------------------------------------------------------- fonts & text

const FONT_TABLE = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

/** Standard font name for a family/bold/italic triple. */
export function standardFontName(font = 'Helvetica', bold = false, italic = false) {
  const row = FONT_TABLE[font];
  if (!row) throw new TypeError(`Unknown font "${font}" (use Helvetica, Times or Courier)`);
  return row[(bold ? 1 : 0) + (italic ? 2 : 0)];
}

const embedderCache = new Map();
function metricsFor(name) {
  let e = embedderCache.get(name);
  if (!e) {
    e = StandardFontEmbedder.for(name);
    embedderCache.set(name, e);
  }
  return e;
}

/**
 * Make text encodable in the standard 14 fonts (WinAnsi): CRLF/CR -> LF,
 * TAB -> one space, any other unencodable code point -> '?'.
 */
export function sanitizeText(text) {
  const enc = metricsFor(StandardFonts.Helvetica).encoding;
  let out = '';
  for (const ch of String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')) {
    const cp = ch.codePointAt(0);
    out += ch === '\n' || enc.canEncodeUnicodeCodePoint(cp) ? ch : '?';
  }
  return out;
}

function wrapParagraph(par, widthOf, maxWidth) {
  if (!(maxWidth > 0) || widthOf(par) <= maxWidth) return [par];
  const lines = [];
  const tokens = par.split(/( +)/).filter((t) => t !== '');
  let cur = '';
  const pushWord = (word) => {
    // Hard-break a word that is wider than the box on its own.
    let rest = word;
    while (widthOf(rest) > maxWidth && rest.length > 1) {
      let k = 1;
      while (k < rest.length && widthOf(rest.slice(0, k + 1)) <= maxWidth) k++;
      lines.push(rest.slice(0, k));
      rest = rest.slice(k);
    }
    return rest;
  };
  for (const tok of tokens) {
    if (/^ +$/.test(tok)) {
      if (cur !== '') cur += tok;
      continue;
    }
    const candidate = cur + tok;
    if (cur === '' || widthOf(candidate.trimEnd()) <= maxWidth) {
      cur = cur === '' ? pushWord(tok) : candidate;
    } else {
      lines.push(cur.trimEnd());
      cur = pushWord(tok);
    }
  }
  lines.push(cur.trimEnd());
  return lines;
}

/**
 * Measure text exactly as flattenObjects will lay it out.
 * Returns {width, height, lines, lineHeight, ascent, descent, firstBaseline}
 * where line i's baseline is at top + firstBaseline + i * lineHeight.
 */
export function measureText(text, { font = 'Helvetica', bold = false, italic = false, fontSize = 12, maxWidth, lineHeight = 1.2 } = {}) {
  if (!(fontSize > 0)) throw new RangeError('fontSize must be > 0');
  const m = metricsFor(standardFontName(font, bold, italic));
  const widthOf = (s) => m.widthOfTextAtSize(s, fontSize);
  const clean = sanitizeText(text);
  const lines = clean.split('\n').flatMap((p) => wrapParagraph(p, widthOf, maxWidth));
  const lh = fontSize * lineHeight;
  const ascent = m.heightOfFontAtSize(fontSize, { descender: false });
  const descent = m.heightOfFontAtSize(fontSize) - ascent;
  return {
    width: Math.max(0, ...lines.map(widthOf)),
    height: lines.length * lh,
    lines,
    lineHeight: lh,
    ascent,
    descent,
    firstBaseline: (lh - (ascent + descent)) / 2 + ascent,
  };
}

// ---------------------------------------------------------------- rich text layout

const BOOL_KEYS = new Set(['bold', 'italic', 'underline', 'strike']);

/** Effective style of a run: the box style with the run's overrides (a non-positive size keeps the box size). */
function runStyle(run, box) {
  const s = { ...box };
  for (const k of STYLE_KEYS) {
    const v = run[k];
    if (v === undefined || v === null) continue;
    if (k === 'fontSize') {
      if (Number.isFinite(v) && v > 0) s.fontSize = v;
    } else if (BOOL_KEYS.has(k)) s[k] = !!v;
    else s[k] = k === 'color' ? String(v).trim().toLowerCase() : String(v);
  }
  return s;
}

const sameRunStyle = (a, b) => STYLE_KEYS.every((k) => a[k] === b[k]);

/**
 * Lay out a text / callout object's text, runs-aware (see richtext.js), exactly as flattenObjects
 * draws it. Coordinates are visible (y down), relative to `origin` (the box's top-left, default 0,0).
 * Lines wrap at spaces within `maxWidth` (a word longer than the box is hard-broken), across run
 * boundaries; '\n' starts a new line; the line height is the largest font size on the line x
 * lineHeight; `align` (left/center/right) applies per line within maxWidth. Without runs this is
 * exactly measureText's wrapping.
 * Returns { width, height, lines: [{ top, height, baseline, width, x, fragments }] } with
 * fragments [{ text, x, width, baseline, style: {font, fontSize, bold, italic, underline, strike, color},
 * decorations: [{ type: 'underline'|'strike', y, thickness }] }] (decoration y = centre of the bar).
 */
export function layoutRich(obj, maxWidth, { x: ox = 0, y: oy = 0 } = {}) {
  const box = boxStyle(obj);
  if (!(box.fontSize > 0)) throw new RangeError('fontSize must be > 0');
  const lineHeight = num(obj.lineHeight, 1.2);
  // the sanitized text, one style per code unit (adjacent equal styles share one entry)
  const styles = [];
  const at = [];
  let text = '';
  for (const r of runsOf(obj)) {
    const t = sanitizeText(r.text);
    if (!t) continue;
    const s = runStyle(r, box);
    if (!styles.length || !sameRunStyle(styles[styles.length - 1], s)) {
      const m = metricsFor(standardFontName(s.font, s.bold, s.italic));
      styles.push({ s, m });
    }
    text += t;
    for (let i = 0; i < t.length; i++) at.push(styles.length - 1);
  }
  const segments = (a, b) => {
    const out = [];
    for (let i = a; i < b; ) {
      let j = i + 1;
      while (j < b && at[j] === at[i]) j++;
      out.push([i, j, styles[at[i]]]);
      i = j;
    }
    return out;
  };
  const widthOf = (a, b) => segments(a, b).reduce((w, [i, j, { s, m }]) => w + m.widthOfTextAtSize(text.slice(i, j), s.fontSize), 0);
  const boxMetrics = { s: box, m: metricsFor(standardFontName(box.font, box.bold, box.italic)) };
  const styleAtPos = (i) => (text.length ? styles[at[Math.min(i, text.length - 1)]] : boxMetrics);

  const ranges = [];
  let start = 0;
  for (const par of text.split('\n')) {
    ranges.push(...wrapRange(start, start + par.length, text, widthOf, maxWidth));
    start += par.length + 1;
  }

  const lines = ranges.map(([a, b]) => {
    const frags = segments(a, b);
    const used = frags.length ? frags.map(([, , st]) => st) : [styleAtPos(a)];
    let size = 0, ascent = 0, descent = 0;
    for (const { s, m } of used) {
      const asc = m.heightOfFontAtSize(s.fontSize, { descender: false });
      size = Math.max(size, s.fontSize);
      ascent = Math.max(ascent, asc);
      descent = Math.max(descent, m.heightOfFontAtSize(s.fontSize) - asc);
    }
    const lh = size * lineHeight;
    return { frags, height: lh, inner: (lh - (ascent + descent)) / 2 + ascent, width: frags.length ? widthOf(a, b) : 0 };
  });
  // equal line heights: line i at i * lineHeight (the arithmetic measureText / the old drawing used)
  const uniform = lines.every((l) => l.height === lines[0].height);
  const width = Math.max(0, ...lines.map((l) => l.width));
  const alignWidth = maxWidth > 0 ? maxWidth : width;
  const align = obj.align || 'left';
  let top = 0;
  const out = lines.map((l, i) => {
    const lineTop = uniform ? i * l.height : top;
    top += l.height;
    const baseline = oy + l.inner + lineTop;
    let x = ox;
    if (align === 'center') x = ox + (alignWidth - l.width) / 2;
    else if (align === 'right') x = ox + alignWidth - l.width;
    let cx = x;
    const fragments = l.frags.map(([fa, fb, { s, m }]) => {
      const w = m.widthOfTextAtSize(text.slice(fa, fb), s.fontSize);
      const decorations = [];
      const thickness = (m.font.UnderlineThickness / 1000) * s.fontSize;
      if (s.underline) decorations.push({ type: 'underline', y: baseline - (m.font.UnderlinePosition / 1000) * s.fontSize, thickness });
      if (s.strike) decorations.push({ type: 'strike', y: baseline - (m.font.XHeight / 2000) * s.fontSize, thickness });
      const fr = { text: text.slice(fa, fb), x: cx, width: w, baseline, style: { ...s }, decorations };
      cx += w;
      return fr;
    });
    return { top: oy + lineTop, height: l.height, baseline, width: l.width, x, fragments };
  });
  return { width, height: uniform ? lines.length * (lines[0]?.height ?? 0) : top, lines: out };
}

/** wrapParagraph over the character range [a0, b0) of `text`: returns line ranges [a, b). */
function wrapRange(a0, b0, text, widthOf, maxWidth) {
  if (!(maxWidth > 0) || widthOf(a0, b0) <= maxWidth) return [[a0, b0]];
  const lines = [];
  const trimEnd = ([a, b]) => {
    while (b > a && text[b - 1] === ' ') b--;
    return [a, b];
  };
  const pushWord = (a, b) => {
    // Hard-break a word that is wider than the box on its own.
    let rest = a;
    while (widthOf(rest, b) > maxWidth && b - rest > 1) {
      let k = 1;
      while (k < b - rest && widthOf(rest, rest + k + 1) <= maxWidth) k++;
      lines.push([rest, rest + k]);
      rest += k;
    }
    return rest;
  };
  let cur = null;
  for (let i = a0; i < b0; ) {
    const space = text[i] === ' ';
    let j = i + 1;
    while (j < b0 && (text[j] === ' ') === space) j++;
    if (space) {
      if (cur) cur[1] = j;
    } else if (!cur) cur = [pushWord(i, j), j];
    else if (widthOf(cur[0], j) <= maxWidth) cur[1] = j;
    else {
      lines.push(trimEnd(cur));
      cur = [pushWord(i, j), j];
    }
    i = j;
  }
  lines.push(cur ? trimEnd(cur) : [a0, a0]);
  return lines;
}

// ---------------------------------------------------------------- helpers

function num(v, d) {
  return Number.isFinite(v) ? v : d;
}

function dashArray(dash, width) {
  const s = Math.max(width, 1);
  if (!dash || dash === 'solid') return undefined;
  if (dash === 'dotted') return [s, 2 * s];
  if (dash === 'dashed') return [5 * s, 3 * s];
  throw new TypeError(`Unknown dash style "${dash}" (use solid, dotted or dashed)`);
}

function opacityOf(o, d = 1) {
  const v = num(o, d);
  return Math.min(1, Math.max(0, v));
}

const f = (n) => Number(n.toFixed(3));

function catmullRomPath(pts) {
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

function requireBox(o) {
  for (const k of ['x', 'y', 'w', 'h']) {
    if (!Number.isFinite(o[k])) throw new TypeError(`${o.type} object ${o.id ?? ''} needs numeric ${k}`);
  }
}

// ---------------------------------------------------------------- painter

/** Default colours of the note and text-markup types (shared with annots.js). */
export const DEFAULT_COLOR = { note: '#ffd400', underline: '#00a000', strikeout: '#e00000', squiggly: '#00a000', textHighlight: '#ffff00' };
const TEXT_MARKUPS = new Set(['underline', 'strikeout', 'squiggly', 'textHighlight']);
const r4 = (n) => Math.round(n * 1e4) / 1e4 + 0;

/**
 * Sticky-note icons (/Name of a /Text annotation): a filled body in the note colour plus a stroked glyph,
 * as SVG paths in a 20x20 y-down box using only absolute M/L/C/Z (so every point is an 'x y' pair).
 * The names are the ones the note tool offers (renderer/ui/tools-markup.js NOTE_ICONS); others draw as Comment.
 */
export const NOTE_ICON_PATHS = {
  Comment: { body: 'M 2 1 L 18 1 L 19 2 L 19 14 L 18 15 L 9 15 L 4 19 L 5 15 L 2 15 L 1 14 L 1 2 Z', glyph: 'M 4 5 L 16 5 M 4 8 L 16 8 M 4 11 L 16 11' },
  Note: { body: 'M 3 1 L 13 1 L 17 5 L 17 19 L 3 19 Z', glyph: 'M 13 1 L 13 5 L 17 5 M 6 9 L 14 9 M 6 12 L 14 12 M 6 15 L 11 15' },
  Key: { body: 'M 1 3 L 19 3 L 19 17 L 1 17 Z', glyph: 'M 4 10 C 4 6 10 6 10 10 C 10 14 4 14 4 10 Z M 10 10 L 17 10 M 14.5 10 L 14.5 13 M 17 10 L 17 12.5' },
  Help: { body: 'M 1 10 C 1 -2 19 -2 19 10 C 19 22 1 22 1 10 Z', glyph: 'M 7.5 7.5 C 7.5 4.5 12.5 4.5 12.5 7.5 C 12.5 9.5 10 9.5 10 12 M 10 14.5 L 10 15.5' },
  Paragraph: { body: 'M 1 1 L 19 1 L 19 19 L 1 19 Z', glyph: 'M 11 4 L 11 16 M 14 4 L 14 16 M 15.5 4 L 8.5 4 C 4.5 4 4.5 10 8.5 10 L 11 10' },
  Insert: { body: 'M 1 18 L 10 3 L 19 18 L 15 18 L 10 9.5 L 5 18 Z', glyph: '' },
};

/** Note icon / text markup (quads) in visible y-up space; `svg(d, opts)` draws a y-down path. */
function drawNoteOrMarkup(svg, o) {
  const color = parseColor(o.color, DEFAULT_COLOR[o.type]) || rgb(0, 0, 0);
  const opacity = Math.min(1, Math.max(0, num(o.opacity, 1)));
  const P = (x, y) => `${r4(x)} ${r4(y)}`;
  if (o.type === 'note') {
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) throw new TypeError(`note object ${o.id ?? ''} needs numeric x and y`);
    const sx = num(o.w, 20) / 20;
    const sy = num(o.h, 20) / 20;
    const icon = Object.hasOwn(NOTE_ICON_PATHS, o.icon) ? NOTE_ICON_PATHS[o.icon] : NOTE_ICON_PATHS.Comment;
    // Icon paths are in a 20x20 y-down box: 'P x y' points map to the note's box; other tokens pass through.
    const p = (x, y) => P(o.x + x * sx, o.y + y * sy);
    const map = (d) => d.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, x, y) => p(Number(x), Number(y)));
    const ink = rgb(0.2, 0.2, 0.2);
    svg(map(icon.body), { color, borderColor: ink, borderWidth: 0.75, opacity, borderOpacity: opacity });
    if (icon.glyph) svg(map(icon.glyph), { borderColor: ink, borderWidth: 1, borderOpacity: opacity });
    return;
  }
  if (!Array.isArray(o.quads) || !o.quads.length || o.quads.some((q) => !Array.isArray(q) || q.length !== 8 || !q.every(Number.isFinite))) {
    throw new TypeError(`${o.type} object ${o.id ?? ''} needs quads: [[x1,y1,...,x4,y4], ...]`);
  }
  for (const q of o.quads) {
    const [tlx, tly, trx, try_, blx, bly, brx, bry] = q;
    const hgt = Math.hypot(tlx - blx, tly - bly) || 1;
    const ux = (tlx - blx) / hgt; // unit vector from bottom edge toward top edge
    const uy = (tly - bly) / hgt;
    const t = num(o.strokeWidth, Math.max(0.5, hgt / 14));
    if (o.type === 'textHighlight') {
      svg(`M ${P(tlx, tly)} L ${P(trx, try_)} L ${P(brx, bry)} L ${P(blx, bly)} Z`, { color, opacity, blendMode: BlendMode.Multiply });
    } else if (o.type === 'underline') {
      svg(`M ${P(blx + (ux * t) / 2, bly + (uy * t) / 2)} L ${P(brx + (ux * t) / 2, bry + (uy * t) / 2)}`, { borderColor: color, borderWidth: t, borderOpacity: opacity });
    } else if (o.type === 'strikeout') {
      svg(`M ${P((tlx + blx) / 2, (tly + bly) / 2)} L ${P((trx + brx) / 2, (try_ + bry) / 2)}`, { borderColor: color, borderWidth: t, borderOpacity: opacity });
    } else {
      const len = Math.hypot(brx - blx, bry - bly) || 1;
      const vx = (brx - blx) / len;
      const vy = (bry - bly) / len;
      const step = hgt / 6;
      let d = '';
      for (let s = 0, i = 0; s <= len; s += step, i++) {
        const up = i % 2 ? step : 0;
        d += `${i ? 'L' : 'M'} ${P(blx + vx * s + ux * (up + t / 2), bly + vy * s + uy * (up + t / 2))} `;
      }
      svg(d, { borderColor: color, borderWidth: t, borderOpacity: opacity });
    }
  }
}

/**
 * Draws one page's objects. All pdf-lib draw calls receive "visible y-up"
 * coordinates; a single cm (visibleUpMatrix) maps them onto the page.
 */
class PagePainter {
  constructor(doc, page, fonts, images) {
    this.doc = doc;
    this.page = page;
    this.fonts = fonts;
    this.images = images;
    this.g = pageGeometry(page);
    this.vh = this.g.height;
  }

  begin() {
    this.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...visibleUpMatrix(this.g)));
  }

  end() {
    this.page.pushOperators(popGraphicsState());
  }

  uy(vy) {
    return this.vh - vy;
  }

  font(name) {
    let ft = this.fonts.get(name);
    if (!ft) {
      ft = this.doc.embedStandardFont(name);
      this.fonts.set(name, ft);
    }
    return ft;
  }

  /** Run `fn` with a local rotation (degrees clockwise on screen) about visible point (cx, cy). */
  rotated(cx, cy, deg, fn) {
    if (!deg) return fn();
    const r = (-deg * Math.PI) / 180; // clockwise on screen == negative in y-up space
    const c = Math.cos(r);
    const s = Math.sin(r);
    const ux = cx;
    const uy = this.uy(cy);
    // T(ux,uy) * R(r) * T(-ux,-uy)
    this.page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(c, s, -s, c, ux - c * ux + s * uy, uy - s * ux - c * uy),
    );
    fn();
    this.page.pushOperators(popGraphicsState());
  }

  svg(path, opts) {
    this.page.drawSvgPath(path, { x: 0, y: this.vh, ...opts });
  }

  rectShape(o, { stroke, fill, strokeWidth, opacity, dash, blendMode }) {
    const sw = stroke ? strokeWidth : 0;
    this.page.drawRectangle({
      x: o.x,
      y: this.uy(o.y + o.h),
      width: o.w,
      height: o.h,
      color: fill || undefined,
      borderColor: stroke || undefined,
      borderWidth: sw,
      borderDashArray: stroke ? dashArray(dash, sw) : undefined,
      opacity: fill ? opacity : undefined,
      borderOpacity: stroke ? opacity : undefined,
      blendMode,
    });
  }

  /**
   * One line of text at (x, y) (y-up) with the font's kerning applied as TJ adjustments, so its advance
   * equals font.widthOfTextAtSize (which includes the kerning pairs).
   */
  kernedText(str, { x, y, size, font, color, opacity }) {
    const m = metricsFor(font.name);
    const glyphs = m.encodeTextAsGlyphs(str);
    const parts = [];
    let piece = '';
    let i = 0;
    for (const ch of str) {
      piece += ch;
      const k = m.font.getXAxisKerningForPair(glyphs[i].name, glyphs[i + 1]?.name) || 0;
      i++;
      if (k && i < glyphs.length) {
        parts.push(font.encodeText(piece), -k); // TJ numbers are subtracted from the advance
        piece = '';
      }
    }
    if (piece) parts.push(font.encodeText(piece));
    const key = this.page.node.newFontDictionary(font.name, font.ref);
    const gs = opacity === undefined ? undefined : this.page.node.newExtGState('GS', this.doc.context.obj({ Type: 'ExtGState', ca: opacity }));
    this.page.pushOperators(
      ...[
        pushGraphicsState(),
        gs && setGraphicsState(gs),
        beginText(),
        setFillingColor(color),
        setFontAndSize(key, size),
        setTextMatrix(1, 0, 0, 1, x, y),
        PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [this.doc.context.obj(parts)]),
        endText(),
        popGraphicsState(),
      ].filter(Boolean),
    );
  }

  /** Draw the layoutRich fragments of `o` in `box`: per-fragment font, size, colour, underline / strike bars. */
  textBlock(o, box) {
    const L = layoutRich(o, box.w, box);
    const base = boxStyle(o);
    this.font(standardFontName(base.font, base.bold, base.italic)); // the box font, embedded even when nothing is drawn (as before runs)
    const colors = new Map();
    const colorOf = (c) => {
      if (!colors.has(c)) colors.set(c, parseColor(c, '#000000') || rgb(0, 0, 0));
      return colors.get(c);
    };
    colorOf(base.color);
    const opacity = opacityOf(o.opacity);
    // Fragments are measured with the fonts' kerning. With more than one style the fragments are drawn
    // kerned too (TJ), so each one ends where the next starts; a single-style box keeps its plain Tj
    // (output byte-identical to before runs).
    const frs = L.lines.flatMap((l) => l.fragments);
    const kerned = frs.some((f) => !sameRunStyle(f.style, frs[0].style));
    for (const line of L.lines) {
      for (const fr of line.fragments) {
        const s = fr.style;
        const color = colorOf(s.color);
        const font = this.font(standardFontName(s.font, s.bold, s.italic));
        if (kerned) this.kernedText(fr.text, { x: fr.x, y: this.uy(fr.baseline), size: s.fontSize, font, color, opacity });
        else this.page.drawText(fr.text, {
          x: fr.x,
          y: this.uy(fr.baseline),
          size: s.fontSize,
          font,
          color,
          opacity,
        });
        for (const d of fr.decorations) {
          this.page.drawRectangle({ x: fr.x, y: this.uy(d.y) - d.thickness / 2, width: fr.width, height: d.thickness, color, opacity });
        }
      }
    }
  }

  draw(o) {
    switch (o.type) {
      case 'text': {
        requireBox(o);
        this.textBlock(o, o);
        break;
      }
      case 'rect':
      case 'ellipse': {
        requireBox(o);
        const stroke = parseColor(o.stroke, '#000000');
        const fill = parseColor(o.fill, null);
        const strokeWidth = num(o.strokeWidth, 1);
        const opacity = opacityOf(o.opacity);
        if (o.type === 'rect') {
          this.rectShape(o, { stroke, fill, strokeWidth, opacity, dash: o.dash });
        } else {
          this.page.drawEllipse({
            x: o.x + o.w / 2,
            y: this.uy(o.y + o.h / 2),
            xScale: o.w / 2,
            yScale: o.h / 2,
            color: fill || undefined,
            borderColor: stroke || undefined,
            borderWidth: stroke ? strokeWidth : 0,
            borderDashArray: stroke ? dashArray(o.dash, strokeWidth) : undefined,
            opacity: fill ? opacity : undefined,
            borderOpacity: stroke ? opacity : undefined,
          });
        }
        break;
      }
      case 'cloud': {
        requireBox(o);
        const stroke = parseColor(o.stroke, '#000000');
        const fill = parseColor(o.fill, null);
        const sw = stroke ? num(o.strokeWidth, 1) : 0;
        const opacity = opacityOf(o.opacity);
        this.svg(cloudPath(o), {
          color: fill || undefined, opacity: fill ? opacity : undefined,
          borderColor: stroke || undefined, borderWidth: sw, borderOpacity: stroke ? opacity : undefined,
          borderDashArray: stroke ? dashArray(o.dash, sw) : undefined,
        });
        break;
      }
      case 'line':
      case 'arrow': {
        for (const k of ['x1', 'y1', 'x2', 'y2']) {
          if (!Number.isFinite(o[k])) throw new TypeError(`${o.type} object ${o.id ?? ''} needs numeric ${k}`);
        }
        const color = parseColor(o.stroke, '#000000') || rgb(0, 0, 0);
        const sw = num(o.strokeWidth, 1);
        const opacity = opacityOf(o.opacity);
        let { x2, y2 } = o;
        const dx = o.x2 - o.x1;
        const dy = o.y2 - o.y1;
        const len = Math.hypot(dx, dy);
        let head = null;
        if (o.type === 'arrow' && len > 0) {
          const hl = Math.min(num(o.headSize, Math.max(8, sw * 4)), len);
          const ux = dx / len;
          const uy = dy / len;
          const bx = o.x2 - ux * hl;
          const by = o.y2 - uy * hl;
          const hw = hl * 0.45;
          head = `M ${f(o.x2)} ${f(o.y2)} L ${f(bx - uy * hw)} ${f(by + ux * hw)} L ${f(bx + uy * hw)} ${f(by - ux * hw)} Z`;
          // stop the shaft inside the head so a thick line never pokes past the tip
          x2 = o.x2 - ux * hl * 0.5;
          y2 = o.y2 - uy * hl * 0.5;
        }
        this.page.drawLine({
          start: { x: o.x1, y: this.uy(o.y1) },
          end: { x: x2, y: this.uy(y2) },
          thickness: sw,
          color,
          opacity,
          dashArray: dashArray(o.dash, sw),
        });
        if (head) this.svg(head, { color, borderWidth: 0, opacity });
        break;
      }
      case 'polyline':
      case 'ink': {
        const pts = o.points;
        if (!Array.isArray(pts) || pts.length < 2) throw new TypeError(`${o.type} object ${o.id ?? ''} needs at least 2 points`);
        const path = o.smooth && pts.length > 2
          ? catmullRomPath(pts)
          : pts.map((p, i) => `${i ? 'L' : 'M'} ${f(p[0])} ${f(p[1])}`).join(' ');
        const sw = num(o.strokeWidth, 2);
        this.page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round));
        this.svg(path, {
          borderColor: parseColor(o.stroke, '#000000') || rgb(0, 0, 0),
          borderWidth: sw,
          borderDashArray: dashArray(o.dash, sw),
          borderLineCap: o.dash && o.dash !== 'solid' ? undefined : LineCapStyle.Round,
          borderOpacity: opacityOf(o.opacity),
        });
        this.page.pushOperators(popGraphicsState());
        break;
      }
      case 'highlight': {
        requireBox(o);
        this.rectShape(o, {
          fill: parseColor(o.color, '#ffff00') || rgb(1, 1, 0),
          stroke: null,
          strokeWidth: 0,
          opacity: o.apOpaque ? 1 : Math.min(opacityOf(o.opacity, 0.4), 0.5),
          blendMode: BlendMode.Multiply,
        });
        break;
      }
      case 'whiteout': {
        requireBox(o);
        this.rectShape(o, { fill: parseColor(o.color, '#ffffff') || rgb(1, 1, 1), stroke: null, strokeWidth: 0, opacity: 1 });
        break;
      }
      case 'image': {
        requireBox(o);
        const img = this.images(o);
        this.rotated(o.x + o.w / 2, o.y + o.h / 2, num(o.rotation, 0), () => {
          this.page.drawImage(img, { x: o.x, y: this.uy(o.y + o.h), width: o.w, height: o.h, opacity: opacityOf(o.opacity) });
        });
        break;
      }
      case 'apStamp': { // another app's stamp: its appearance (a one-page PDF, upright) scaled to the box
        requireBox(o);
        this.page.drawPage(this.images(o), { x: o.x, y: this.uy(o.y + o.h), width: o.w, height: o.h, opacity: opacityOf(o.opacity) });
        break;
      }
      case 'callout': {
        requireBox(o);
        const stroke = parseColor(o.stroke, '#ff0000');
        const fill = parseColor(o.fill, '#ffffff');
        const sw = num(o.strokeWidth, 1);
        if (Number.isFinite(o.tx) && Number.isFinite(o.ty)) {
          const sx = Math.min(Math.max(o.tx, o.x), o.x + o.w);
          const sy = Math.min(Math.max(o.ty, o.y), o.y + o.h);
          if (sx !== o.tx || sy !== o.ty) {
            const color = stroke || rgb(0, 0, 0);
            const head = calloutArrowHead(sx, sy, o.tx, o.ty, sw);
            this.page.drawLine({
              start: { x: sx, y: this.uy(sy) },
              end: { x: head.shaftEnd.x, y: this.uy(head.shaftEnd.y) },
              thickness: sw,
              color,
              dashArray: dashArray(o.dash, sw),
            });
            const { tip, left, right } = head;
            this.svg(`M ${f(tip.x)} ${f(tip.y)} L ${f(left.x)} ${f(left.y)} L ${f(right.x)} ${f(right.y)} Z`, { color, borderWidth: 0 });
          }
        }
        this.rectShape(o, { stroke, fill, strokeWidth: sw, opacity: opacityOf(o.opacity), dash: o.dash });
        const pad = num(o.padding, 4);
        this.textBlock(
          { ...o, color: o.color ?? o.stroke ?? '#000000', fontSize: num(o.fontSize, 10), opacity: 1 },
          { x: o.x + pad, y: o.y + pad, w: Math.max(1, o.w - 2 * pad), h: o.h - 2 * pad },
        );
        break;
      }
      case 'stamp': {
        requireBox(o);
        const color = parseColor(o.color, '#c00000') || rgb(0.75, 0, 0);
        const bw = num(o.borderWidth, 3);
        const text = sanitizeText(o.text ?? '').replace(/\n/g, ' ');
        const fontName = standardFontName('Helvetica', true, false);
        const font = this.font(fontName);
        const sub = sanitizeText(o.subtext ?? '').replace(/\n/g, ' ');
        const m = metricsFor(fontName);
        const capH = m.heightOfFontAtSize(1, { descender: false });
        const L = stampLayout({ ...o, borderWidth: bw, subtext: sub }, font.widthOfTextAtSize(text || ' ', 1), sub ? font.widthOfTextAtSize(sub, 1) : 0, capH);
        this.rotated(o.x + o.w / 2, o.y + o.h / 2, num(o.rotation, 0), () => {
          if (L.rings) {
            for (const r of L.rings) this.page.drawEllipse({ x: L.cx, y: this.uy(L.cy), xScale: Math.max(0, r.rx), yScale: Math.max(0, r.ry), borderColor: color, borderWidth: r.width, borderOpacity: opacityOf(o.opacity) });
          } else if (bw > 0 && L.corner) {
            const x0 = o.x + bw / 2, y0 = o.y + bw / 2, x1 = o.x + o.w - bw / 2, y1 = o.y + o.h - bw / 2;
            const r = Math.max(0, Math.min(L.corner, (x1 - x0) / 2, (y1 - y0) / 2));
            this.svg(`M ${f(x0 + r)} ${f(y0)} L ${f(x1 - r)} ${f(y0)} A ${f(r)} ${f(r)} 0 0 1 ${f(x1)} ${f(y0 + r)} L ${f(x1)} ${f(y1 - r)} A ${f(r)} ${f(r)} 0 0 1 ${f(x1 - r)} ${f(y1)} L ${f(x0 + r)} ${f(y1)} A ${f(r)} ${f(r)} 0 0 1 ${f(x0)} ${f(y1 - r)} L ${f(x0)} ${f(y0 + r)} A ${f(r)} ${f(r)} 0 0 1 ${f(x0 + r)} ${f(y0)} Z`,
              { borderColor: color, borderWidth: bw, borderOpacity: opacityOf(o.opacity) });
          } else if (bw > 0) {
            this.page.drawRectangle({
              x: o.x + bw / 2,
              y: this.uy(o.y + o.h - bw / 2),
              width: o.w - bw,
              height: o.h - bw,
              borderColor: color,
              borderWidth: bw,
              borderOpacity: opacityOf(o.opacity),
            });
          }
          const line = (t, size, base) => this.page.drawText(t, { x: o.x + (o.w - font.widthOfTextAtSize(t, size)) / 2, y: this.uy(base), size, font, color, opacity: opacityOf(o.opacity) });
          line(text, L.size, L.base);
          if (sub) line(sub, L.subSize, L.subBase);
        });
        break;
      }
      case 'note':
      case 'underline':
      case 'strikeout':
      case 'squiggly':
      case 'textHighlight':
        drawNoteOrMarkup((d, opts) => this.svg(d, opts), o);
        break;
      default:
        throw new TypeError(`Unknown overlay object type "${o.type}"`);
    }
  }
}

/** Every overlay object type flattenObjects (and so writeAnnotations' appearances) can draw. */
export const KNOWN_TYPES = new Set(['text', 'rect', 'ellipse', 'cloud', 'line', 'arrow', 'polyline', 'ink', 'highlight', 'whiteout', 'image', 'callout', 'stamp',
  'apStamp', 'note', ...TEXT_MARKUPS]);

/**
 * Burn overlay objects into the page content. Objects are drawn in array
 * order (z-order: later objects on top), after the page's existing content.
 * `opts.skipUnknown`: leave out objects of an unknown type with a console warning instead of
 * throwing (print and snapshot previews; saving keeps the error).
 */
export async function flattenObjects(pdfBytes, objects, { skipUnknown = false } = {}) {
  if (!Array.isArray(objects)) throw new TypeError('objects must be an array');
  const doc = await loadPdf(pdfBytes);
  const n = doc.getPageCount();
  if (skipUnknown) {
    objects = objects.filter((o) => {
      if (!o || typeof o !== 'object' || KNOWN_TYPES.has(o.type)) return true;
      console.warn(`flattenObjects: skipped overlay object ${o.id ?? ''} of unknown type "${o.type}"`);
      return false;
    });
  }
  for (const o of objects) {
    if (!o || typeof o !== 'object') throw new TypeError('Each overlay object must be an object');
    if (!KNOWN_TYPES.has(o.type)) throw new TypeError(`Unknown overlay object type "${o.type}"`);
    if (!Number.isInteger(o.page) || o.page < 0 || o.page >= n) {
      throw new RangeError(`Object ${o.id ?? ''} has page ${o.page}, document has ${n} pages`);
    }
  }
  const fonts = new Map();
  const embedded = new Map(); // image bytes -> PDFImage, embedded once per document
  const apPages = new ContentMap(); // apStamp appearance -> embedded page, one per distinct content (a seal on every page: one copy)
  for (const o of objects) {
    if (o.type === 'apStamp' && o.ap instanceof Uint8Array && !apPages.get(o.ap)) apPages.set(o.ap, (await doc.embedPdf(o.ap, [0]))[0]);
    if (o.type !== 'image') continue;
    if (!(o.bytes instanceof Uint8Array) && !(o.bytes instanceof ArrayBuffer)) {
      throw new TypeError(`image object ${o.id ?? ''} needs bytes`);
    }
    if (embedded.has(o.bytes)) continue;
    let img;
    try {
      if (o.mime === 'image/png') img = await doc.embedPng(o.bytes);
      else if (o.mime === 'image/jpeg') img = await doc.embedJpg(o.bytes);
      else throw new TypeError(`image object ${o.id ?? ''} has unsupported mime "${o.mime}"`);
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw coreError('INVALID_IMAGE', `Could not decode image for object ${o.id ?? ''}: ${e.message}`, e);
    }
    embedded.set(o.bytes, img);
  }
  const images = (o) => (o.type === 'apStamp' ? apPages.get(o.ap) : embedded.get(o.bytes));
  const byPage = new Map();
  for (const o of objects) {
    if (!byPage.has(o.page)) byPage.set(o.page, []);
    byPage.get(o.page).push(o);
  }
  for (const [pi, list] of byPage) {
    const painter = new PagePainter(doc, doc.getPage(pi), fonts, images);
    painter.begin();
    for (const o of list) painter.draw(o);
    painter.end();
  }
  return saveEdited(doc);
}
