// Real PDF annotations for ASH PDF Studio: overlay objects <-> /Annot dictionaries.
// Objects use VISIBLE page coordinates (see docs/CORE-API.md). Appearance streams are drawn with
// the same code as flattenObjects (annotate.js) on a scratch page, then copied in as Form XObjects.
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFString, PDFHexString, PDFStream,
  PDFRawStream, PDFObjectCopier, decodePDFRawStream, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from 'pdf-lib';
import { loadPdf, saveEdited, pageGeometry, pdfToVisible, visibleUpMatrix, parseColor, coreError, ContentMap, bytesKey } from './internal.js';
import { flattenObjects, layoutRich, standardFontName, textInset, DEFAULT_COLOR } from './annotate.js';
import { calloutArrowHead } from './arrowhead.js';
import { trailerSize } from './incremental.js';
import { cloudArc } from './cloud.js';
import { stampShape } from './stamps.js';
import { runsOf, normalizeRuns } from './richtext.js';
import { toRichContents, richFromRC } from './richxhtml.js';

const N = (s) => PDFName.of(s);
const r4 = (n) => Math.round(n * 1e4) / 1e4 + 0;
const num = (v, d) => (Number.isFinite(v) ? v : d);

const SUBTYPE = {
  rect: 'Square', cloud: 'Square', ellipse: 'Circle', line: 'Line', arrow: 'Line', ink: 'Ink', polyline: 'PolyLine',
  text: 'FreeText', callout: 'FreeText', stamp: 'Stamp', image: 'Stamp', apStamp: 'Stamp', highlight: 'Highlight',
  note: 'Text', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly', textHighlight: 'Highlight',
  redactMark: 'Redact', // a mark only (§12.5.6.23): the content goes when the app applies redaction
};
const MARKUP = new Set(['Square', 'Circle', 'Line', 'Ink', 'PolyLine', 'FreeText', 'Stamp', 'Highlight', 'Text', 'Underline', 'StrikeOut', 'Squiggly', 'Redact']);
const MARKUP_TYPE = { Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly' };
const STATUS = { accepted: 'Accepted', rejected: 'Rejected', cancelled: 'Cancelled', completed: 'Completed', none: 'None' };
const REDACT_STROKE = '#d62828';
const EXTRA_KEY = 'ASHStudio'; // private: JSON of style fields the standard keys cannot carry
const IMAGE_KEY = 'ASHImage'; // private: original image bytes of an image stamp

// ---------------------------------------------------------------- geometry

/** Visible point -> PDF user space. */
function visToPdf(g, x, y) {
  const [a, b, c, d, e, f] = visibleUpMatrix(g);
  const uy = g.height - y;
  return [a * x + c * uy + e, b * x + d * uy + f];
}

function bboxOf(pts) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function visRectToPdf(g, b) {
  return bboxOf([visToPdf(g, b.x, b.y), visToPdf(g, b.x + b.w, b.y), visToPdf(g, b.x, b.y + b.h), visToPdf(g, b.x + b.w, b.y + b.h)]);
}

function pdfRectToVis(g, r) {
  const pts = [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]].map(([X, Y]) => {
    const p = pdfToVisible(g, X, Y);
    return [p.x, p.y];
  });
  const [x1, y1, x2, y2] = bboxOf(pts);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** m1 after m2 (PDF matrices [a b c d e f]). */
function compose(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

const visPt = (g, X, Y) => {
  const p = pdfToVisible(g, X, Y);
  return [p.x, p.y];
};

/** Visible quads [x1,y1..x4,y4] (TL, TR, BL, BR as displayed) -> flat PDF /QuadPoints. */
function quadsToPdf(g, quads) {
  return quads.flatMap((q) => [0, 2, 4, 6].flatMap((i) => visToPdf(g, q[i], q[i + 1])));
}

function quadsToVisible(g, arr) {
  const out = [];
  for (let i = 0; i + 8 <= arr.length; i += 8) out.push([0, 2, 4, 6].flatMap((k) => visPt(g, arr[i + k], arr[i + k + 1])));
  return out;
}

function grow(b, m) {
  return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
}

function boxOfPoints(pts, m = 0) {
  const [x1, y1, x2, y2] = bboxOf(pts);
  return grow({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, m);
}

function union(a, b) {
  return boxOfPoints([[a.x, a.y], [a.x + a.w, a.y + a.h], [b.x, b.y], [b.x + b.w, b.y + b.h]]);
}

function rotatedBox(o) {
  const deg = num(o.rotation, 0);
  if (!deg) return { x: o.x, y: o.y, w: o.w, h: o.h };
  const t = (deg * Math.PI) / 180;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const pts = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
    const dx = (sx * o.w) / 2;
    const dy = (sy * o.h) / 2;
    return [cx + dx * Math.cos(t) - dy * Math.sin(t), cy + dx * Math.sin(t) + dy * Math.cos(t)];
  });
  return boxOfPoints(pts);
}

function quadBox(quads, m = 0) {
  return boxOfPoints(quads.flatMap((q) => [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]), m);
}

const hasStroke = (o, d) => parseColor(o.stroke, d) !== null;

/** Visible bounding box of the appearance, plus the inner box (for /RD) where relevant. */
function layout(o) {
  const sw = num(o.strokeWidth, o.type === 'ink' || o.type === 'polyline' ? 2 : 1);
  switch (o.type) {
    case 'rect':
    case 'ellipse':
      return { bbox: grow(o, hasStroke(o, '#000000') ? sw / 2 : 0) };
    case 'cloud': {
      const bbox = grow(o, hasStroke(o, '#000000') ? sw / 2 : 0);
      return { bbox, inner: grow(o, -cloudArc(o) / 2) }; // inner = the polygon the scallops sit on
    }
    case 'line':
    case 'arrow': {
      const pts = [[o.x1, o.y1], [o.x2, o.y2]];
      const hl = num(o.headSize, Math.max(8, sw * 4));
      return { bbox: boxOfPoints(pts, sw / 2 + (o.type === 'arrow' ? hl : 0) + 1) };
    }
    case 'ink':
    case 'polyline':
      return { bbox: boxOfPoints(inkPaths(o).flat(), sw / 2 + 2) };
    case 'text':
    case 'callout': {
      const pad = o.type === 'callout' ? num(o.padding, 4) : textInset(o);
      const m = layoutRich(o, Math.max(1, o.w - 2 * pad)); // runs-aware: mixed sizes change the height
      const inner = { x: o.x, y: o.y, w: o.w, h: o.h };
      let bbox = union(inner, { x: o.x, y: o.y, w: Math.max(o.w, m.width + 2 * pad), h: m.height + 2 * pad });
      if (o.type === 'callout') {
        bbox = grow(bbox, sw / 2);
        if (Number.isFinite(o.tx) && Number.isFinite(o.ty)) bbox = union(bbox, boxOfPoints([[o.tx, o.ty]], Math.max(6, sw * 4) + sw));
      }
      return { bbox, inner };
    }
    case 'stamp':
    case 'image':
    case 'highlight':
      return { bbox: rotatedBox(o) };
    case 'note':
      return { bbox: { x: o.x, y: o.y, w: num(o.w, 20), h: num(o.h, 20) } };
    case 'apStamp':
    case 'redactMark':
      return { bbox: { x: o.x, y: o.y, w: o.w, h: o.h } };
    default: // text markups
      return { bbox: quadBox(o.quads, 1) };
  }
}

function inkPaths(o) {
  return Array.isArray(o.paths) && o.paths.length ? o.paths : [o.points];
}

function shift(o, dx, dy) {
  const s = { ...o };
  for (const k of ['x', 'x1', 'x2', 'tx']) if (Number.isFinite(s[k])) s[k] += dx;
  for (const k of ['y', 'y1', 'y2', 'ty']) if (Number.isFinite(s[k])) s[k] += dy;
  if (Array.isArray(o.points)) s.points = o.points.map(([x, y]) => [x + dx, y + dy]);
  if (Array.isArray(o.paths)) s.paths = o.paths.map((p) => p.map(([x, y]) => [x + dx, y + dy]));
  if (Array.isArray(o.quads)) s.quads = o.quads.map((q) => q.map((v, i) => v + (i % 2 ? dy : dx)));
  return s;
}

// ---------------------------------------------------------------- appearance streams

function toFlattenObjects(o, page) {
  if (o.type === 'ink' || o.type === 'polyline') return inkPaths(o).map((points) => ({ ...o, page, type: 'ink', points, paths: undefined }));
  // Appearance of a redaction mark: its outline only (never a filled box: printing must not black out).
  if (o.type === 'redactMark') return [{ type: 'rect', page, x: o.x + 0.5, y: o.y + 0.5, w: Math.max(o.w - 1, 0), h: Math.max(o.h - 1, 0), stroke: REDACT_STROKE, strokeWidth: 1, fill: null }];
  return [{ ...o, page }];
}

function decodeContents(contents) {
  const list = contents instanceof PDFArray ? contents.asArray().map((r) => contents.context.lookup(r)) : [contents];
  const parts = list.map((s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getUnencodedContents()));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    out[at + p.length] = 10;
    at += p.length + 1;
  }
  return out;
}

