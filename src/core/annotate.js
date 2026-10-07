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
  rgb,
} from 'pdf-lib';
import { loadPdf, saveEdited, pageGeometry, visibleUpMatrix, parseColor, coreError } from './internal.js';
import { calloutArrowHead } from './arrowhead.js';
import { stampLayout } from './stamps.js';
import { cloudPath } from './cloud.js';

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

/** Note icon / text markup (quads) in visible y-up space; `svg(d, opts)` draws a y-down path. */
function drawNoteOrMarkup(svg, o) {
  const color = parseColor(o.color, DEFAULT_COLOR[o.type]) || rgb(0, 0, 0);
  const opacity = Math.min(1, Math.max(0, num(o.opacity, 1)));
  const P = (x, y) => `${r4(x)} ${r4(y)}`;
  if (o.type === 'note') {
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) throw new TypeError(`note object ${o.id ?? ''} needs numeric x and y`);
    const sx = num(o.w, 20) / 20;
    const sy = num(o.h, 20) / 20;
    const p = (x, y) => P(o.x + x * sx, o.y + y * sy);
    svg(`M ${p(2, 1)} L ${p(18, 1)} L ${p(19, 2)} L ${p(19, 14)} L ${p(18, 15)} L ${p(9, 15)} L ${p(4, 19)} L ${p(5, 15)} L ${p(2, 15)} L ${p(1, 14)} L ${p(1, 2)} Z`,
      { color, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.75, opacity, borderOpacity: opacity });
    svg([5, 8, 11].map((y) => `M ${p(4, y)} L ${p(16, y)}`).join(' '), { borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1, borderOpacity: opacity });
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

  textBlock(o, box) {
    const fontSize = num(o.fontSize, 12);
    const name = standardFontName(o.font || 'Helvetica', !!o.bold, !!o.italic);
    const m = measureText(o.text, {
      font: o.font || 'Helvetica',
      bold: !!o.bold,
      italic: !!o.italic,
      fontSize,
      maxWidth: box.w,
      lineHeight: num(o.lineHeight, 1.2),
    });
    const font = this.font(name);
    const color = parseColor(o.color, '#000000') || rgb(0, 0, 0);
    const align = o.align || 'left';
    m.lines.forEach((line, i) => {
      if (line === '') return;
      const lw = font.widthOfTextAtSize(line, fontSize);
      let x = box.x;
      if (align === 'center') x = box.x + (box.w - lw) / 2;
      else if (align === 'right') x = box.x + box.w - lw;
      this.page.drawText(line, {
        x,
        y: this.uy(box.y + m.firstBaseline + i * m.lineHeight),
        size: fontSize,
        font,
        color,
        opacity: opacityOf(o.opacity),
      });
    });
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
          opacity: Math.min(opacityOf(o.opacity, 0.4), 0.5),
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
  'note', ...TEXT_MARKUPS]);

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
  for (const o of objects) {
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
  const images = (o) => embedded.get(o.bytes);
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