/**
 * Build one Form XObject per item {o, bbox, g} in `doc`, drawn in the object's own visible
 * space (BBox [0 0 w h]) with /Matrix = the page rotation, so §12.5.5 maps it onto /Rect upright.
 */
async function buildAppearances(doc, items) {
  if (!items.length) return [];
  const tmp = await PDFDocument.create();
  const flat = [];
  items.forEach(({ o, bbox }, i) => {
    tmp.addPage([Math.max(bbox.w, 1), Math.max(bbox.h, 1)]);
    // drawn opaque: the annotation's /CA applies the opacity once (baking it in too made other viewers apply it twice)
    const so = { ...shift(o, -bbox.x, -bbox.y), opacity: 1, apOpaque: true };
    flat.push(...toFlattenObjects(so, i));
  });
  let bytes = await tmp.save();
  if (flat.length) bytes = await flattenObjects(bytes, flat);
  const src = await PDFDocument.load(bytes);
  const copier = PDFObjectCopier.for(src.context, doc.context);
  return items.map(({ bbox, g }, i) => {
    const { Contents, Resources } = src.getPage(i).node.normalizedEntries();
    const [a, b, c, d] = visibleUpMatrix(g);
    const form = doc.context.flateStream(Contents ? decodeContents(Contents) : new Uint8Array(), {
      Type: 'XObject', Subtype: 'Form', FormType: 1,
      BBox: [0, 0, r4(Math.max(bbox.w, 1)), r4(Math.max(bbox.h, 1))],
      Matrix: [a, b, c, d, 0, 0],
      Resources: Resources ? copier.copy(Resources) : doc.context.obj({}),
    });
    return doc.context.register(form);
  });
}

// ---------------------------------------------------------------- PDF value helpers

const text = (s) => PDFHexString.fromText(String(s ?? ''));
const pdfDate = (d) => PDFString.fromDate(d instanceof Date ? d : new Date(d));
const colorArr = (c) => (c ? [r4(c.red), r4(c.green), r4(c.blue)] : null);

function readText(dict, key) {
  const v = dict.lookup(N(key));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
}

function readDate(dict, key) {
  const v = dict.lookup(N(key));
  if (!(v instanceof PDFString || v instanceof PDFHexString)) return undefined;
  try {
    return v.decodeDate().toISOString();
  } catch {
    return undefined;
  }
}

const READ_ONLY = 64;
/** the annotation flags /F of an annotation dictionary (0 when absent or not a number) */
function annotFlags(dict) {
  const v = dict.lookup(PDFName.of('F'));
  return v instanceof PDFNumber ? v.asNumber() | 0 : 0;
}

function readNums(dict, key) {
  const v = dict.lookup(N(key));
  if (!(v instanceof PDFArray)) return undefined;
  return v.asArray().map((x) => dict.context.lookup(x)).map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN));
}

function nameOf(v) {
  return v instanceof PDFName ? v.decodeText() : undefined;
}

function hexColor(arr) {
  if (!arr || !arr.length) return null;
  let rgbv = arr;
  if (arr.length === 1) rgbv = [arr[0], arr[0], arr[0]];
  else if (arr.length === 4) rgbv = arr.slice(0, 3).map((c) => (1 - c) * (1 - arr[3]));
  return '#' + rgbv.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
}

function dashOf(o, sw) {
  const s = Math.max(sw, 1);
  if (o.dash === 'dotted') return [s, 2 * s];
  if (o.dash === 'dashed') return [5 * s, 3 * s];
  return null;
}

const refKey = (ref) => `${ref.objectNumber} ${ref.generationNumber}`;

// ---------------------------------------------------------------- object -> /Annot

function fontEntry(o, defSize) {
  const ps = standardFontName(o.font || 'Helvetica', !!o.bold, !!o.italic);
  const size = num(o.fontSize, defSize);
  const c = parseColor(o.type === 'callout' ? (o.color ?? o.stroke ?? '#000000') : o.color, '#000000') || rgb(0, 0, 0);
  const hex = hexColor(colorArr(c));
  // A text box's border colour: the stroking colour in /DA (Acrobat's FreeText convention).
  const border = o.type === 'text' && num(o.borderWidth, 0) > 0 ? parseColor(o.borderColor, '#000000') || rgb(0, 0, 0) : null;
  return {
    DA: PDFString.of(`/${ps} ${size} Tf ${colorArr(c).join(' ')} rg${border ? ` ${colorArr(border).join(' ')} RG` : ''}`),
    DS: PDFString.of(`font: ${size}pt ${o.font || 'Helvetica'}; color:${hex}`),
    Q: { left: 0, center: 1, right: 2 }[o.align || 'left'] ?? 0,
  };
}

/** Annotation dictionary entries specific to the object's type (geometry in PDF space). */
function typeEntries(o, g, lay) {
  const e = {};
  const extra = {};
  let strokeColor = null;
  let width = 0;
  const sw = num(o.strokeWidth, o.type === 'ink' || o.type === 'polyline' ? 2 : 1);
  const pick = (...keys) => keys.forEach((k) => o[k] !== undefined && (extra[k] = o[k]));
  switch (o.type) {
    case 'rect':
    case 'ellipse':
    case 'cloud':
      strokeColor = parseColor(o.stroke, '#000000');
      width = strokeColor ? sw : 0;
      if (parseColor(o.fill, null)) e.IC = colorArr(parseColor(o.fill, null));
      if (o.type === 'cloud') {
        e.BE = { S: N('C'), I: 1 }; // cloudy border effect (§12.5.4)
        const outer = visRectToPdf(g, lay.bbox), inner = visRectToPdf(g, lay.inner);
        e.RD = [inner[0] - outer[0], outer[3] - inner[3], outer[2] - inner[2], inner[1] - outer[1]].map(r4);
        extra.arcSize = cloudArc(o);
      }
      break;
    case 'line':
    case 'arrow':
      strokeColor = parseColor(o.stroke, '#000000') || rgb(0, 0, 0);
      width = sw;
      e.L = [...visToPdf(g, o.x1, o.y1), ...visToPdf(g, o.x2, o.y2)].map(r4);
      e.LE = [N('None'), N(o.type === 'arrow' ? 'ClosedArrow' : 'None')];
      if (o.type === 'arrow') e.IC = colorArr(strokeColor);
      pick('headSize');
      break;
    case 'ink':
    case 'polyline': {
      strokeColor = parseColor(o.stroke, '#000000') || rgb(0, 0, 0);
      width = sw;
      const paths = inkPaths(o).map((p) => p.flatMap(([x, y]) => visToPdf(g, x, y)).map(r4));
      if (o.type === 'ink') e.InkList = paths;
      else e.Vertices = paths[0];
      pick('smooth');
      break;
    }
    case 'text':
    case 'callout': {
      Object.assign(e, fontEntry(o, o.type === 'callout' ? 10 : 12));
      const outer = visRectToPdf(g, lay.bbox);
      const inner = visRectToPdf(g, lay.inner);
      e.RD = [inner[0] - outer[0], outer[3] - inner[3], outer[2] - inner[2], inner[1] - outer[1]].map(r4);
      pick('font', 'bold', 'italic', 'align', 'lineHeight', 'padding');
      if (o.underline) extra.underline = true;
      if (o.strike) extra.strike = true;
      const runs = normalizeRuns(runsOf(o), o);
      if (runs) extra.runs = runs; // exact round trip here; /RC for other programs
      if (runs || o.underline || o.strike) e.RC = text(toRichContents({ ...o, runs }));
      if (o.type === 'callout') {
        strokeColor = parseColor(o.stroke, '#ff0000');
        width = strokeColor ? sw : 0;
        const fill = parseColor(o.fill, '#ffffff');
        if (fill) e.IC = colorArr(fill);
        e.IT = N('FreeTextCallout');
        if (Number.isFinite(o.tx) && Number.isFinite(o.ty)) {
          const sx = Math.min(Math.max(o.tx, o.x), o.x + o.w);
          const sy = Math.min(Math.max(o.ty, o.y), o.y + o.h);
          e.CL = [...visToPdf(g, o.tx, o.ty), ...visToPdf(g, sx, sy)].map(r4);
          e.LE = N('ClosedArrow');
        }
        if (o.color !== undefined) extra.color = o.color;
      } else {
        // Text box frame. Standard keys for other viewers (Acrobat's FreeText convention): /C = the
        // background (fill) colour, /BS /W = the border width, the border colour = 'RG' in /DA
        // (fontEntry). /IC is not a FreeText key before PDF 2.0, so it is not used here (callouts keep
        // their own /C stroke + /IC fill). The inner margin has no standard key: /RD keeps marking the
        // bordered box (as for callouts), the padding travels in the private extra only.
        const bw = num(o.borderWidth, 0) > 0 ? o.borderWidth : 0;
        const fill = parseColor(o.fill, null);
        width = bw;
        if (fill) e.C = colorArr(fill);
        if (bw) Object.assign(extra, { borderWidth: bw, borderColor: o.borderColor ?? '#000000' });
        if (fill) extra.fill = o.fill;
      }
      break;
    }
    case 'stamp':
    case 'image':
      if (o.type === 'stamp') {
        strokeColor = parseColor(o.color, '#c00000');
        width = num(o.borderWidth, 3);
        e.Name = N(String(o.text ?? '').replace(/[^A-Za-z0-9]/g, '') || 'Draft');
        extra.text = o.text ?? '';
        if (o.subtext) extra.subtext = String(o.subtext);
        if (o.shape && o.shape !== 'rect') extra.shape = String(o.shape);
      } else {
        e.Name = N('Image');
        extra.kind = 'image';
      }
      if (num(o.rotation, 0)) Object.assign(extra, { rotation: o.rotation, w: o.w, h: o.h });
      break;
    case 'highlight':
    case 'textHighlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      strokeColor = parseColor(o.color, o.type === 'highlight' ? '#ffff00' : DEFAULT_COLOR[o.type]);
      const quads = o.type === 'highlight' ? [[o.x, o.y, o.x + o.w, o.y, o.x, o.y + o.h, o.x + o.w, o.y + o.h]] : o.quads;
      e.QuadPoints = quadsToPdf(g, quads).map(r4);
      if (o.type === 'highlight') extra.kind = 'highlight';
      if (o.type !== 'highlight' && o.type !== 'textHighlight') width = num(o.strokeWidth, 1);
      break;
    }
    case 'apStamp':
      e.Name = N(String(o.name || 'Stamp'));
      break;
    case 'redactMark': // /IC = the fill the applied area gets (none: left blank)
      strokeColor = parseColor(REDACT_STROKE, null);
      width = 1;
      if (o.fill !== null) e.IC = colorArr(parseColor(o.fill, '#000000'));
      break;
    case 'note':
      strokeColor = parseColor(o.color, DEFAULT_COLOR.note);
      e.Name = N(o.icon || 'Comment');
      e.Open = false;
      if (o.w !== undefined || o.h !== undefined) pick('w', 'h');
      break;
  }
  const bs = { Type: 'Border', W: r4(width), S: N(o.dash && o.dash !== 'solid' ? 'D' : 'S') };
  const dash = dashOf(o, width);
  if (dash && o.dash !== 'solid') bs.D = dash.map(r4);
  e.BS = bs;
  if (strokeColor) e.C = colorArr(strokeColor);
  return { entries: e, extra };
}

function validate(o, pageCount) {
  if (!o || typeof o !== 'object') throw new TypeError('Each overlay object must be an object');
  if (o.type === 'whiteout') {
    throw coreError('BURN_IN_ONLY', `whiteout object ${o.id ?? ''} cannot be an annotation; burn it in with flattenObjects`);
  }
  if (!SUBTYPE[o.type]) throw new TypeError(`Unknown overlay object type "${o.type}"`);
  if (typeof o.id !== 'string' || !o.id) throw new TypeError(`${o.type} object needs a string id`);
  if (!Number.isInteger(o.page) || o.page < 0 || o.page >= pageCount) {
    throw new RangeError(`Object ${o.id} has page ${o.page}, document has ${pageCount} pages`);
  }
  if (['underline', 'strikeout', 'squiggly', 'textHighlight'].includes(o.type)) {
    if (!Array.isArray(o.quads) || !o.quads.length || o.quads.some((q) => !Array.isArray(q) || q.length !== 8 || !q.every(Number.isFinite))) {
      throw new TypeError(`${o.type} object ${o.id} needs quads: [[x1,y1,...,x4,y4], ...]`);
    }
  } else if (o.type === 'note') {
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) throw new TypeError(`note object ${o.id} needs numeric x and y`);
  } else if (o.type === 'image' && !(o.bytes instanceof Uint8Array)) {
    throw new TypeError(`image object ${o.id} needs bytes`);
  } else if (o.type === 'apStamp' && !(o.ap instanceof Uint8Array)) {
    throw new TypeError(`apStamp object ${o.id} needs ap (its appearance as a one-page PDF)`);
  }
  const need = o.type === 'line' || o.type === 'arrow' ? ['x1', 'y1', 'x2', 'y2'] : ['ink', 'polyline', 'note'].includes(o.type) || o.quads ? [] : ['x', 'y', 'w', 'h'];
  for (const k of need) if (!Number.isFinite(o[k])) throw new TypeError(`${o.type} object ${o.id} needs numeric ${k}`);
  if ((o.type === 'ink' || o.type === 'polyline') && !inkPaths(o).every((p) => Array.isArray(p) && p.length >= 2)) {
    throw new TypeError(`${o.type} object ${o.id} needs at least 2 points`);
  }
}

// ---------------------------------------------------------------- scanning existing annotations

/** FNV-1a over a string, two seeds -> 16 hex digits (stable ids for direct dicts without /NM). */
function hash16(str) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * Every annotation of every page, classified. Each markup gets `deps` (the entries readAnnotations
 * represents on its object and update rewrites: popup, replies, latest Review state, their popups),
 * `replies` [{en, parent}] (parent = reply entry or null for the markup), `statusEn`, and `group`
 * (its /RT /Group members and their popups).
 */
function scan(doc) {
  const all = [];
  const byRef = new Map();
  const twins = new Map();
  doc.getPages().forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const ref = raw instanceof PDFRef ? raw : null;
      const dict = ref ? doc.context.lookup(ref) : raw;
      if (!(dict instanceof PDFDict)) continue;
      const irt = dict.get(N('IRT'));
      const en = {
        page: pi, index: i, ref, dict, subtype: nameOf(dict.lookup(N('Subtype'))), nm: readText(dict, 'NM'),
        irt: irt instanceof PDFRef ? irt : null, rt: nameOf(dict.lookup(N('RT'))) || 'R',
      };
      if (en.nm) en.id = en.nm;
      else if (ref) en.id = `ref-${ref.objectNumber}-${ref.generationNumber}`;
      else {
        // Direct dict without /NM: content-based id, unchanged by page moves or other removals.
        const key = [en.subtype, (readNums(dict, 'Rect') || []).join(' '), readText(dict, 'Contents') ?? '', refKey(page.ref)].join('|');
        const h = hash16(key);
        const n = (twins.get(h) ?? 0) + 1;
        twins.set(h, n);
        en.id = `d-${h}${n > 1 ? `-${n}` : ''}`;
      }
      all.push(en);
      if (ref) byRef.set(refKey(ref), en);
    }
  });
  for (const en of all) {
    if (en.irt) en.kind = en.rt === 'Group' ? 'group' : en.subtype === 'Text' ? 'reply' : 'xreply';
    // /F ReadOnly (64): the annotation must not interact with the user or be changed (PDF 32000 12.5.3). AutoCAD's
    // plotter writes one per SHX text string ("AutoCAD SHX Text": an invisible Square carrying the text for search);
    // left out of the editable overlay, they stay in the file untouched.
    else if (MARKUP.has(en.subtype) && (annotFlags(en.dict) & READ_ONLY)) en.kind = 'readonly';
    else if (MARKUP.has(en.subtype)) en.kind = 'markup';
    else en.kind = 'other';
  }
  const kids = new Map();
  const popups = new Map();
  for (const en of all) {
    if (en.irt) {
      const k = refKey(en.irt);
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(en);
    }
    if (en.subtype === 'Popup' && en.dict.get(N('Parent')) instanceof PDFRef) {
      const k = refKey(en.dict.get(N('Parent')));
      if (!popups.has(k)) popups.set(k, []);
      popups.get(k).push(en);
    }
  }
  const childrenOf = (en) => (en.ref ? kids.get(refKey(en.ref)) ?? [] : []);
  const popupsOf = (en) => {
    const out = en.ref ? [...(popups.get(refKey(en.ref)) ?? [])] : [];
    const p = en.dict.get(N('Popup'));
    const x = p instanceof PDFRef ? byRef.get(refKey(p)) : null;
    if (x && !out.includes(x)) out.push(x);
    return out;
  };
  const markups = all.filter((en) => en.kind === 'markup');
  for (const m of markups) {
    m.replies = [];
    m.statusEn = null;
    let statusDate = null;
    const seen = new Set([m]);
    for (let q = [m]; q.length;) {
      const node = q.shift();
      for (const c of childrenOf(node)) {
        if (c.kind !== 'reply' || seen.has(c)) continue;
        const state = readText(c.dict, 'State');
        if (state === undefined) {
          seen.add(c);
          m.replies.push({ en: c, parent: node === m ? null : node });
          q.push(c);
        } else if (node === m && (readText(c.dict, 'StateModel') || 'Review') === 'Review') {
          const date = readDate(c.dict, 'M') || '';
          if (statusDate === null || date >= statusDate) [m.statusEn, statusDate] = [c, date];
        }
      }
    }
    const own = [m, ...m.replies.map((r) => r.en), ...(m.statusEn ? [m.statusEn] : [])];
    m.deps = [...own.slice(1), ...own.flatMap(popupsOf)];
    m.group = [];
    for (let q = [m]; q.length;) {
      for (const c of childrenOf(q.shift())) {
        if (c.kind === 'group' && !m.group.includes(c)) {
          m.group.push(c, ...popupsOf(c));
          q.push(c);
        }
      }
    }
  }
  return { all, byRef, markups };
}

/** Current /Annots index of an entry (by identity, so earlier removals cannot make it stale). */
function annotIndex(doc, en) {
  const annots = doc.getPages()[en.page].node.Annots();
  for (let i = 0; annots && i < annots.size(); i++) {
    const v = annots.get(i);
    if (en.ref ? v instanceof PDFRef && refKey(v) === refKey(en.ref) : v === en.dict) return i;
  }
  return -1;
}

/**
 * Append to the page's /Annots. Not PDFPageLeaf.addAnnot: that normalizes the page (wraps its
 * content streams in q/Q, adds /Resources entries), a content change an incremental update must not carry.
 */
function addAnnot(doc, page, ref) {
  const annots = page.node.Annots();
  if (annots) annots.push(ref);
  else page.node.set(N('Annots'), doc.context.obj([ref]));
}

function dropFromAnnots(doc, entries) {
  const kill = new Set(entries);
  const pages = doc.getPages();
  const byPage = new Map();
  for (const en of kill) {
    if (!byPage.has(en.page)) byPage.set(en.page, []);
    byPage.get(en.page).push(en.index);
  }
  for (const [pi, idxs] of byPage) {
    const annots = pages[pi].node.Annots();
    for (const i of idxs.sort((a, b) => b - a)) annots.remove(i);
  }
}

/** Delete indirect objects no longer reachable from the trailer (removed annotations and their APs). */
function collectGarbage(doc) {
  const ctx = doc.context;
  const seen = new Set();
  const { Root, Info, Encrypt } = ctx.trailerInfo;
  const stack = [Root, Info, Encrypt].filter(Boolean);
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PDFRef) {
      if (seen.has(v.tag)) continue;
      seen.add(v.tag);
      const o = ctx.lookup(v);
      if (o) stack.push(o);
    } else if (v instanceof PDFDict) for (const [, x] of v.entries()) stack.push(x);
    else if (v instanceof PDFArray) stack.push(...v.asArray());
    else if (v instanceof PDFStream) stack.push(v.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

// ---------------------------------------------------------------- writeAnnotations

/**
 * Write overlay objects as real PDF annotations. `add`/`update` are overlay objects, `remove`
 * annotation ids. Annotations not mentioned are left exactly as they are.
 */
export async function writeAnnotations(pdfBytes, { add = [], update = [], remove = [] } = {}, { author, now } = {}) {
  for (const [k, v] of Object.entries({ add, update, remove })) if (!Array.isArray(v)) throw new TypeError(`${k} must be an array`);
  const doc = await loadPdf(pdfBytes);
  // New objects are numbered from the file's /Size: pdf-lib does not register object streams and
  // cross-reference streams, so its own count can hand out their numbers, and an incremental
  // update (appendIncrementalUpdate) would then replace them.
  const size = trailerSize(pdfBytes);
  if (size) doc.context.largestObjectNumber = Math.max(doc.context.largestObjectNumber, size - 1);
  const pages = doc.getPages();
  for (const o of [...add, ...update]) validate(o, pages.length);
  const stamp = now === undefined ? new Date() : new Date(now);
  let sc = scan(doc);
  const apForms = apStampForms(doc, sc); // before removals: a removed stamp's appearance can still be drawn by ref
  const find = (o) => {
    const ref = o?.source?.ref;
    const en = (ref && sc.markups.find((m) => m.ref && refKey(m.ref) === ref)) || sc.markups.find((m) => m.id === (typeof o === 'string' ? o : o.id));
    if (!en) throw coreError('ANNOT_NOT_FOUND', `No editable markup annotation with id "${typeof o === 'string' ? o : o.id}"`);
    return en;
  };
  const touched = remove.length > 0 || update.length > 0;

  // 1. removals: the annotation, what readAnnotations put on its object (deps) and its /RT /Group
  //    members (one unit, §12.5.6.2). Other annotations in reply to it are left as they are.
  if (remove.length) {
    const kill = new Set();
    for (const id of remove) {
      const en = find(id);
      for (const d of [en, ...en.deps, ...en.group]) kill.add(d);
    }
    dropFromAnnots(doc, [...kill]);
    sc = scan(doc);
  }

  // 2. updates: drop only the deps (popup, imported replies and status), keep the object number;
  //    group members and other replies stay (their /IRT is re-pointed below if it named a dropped dep)
  const targets = update.map((o) => {
    const en = find(o);
    return { o, en, created: readDate(en.dict, 'CreationDate'), dropped: new Map(), byId: new Map() };
  });
  if (targets.length) {
    for (const t of targets) for (const d of t.en.deps) if (d.ref) t.dropped.set(refKey(d.ref), d === t.en.statusEn ? `${t.o.id}-status` : d.id);
    dropFromAnnots(doc, targets.flatMap((t) => t.en.deps));
    sc = scan(doc);
    for (const t of targets) t.en = find(t.en.ref ? { source: { ref: refKey(t.en.ref) } } : t.en.id);
  }
  const existingIds = new Set(sc.markups.map((m) => m.id));
  for (const o of add) if (existingIds.has(o.id)) throw coreError('DUPLICATE_ID', `An annotation with id "${o.id}" already exists`);

  // 3. appearances for everything new
  const jobs = [...targets.map((t) => ({ o: t.o, t })), ...add.map((o) => ({ o }))];
  for (const j of jobs) {
    j.g = pageGeometry(pages[j.o.page]);
    j.lay = layout(j.o);
    j.bbox = j.lay.bbox;
  }
  // Another app's stamp keeps its own annotation and appearance while the page it is on is turned as when it
  // was read (move, resize, a move to a page turned the same: only /Rect and /P change, §12.5.5 scales /BBox
  // onto /Rect); otherwise (and for copies) it gets a form drawing its appearance upright, one per distinct appearance.
  for (const j of jobs) {
    if (j.o.type !== 'apStamp') continue;
    const en = j.t?.en;
    j.keep = !!(en && j.o.apRotate === j.g.rotation && pageGeometry(pages[en.page]).rotation === j.g.rotation && normalAppearance(doc, en.dict));
    if (!j.keep) j.form = await apForms(j.o, j.g);
  }
  const built = await buildAppearances(doc, jobs.filter((j) => j.o.type !== 'apStamp'));
  const aps = jobs.map((j) => (j.o.type === 'apStamp' ? j.form : built.shift()));
  let emptyAp = null;
  const emptyForm = () => (emptyAp ??= doc.context.register(doc.context.formXObject([], { BBox: [0, 0, 1, 1] })));

  jobs.forEach((j, k) => {
    const { o, g, lay } = j;
    const page = pages[o.page];
    const who = o.author ?? author ?? '';
    const { entries, extra } = typeEntries(o, g, lay);
    // Signature identity: the library item id and the block id, so Apply signature still works after reopening.
    for (const k of ['sig', 'group']) if (typeof o[k] === 'string' && o[k]) extra[k] = o[k];
    const contents = o.type === 'text' || o.type === 'callout' ? o.text : (o.note ?? (o.type === 'stamp' ? o.text : undefined));
    const opacity = o.type === 'highlight' ? Math.min(Math.max(num(o.opacity, 0.4), 0), 0.5) : Math.min(Math.max(num(o.opacity, 1), 0), 1);
    const rect = visRectToPdf(g, lay.bbox).map(r4);
    const dict = {
      Type: 'Annot', Subtype: SUBTYPE[o.type], Rect: rect, P: page.ref, NM: text(o.id), T: text(who),
      M: pdfDate(stamp), CreationDate: o.created ? pdfDate(o.created) : j.t?.created ? pdfDate(j.t.created) : pdfDate(stamp),
      F: 4, CA: r4(opacity), AP: { N: aps[k] }, ...entries,
    };
    if (contents !== undefined && contents !== null) dict.Contents = text(contents);
    if (Object.keys(extra).length) dict[EXTRA_KEY] = text(JSON.stringify(extra));
    if (o.type === 'image') dict[IMAGE_KEY] = doc.context.register(doc.context.stream(o.bytes, { Mime: PDFString.of(o.mime || 'image/png') }));
    let annot, popup = null;
    if (o.type === 'apStamp' && j.t) { // the other app's dictionary (/Name, /AS, private keys) with the new place and our fields
      annot = j.t.en.dict.clone(doc.context);
      if (!j.keep) {
        annot.set(N('AP'), doc.context.obj({ N: aps[k] }));
        annot.delete(N('AS'));
      }
      // Its popup (dropped from /Annots with the deps) goes back on the stamp's page.
      const p = annot.get(N('Popup'));
      const pd = p instanceof PDFRef ? doc.context.lookup(p) : null;
      if (pd instanceof PDFDict && nameOf(pd.lookup(N('Subtype'))) === 'Popup') {
        popup = p;
        pd.set(N('P'), page.ref);
      } else annot.delete(N('Popup'));
      if (contents === undefined || contents === null) annot.delete(N('Contents'));
      for (const k of ['Rect', 'P', 'NM', 'M', 'CA', 'Contents']) if (dict[k] !== undefined) annot.set(N(k), doc.context.obj(dict[k]));
      if (o.author !== undefined) annot.set(N('T'), doc.context.obj(dict.T)); // never the editor's name on another app's seal
    } else annot = doc.context.obj(dict);
    let ref;
    const en = j.t?.en;
    if (en && en.page === o.page && en.ref) {
      ref = en.ref;
      doc.context.assign(ref, annot);
    } else if (en && en.page === o.page) {
      ref = doc.context.register(annot);
      page.node.Annots().set(annotIndex(doc, en), ref);
    } else {
      if (en) pages[en.page].node.Annots().remove(annotIndex(doc, en));
      ref = en?.ref ?? doc.context.register(annot); // same object number on a page move: /IRT to it stays valid
      if (en?.ref) doc.context.assign(ref, annot);
      addAnnot(doc, page, ref);
    }
    if (j.t) j.t.ref = ref;
    const extras = [];
    if (popup) {
      doc.context.lookup(popup).set(N('Parent'), ref);
      extras.push(popup);
    }
    if (o.type === 'note') {
      const pv = { x: o.x + num(o.w, 20) + 4, y: o.y, w: 180, h: 120 };
      const popup = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Popup', Parent: ref, Rect: visRectToPdf(g, pv).map(r4), Open: false, F: 4, P: page.ref }));
      annot.set(N('Popup'), popup);
      extras.push(popup);
    }
    const reply = (fields) => doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Text', Rect: rect, P: page.ref, IRT: ref, F: 4, Name: 'Comment',
      AP: { N: emptyForm() }, ...(dict.C ? { C: dict.C } : {}), ...fields,
    }));
    const written = new Map();
    for (const r of o.replies ?? []) {
      const d = r.date ? new Date(r.date) : stamp;
      const rr = reply({ RT: 'R', NM: text(r.id), T: text(r.author ?? who), M: pdfDate(d), CreationDate: pdfDate(d), Contents: text(r.text) });
      written.set(r.id, rr);
      extras.push(rr);
    }
    for (const r of o.replies ?? []) { // nested threads: a reply to a reply keeps its /IRT to that reply
      const to = r.inReplyTo != null ? written.get(r.inReplyTo) : null;
      if (to && to !== written.get(r.id)) doc.context.lookup(written.get(r.id)).set(N('IRT'), to);
    }
    if (o.status !== undefined && o.status !== null) {
      const state = STATUS[o.status];
      if (!state) throw new TypeError(`Unknown status "${o.status}" (use ${Object.keys(STATUS).join(', ')})`);
      const sa = o.statusAuthor ?? who;
      const sr = reply({
        RT: 'R', NM: text(`${o.id}-status`), T: text(sa), M: pdfDate(stamp), CreationDate: pdfDate(stamp),
        Contents: text(`${state} set by ${sa}`), State: PDFString.of(state), StateModel: PDFString.of('Review'),
      });
      written.set(`${o.id}-status`, sr);
      extras.push(sr);
    }
    for (const x of extras) addAnnot(doc, page, x);
    if (j.t) j.t.byId = written;
  });

  // 4. annotations left in reply to a dropped dep (e.g. a Marked state on an imported reply) now
  //    point at its re-created copy (same id), else at the updated annotation
  for (const t of targets) {
    if (!t.dropped.size) continue;
    for (const en of scan(doc).all) {
      if (en.irt && t.dropped.has(refKey(en.irt))) en.dict.set(N('IRT'), t.byId.get(t.dropped.get(refKey(en.irt))) ?? t.ref);
    }
  }
  if (touched) collectGarbage(doc);
  return saveEdited(doc);
}

// ---------------------------------------------------------------- flattenAnnotations

const HIDDEN = 2 | 32; // /F Hidden | NoView: not displayed, so nothing to burn in

/** The normal appearance stream of an annotation as {ref, stream}, or null (none, or /AS names no state). */
function normalAppearance(doc, dict) {
  const ap = dict.lookup(N('AP'));
  if (!(ap instanceof PDFDict)) return null;
  let raw = ap.get(N('N'));
  let v = doc.context.lookup(raw);
  if (v instanceof PDFDict && !(v instanceof PDFStream)) {
    const as = nameOf(dict.lookup(N('AS')));
    if (!as) return null;
    raw = v.get(N(as));
    v = doc.context.lookup(raw);
  }
  if (!(v instanceof PDFStream)) return null;
  return { ref: raw instanceof PDFRef ? raw : doc.context.register(v), stream: v };
}

/**
 * PDF 32000 §12.5.5: the form's /BBox transformed by its /Matrix, mapped onto /Rect by matrix A.
 * Returns A, or null for a degenerate box.
 */
function appearanceMatrix(stream, rect) {
  const nums = (key) => {
    const v = stream.dict.lookup(N(key));
    return v instanceof PDFArray ? v.asArray().map((x) => stream.dict.context.lookup(x).asNumber()) : null;
  };
  const bb = nums('BBox');
  if (!bb || bb.length !== 4) return null;
  const [a, b, c, d, e, f] = nums('Matrix') || [1, 0, 0, 1, 0, 0];
  const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const [x1, y1, x2, y2] = bboxOf(pts);
  const R = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  const sx = (R[2] - R[0]) / (x2 - x1);
  const sy = (R[3] - R[1]) / (y2 - y1);
  return [sx, 0, 0, sy, R[0] - x1 * sx, R[1] - y1 * sy];
}

/**
 * How an appearance stream draws upright in its visible box: {M: form space -> [0 0 w h] (rounded), w, h}.
 * Depends only on the stream, the /Rect size and the page rotation (not where the stamp is), or null.
 */
function uprightAppearance(stream, rect, g) {
  const rw = Math.abs(rect[2] - rect[0]), rh = Math.abs(rect[3] - rect[1]);
  const A = appearanceMatrix(stream, [0, 0, rw, rh]);
  if (!A) return null;
  const [a, b, c, d] = invert(visibleUpMatrix(g));
  const [x1, y1, x2, y2] = bboxOf([[0, 0], [rw, 0], [0, rh], [rw, rh]].map(([x, y]) => [a * x + c * y, b * x + d * y]));
  if (!(x2 - x1 > 0 && y2 - y1 > 0)) return null;
  return { M: compose([1, 0, 0, 1, -x1, -y1], compose([a, b, c, d, 0, 0], A)).map(r4), w: x2 - x1, h: y2 - y1 };
}

/**
 * The normal appearance of a stamp from another app as a one-page PDF drawing it upright (as seen on
 * the page), page size = its visible box. Returns null without a usable appearance. `cache` (a Map, one
 * per document load) shares the result between stamps with an equal appearance stream, size and page
 * rotation: built once, one bytes object.
 */
function appearancePdf(doc, dict, g, cache) {
  const ap = normalAppearance(doc, dict);
  const rect = readNums(dict, 'Rect');
  if (!ap || !rect || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  // Apps often give each stamp its own stream with equal content (and the same image): keyed by content, sizes to 0.01 pt.
  const key = `${bytesKey(ap.stream.getContents())}|${ap.stream.dict}|${Math.abs(rect[2] - rect[0]).toFixed(2)}|${Math.abs(rect[3] - rect[1]).toFixed(2)}|${g.rotation}`;
  if (cache?.has(key)) return cache.get(key);
  const build = async () => {
    const U = uprightAppearance(ap.stream, rect, g);
    if (!U) return null;
    const out = await PDFDocument.create({ updateMetadata: false });
    const page = out.addPage([U.w, U.h]);
    const form = out.context.register(PDFObjectCopier.for(doc.context, out.context).copy(ap.stream));
    const name = page.node.newXObject('ASHAp', form);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...U.M), drawObject(name), popGraphicsState());
    return out.save({ useObjectStreams: false });
  };
  const p = build();
  cache?.set(key, p);
  return p;
}

/**
 * Forms for apStamps written into `doc` (scanned as `sc`): (o, g) -> a Form XObject ref drawing `o.ap`
 * upright on page geometry `g` (/Matrix = the page rotation; §12.5.5 maps it onto /Rect). One form per
 * distinct appearance and rotation, whatever the bytes objects. When a stamp in `doc` has that very
 * appearance (rebuilt from it byte for byte) the form draws its stream by reference; otherwise the
 * appearance PDF's content and resources are copied in once.
 */
function apStampForms(doc, sc) {
  const forms = new ContentMap();
  const copies = new ContentMap();
  const origins = new ContentMap(); // appearance PDF -> {stream ref, upright mapping} of a stamp in doc
  const built = new Map();
  let todo = null;
  const originOf = async (ap) => {
    todo ??= sc.all.filter((en) => en.subtype === 'Stamp');
    let hit = origins.get(ap);
    while (hit === undefined && todo.length) {
      const en = todo.shift();
      const g = pageGeometry(doc.getPages()[en.page]);
      const bytes = await appearancePdf(doc, en.dict, g, built);
      if (bytes && origins.get(bytes) === undefined) {
        const n = normalAppearance(doc, en.dict);
        origins.set(bytes, { ref: n.ref, U: uprightAppearance(n.stream, readNums(en.dict, 'Rect'), g) });
      }
      hit = origins.get(ap);
    }
    return hit ?? null;
  };
  const make = async (o, g) => {
    const [a, b, c, d] = visibleUpMatrix(g);
    const src = await originOf(o.ap);
    if (src) {
      return doc.context.register(doc.context.formXObject([pushGraphicsState(), concatTransformationMatrix(...src.U.M), drawObject('ASHAp'), popGraphicsState()], {
        BBox: [0, 0, r4(src.U.w), r4(src.U.h)], Matrix: [a, b, c, d, 0, 0], Resources: { XObject: { ASHAp: src.ref } },
      }));
    }
    let cp = copies.get(o.ap);
    if (!cp) {
      const pdf = await PDFDocument.load(o.ap);
      const pg = pdf.getPage(0);
      const { Contents, Resources } = pg.node.normalizedEntries();
      cp = copies.set(o.ap, {
        size: pg.getSize(), contents: Contents ? decodeContents(Contents) : new Uint8Array(),
        resources: Resources ? PDFObjectCopier.for(pdf.context, doc.context).copy(Resources) : doc.context.obj({}),
      });
    }
    return doc.context.register(doc.context.flateStream(cp.contents, {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, r4(cp.size.width), r4(cp.size.height)], Matrix: [a, b, c, d, 0, 0], Resources: cp.resources,
    }));
  };
  return (o, g) => {
    const rot = `|${g.rotation}`;
    return forms.get(o.ap, rot) ?? forms.set(o.ap, make(o, g), rot);
  };
}

/**
 * Burn markup annotations' normal appearances into the page content and remove them. Each one's
 * deps (popup, Text reply thread, Review state: not page content) go with it; its /RT /Group members
 * (one unit with it) are burned in too. Other replies stay. `pages` = page indices, `ids` =
 * annotation ids (as readAnnotations reports them); both default to everything. Widgets, Links and
 * other non-markup annotations are untouched.
 */
export async function flattenAnnotations(pdfBytes, { pages: pageSel, ids } = {}) {
  const doc = await loadPdf(pdfBytes);
  const pages = doc.getPages();
  const pageSet = pageSel ? new Set(pageSel) : null;
  const idSet = ids ? new Set(ids) : null;
  const sc = scan(doc);
  const targets = sc.markups.filter((en) => (!pageSet || pageSet.has(en.page)) && (!idSet || idSet.has(en.id)));
  if (!targets.length) return pdfBytes;
  const burn = new Set(targets.flatMap((en) => [en, ...en.group.filter((g) => g.kind === 'group')]));
  for (const en of sc.all.filter((x) => burn.has(x))) { // /Annots order: what is drawn later stays on top
    const flags = en.dict.lookup(N('F'));
    if (flags instanceof PDFNumber && flags.asNumber() & HIDDEN) continue;
    const ap = normalAppearance(doc, en.dict);
    const rect = readNums(en.dict, 'Rect');
    if (!ap || !rect || rect.length !== 4 || !rect.every(Number.isFinite)) continue;
    const A = appearanceMatrix(ap.stream, rect);
    if (!A) continue;
    const page = pages[en.page];
    const name = page.node.newXObject('ASHFlat', ap.ref);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...A.map(r4)), drawObject(name), popGraphicsState());
  }
  const kill = new Set(targets.flatMap((en) => [en, ...en.deps, ...en.group]));
  dropFromAnnots(doc, [...kill]);
  collectGarbage(doc);
  return saveEdited(doc);
}

// ---------------------------------------------------------------- readAnnotations

const FONT_ALIASES = { Helv: ['Helvetica', false, false], HeBo: ['Helvetica', true, false], TiRo: ['Times', false, false], TiBo: ['Times', true, false], TiIt: ['Times', false, true], Cour: ['Courier', false, false], CoBo: ['Courier', true, false] };
function fontFromName(name) {
  if (FONT_ALIASES[name]) return FONT_ALIASES[name];
  for (const font of ['Helvetica', 'Times', 'Courier']) {
    for (const bold of [false, true]) for (const italic of [false, true]) if (standardFontName(font, bold, italic) === name) return [font, bold, italic];
  }
  return null;
}

function parseDA(da) {
  const out = {};
  if (!da) return out;
  const tf = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da);
  if (tf) {
    out.fontName = tf[1];
    if (Number(tf[2]) > 0) out.fontSize = Number(tf[2]);
  }
  const c = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da) || /([\d.]+)\s+g\b/.exec(da);
  if (c) out.color = hexColor(c.slice(1).map(Number));
  const bc = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+RG/.exec(da);
  if (bc) out.borderColor = hexColor(bc.slice(1).map(Number));
  return out;
}

function borderWidth(dict, def = 1) {
  const bs = dict.lookup(N('BS'));
  if (bs instanceof PDFDict) {
    const w = bs.lookup(N('W'));
    return { width: w instanceof PDFNumber ? w.asNumber() : def, bs };
  }
  const border = readNums(dict, 'Border');
  return { width: border && border.length >= 3 ? border[2] : def, bs: null };
}

function dashFrom(bs) {
  if (!bs || nameOf(bs.lookup(N('S'))) !== 'D') return undefined;
  const d = readNums(bs, 'D') || [3];
  return d.length >= 2 && d[0] < d[1] ? 'dotted' : 'dashed';
}

const RC_FAMILY = { arial: 'Helvetica', 'sans-serif': 'Helvetica', 'times new roman': 'Times', serif: 'Times', 'courier new': 'Courier', monospace: 'Courier' };
const rcFamily = (name) => (['Helvetica', 'Times', 'Courier'].includes(name) ? name : fontFromName(name)?.[0] ?? RC_FAMILY[name.toLowerCase()]);

/** Runs / underline / strike of a FreeText: our own private copy when it still fits the text, else /RC. */
function richText(o, dict, extra) {
  if (Array.isArray(extra.runs) && extra.runs.map((r) => String(r?.text ?? '')).join('') === o.text) {
    if (extra.underline) o.underline = true;
    if (extra.strike) o.strike = true;
    const runs = normalizeRuns(extra.runs, o);
    if (runs) o.runs = runs;
    return;
  }
  const v = dict.lookup(N('RC'));
  const rc = v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : v instanceof PDFRawStream ? new TextDecoder().decode(decodePDFRawStream(v).decode()) : undefined;
  const got = rc ? richFromRC(rc, o, rcFamily) : null;
  if (!got) {
    if (extra.underline) o.underline = true;
    if (extra.strike) o.strike = true;
    return;
  }
  for (const [k, val] of Object.entries(got)) if (val !== undefined) o[k] = val;
  if (!o.underline) delete o.underline;
  if (!o.strike) delete o.strike;
}

/** One markup entry -> overlay object (throws on malformed dictionaries). */
function toObject(doc, en, g) {
  const { dict } = en;
  const rect = readNums(dict, 'Rect');
  if (!rect || rect.length !== 4 || !rect.every(Number.isFinite)) throw new Error('missing /Rect');
  const R = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  let extra = {};
  try {
    extra = JSON.parse(readText(dict, EXTRA_KEY) || '{}');
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) extra = {};
  } catch {
    extra = {};
  }
  const C = hexColor(readNums(dict, 'C'));
  const IC = hexColor(readNums(dict, 'IC'));
  const { width, bs } = borderWidth(dict);
  const dash = dashFrom(bs);
  const ca = dict.lookup(N('CA'));
  const o = { id: en.id, page: en.page };
  const contents = readText(dict, 'Contents');
  const inner = () => {
    const rd = readNums(dict, 'RD');
    if (!rd || rd.length !== 4) return R;
    return [R[0] + rd[0], R[1] + rd[3], R[2] - rd[2], R[3] - rd[1]];
  };
  switch (en.subtype) {
    case 'Square':
    case 'Circle': {
      o.type = en.subtype === 'Square' ? 'rect' : 'ellipse';
      const be = dict.lookup(N('BE'));
      if (o.type === 'rect' && be instanceof PDFDict && nameOf(be.lookup(N('S'))) === 'C') {
        const b = pdfRectToVis(g, inner());
        const arc = Number.isFinite(extra.arcSize) ? extra.arcSize : Math.min(b.w, b.h) > 0 ? Math.min(12, Math.min(b.w, b.h) / 2) : 12;
        Object.assign(o, { type: 'cloud', x: b.x - arc / 2, y: b.y - arc / 2, w: b.w + arc, h: b.h + arc, stroke: C, fill: IC, strokeWidth: width, arcSize: arc });
        break;
      }
      const b = pdfRectToVis(g, inner());
      const m = C ? width / 2 : 0;
      Object.assign(o, { x: b.x + m, y: b.y + m, w: b.w - 2 * m, h: b.h - 2 * m, stroke: C, fill: IC, strokeWidth: width });
      break;
    }
    case 'Line': {
      const L = readNums(dict, 'L');
      if (!L || L.length !== 4) throw new Error('missing /L');
      const le = dict.lookup(N('LE'));
      const ends = le instanceof PDFArray ? le.asArray().map((x) => nameOf(doc.context.lookup(x)) || 'None') : ['None', 'None'];
      const isArrow = (n) => /Arrow$/.test(n || '');
      let [p1, p2] = [visPt(g, L[0], L[1]), visPt(g, L[2], L[3])];
      if (!isArrow(ends[1]) && isArrow(ends[0])) [p1, p2] = [p2, p1];
      o.type = isArrow(ends[0]) || isArrow(ends[1]) ? 'arrow' : 'line';
      Object.assign(o, { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: C ?? '#000000', strokeWidth: width });
      if (extra.headSize !== undefined) o.headSize = extra.headSize;
      break;
    }
    case 'Ink':
    case 'PolyLine': {
      let paths;
      if (en.subtype === 'Ink') {
        const list = dict.lookup(N('InkList'));
        if (!(list instanceof PDFArray)) throw new Error('missing /InkList');
        paths = list.asArray().map((p) => doc.context.lookup(p)).filter((p) => p instanceof PDFArray)
          .map((p) => p.asArray().map((x) => doc.context.lookup(x).asNumber()));
      } else {
        paths = [readNums(dict, 'Vertices') || []];
      }
      paths = paths.map((p) => {
        const pts = [];
        for (let i = 0; i + 1 < p.length; i += 2) pts.push(visPt(g, p[i], p[i + 1]));
        return pts;
      }).filter((p) => p.length >= 2);
      if (!paths.length) throw new Error('no ink path');
      Object.assign(o, { type: en.subtype === 'Ink' ? 'ink' : 'polyline', points: paths[0], stroke: C ?? '#000000', strokeWidth: width });
      if (paths.length > 1) o.paths = paths;
      if (extra.smooth !== undefined) o.smooth = extra.smooth;
      break;
    }
    case 'FreeText': {
      const callout = nameOf(dict.lookup(N('IT'))) === 'FreeTextCallout' || dict.has(N('CL'));
      o.type = callout ? 'callout' : 'text';
      Object.assign(o, pdfRectToVis(g, inner()));
      o.text = contents ?? '';
      const da = parseDA(readText(dict, 'DA'));
      const font = da.fontName && fontFromName(da.fontName);
      if (font) [o.font, o.bold, o.italic] = font;
      for (const k of ['font', 'bold', 'italic', 'align', 'lineHeight', 'padding']) if (extra[k] !== undefined) o[k] = extra[k];
      const q = dict.lookup(N('Q'));
      if (q instanceof PDFNumber && o.align === undefined) o.align = ['left', 'center', 'right'][q.asNumber()] || 'left';
      if (da.fontSize) o.fontSize = da.fontSize;
      if (callout) {
        Object.assign(o, { stroke: C, fill: IC, strokeWidth: width });
        o.color = extra.color ?? da.color;
        const cl = readNums(dict, 'CL');
        if (cl && cl.length >= 4) [o.tx, o.ty] = visPt(g, cl[0], cl[1]);
      } else {
        if (da.color) o.color = da.color;
        // Frame: the private copy first, else the standard keys (a border only with its colour in /DA).
        const bw = extra.borderWidth ?? (bs && width > 0 && da.borderColor ? width : 0);
        if (bw > 0) Object.assign(o, { borderWidth: bw, borderColor: extra.borderColor ?? da.borderColor ?? '#000000' });
        const fill = extra.fill !== undefined ? extra.fill : C;
        if (fill) o.fill = fill;
      }
      richText(o, dict, extra);
      // A box taller than its text keeps that height as the user's minimum (see the editor's `minH`).
      const pad = callout ? num(o.padding, 4) : textInset(o);
      const fm = layoutRich({ ...o, font: o.font || 'Helvetica', fontSize: num(o.fontSize, callout ? 10 : 12), lineHeight: num(o.lineHeight, 1.2) }, Math.max(1, o.w - 2 * pad));
      const need = Math.max(fm.height, num(o.fontSize, callout ? 10 : 12) * num(o.lineHeight, 1.2)) + 2 * pad; // runs-aware; an empty box still has one line
      if (o.h > need + 0.5) o.minH = o.h;
      break;
    }
    case 'Stamp': {
      const b = pdfRectToVis(g, R);
      const rot = num(extra.rotation, 0);
      if (rot && Number.isFinite(extra.w) && Number.isFinite(extra.h)) {
        Object.assign(o, { x: b.x + b.w / 2 - extra.w / 2, y: b.y + b.h / 2 - extra.h / 2, w: extra.w, h: extra.h, rotation: rot });
      } else Object.assign(o, b);
      const img = dict.lookup(N(IMAGE_KEY));
      if (extra.text === undefined && extra.kind !== 'image' && normalAppearance(doc, dict)) {
        // Another app's stamp (seal, initials image, ...): shown and kept as its own appearance.
        Object.assign(o, b, { type: 'apStamp', name: nameOf(dict.lookup(N('Name'))) || 'Stamp', apRotate: g.rotation });
      } else if (extra.kind === 'image' && img instanceof PDFRawStream) {
        o.type = 'image';
        o.bytes = img.contents.slice();
        const mime = img.dict.lookup(N('Mime'));
        o.mime = mime instanceof PDFString ? mime.decodeText() : 'image/png';
      } else {
        o.type = 'stamp';
        o.text = extra.text ?? (nameOf(dict.lookup(N('Name'))) || 'Draft').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
        if (extra.subtext) o.subtext = extra.subtext;
        o.shape = stampShape(extra.shape);
        o.color = C;
        o.borderWidth = width;
      }
      break;
    }
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const qp = readNums(dict, 'QuadPoints');
      const quads = qp && qp.length >= 8 ? quadsToVisible(g, qp) : [];
      if (!quads.length) throw new Error('missing /QuadPoints');
      o.color = C;
      if (en.subtype === 'Highlight' && extra.kind === 'highlight') {
        Object.assign(o, { type: 'highlight' }, quadBox(quads));
      } else {
        o.type = MARKUP_TYPE[en.subtype] || 'textHighlight';
        o.quads = quads;
        if (o.type !== 'textHighlight') o.strokeWidth = width;
      }
      break;
    }
    case 'Redact': {
      const b = pdfRectToVis(g, R);
      Object.assign(o, { type: 'redactMark', x: b.x, y: b.y, w: b.w, h: b.h, fill: IC });
      break;
    }
    case 'Text': {
      const b = pdfRectToVis(g, R);
      Object.assign(o, { type: 'note', x: b.x, y: b.y, icon: nameOf(dict.lookup(N('Name'))) || 'Note', color: C });
      if (extra.w !== undefined) o.w = extra.w;
      if (extra.h !== undefined) o.h = extra.h;
      break;
    }
    default:
      throw new Error('unsupported subtype');
  }
  if (dash) o.dash = dash;
  for (const k of ['sig', 'group']) if (typeof extra[k] === 'string' && extra[k]) o[k] = extra[k];
  o.opacity = ca instanceof PDFNumber ? ca.asNumber() : 1;
  if (contents !== undefined && o.type !== 'text' && o.type !== 'callout' && !(o.type === 'stamp' && contents === o.text)) o.note = contents;
  const author = readText(dict, 'T');
  if (author !== undefined) o.author = author;
  const created = readDate(dict, 'CreationDate');
  const modified = readDate(dict, 'M');
  if (created) o.created = created;
  if (modified) o.modified = modified;
  o.source = { nm: en.nm ?? null, ref: en.ref ? refKey(en.ref) : null, subtype: en.subtype };
  return o;
}

/**
 * Read markup annotations as overlay objects; everything else is listed in `skipped`.
 * Replies and review state are grouped onto their parent object.
 */
export async function readAnnotations(pdfBytes) {
  const doc = await loadPdf(pdfBytes);
  const pages = doc.getPages();
  const sc = scan(doc);
  const objects = [];
  const skipped = [];
  const byEntry = new Map();
  const apCache = new Map(); // stamps sharing an appearance stream (a seal on every page): built once, one bytes object
  const skip = (en, reason) => skipped.push({ page: en.page, subtype: en.subtype ?? null, ref: en.ref ? refKey(en.ref) : null, id: en.id, reason });
  for (const en of sc.all) {
    if (en.kind === 'markup') {
      try {
        const g = pageGeometry(pages[en.page]);
        const o = toObject(doc, en, g);
        if (o.type === 'apStamp') {
          o.ap = await appearancePdf(doc, en.dict, g, apCache);
          if (!o.ap) throw new Error('unusable appearance');
        }
        objects.push(o);
        byEntry.set(en, o);
      } catch (e) {
        skip(en, `unreadable: ${e.message}`);
      }
    }
  }
  const shown = new Set();
  for (const [m, o] of byEntry) {
    for (const { en, parent } of m.replies) {
      const r = { id: en.id, author: readText(en.dict, 'T') ?? '', date: readDate(en.dict, 'M') ?? readDate(en.dict, 'CreationDate') ?? null, text: readText(en.dict, 'Contents') ?? '' };
      if (parent) r.inReplyTo = parent.id;
      (o.replies ??= []).push(r);
    }
    if (m.statusEn) o.status = readText(m.statusEn.dict, 'State').toLowerCase();
    o.source.deps = m.deps.filter((d) => d.ref).map((d) => refKey(d.ref));
    o.source.group = m.group.filter((d) => d.ref).map((d) => refKey(d.ref));
    m.deps.forEach((d) => shown.add(d));
  }
  for (const en of sc.all) {
    if (en.kind === 'markup' || shown.has(en)) continue;
    const reason = { readonly: 'read-only annotation (kept as it is in the file)', group: 'grouped annotation (RT /Group)', reply: 'reply not shown on its markup (state, or to an unsupported annotation)', xreply: 'reply that is not a Text annotation' }[en.kind];
    skip(en, reason ?? 'not a supported markup type');
  }
  return { objects, skipped };
}
