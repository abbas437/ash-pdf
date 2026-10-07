// Page marks for ASH PDF Studio: header & footer (page numbers), watermark, background and Bates numbering.
// Pure ES module (pdf-lib only). Every mark is its OWN content stream in the page /Contents array,
// wrapped in `/Artifact <<... /ASH_Mark (kind)>> BDC … EMC`, with its resources under page-unique
// `ASH_<code><n>_*` keys, so removeMarks drops exactly those streams and resources again.
// The page's existing content is bracketed by two tagged q / Q streams while any mark is present.
import { PDFName, PDFArray, PDFDict, PDFRef, PDFNumber, StandardFontEmbedder, StandardFonts } from 'pdf-lib';
import { loadPdf, saveEdited, pageGeometry, visibleUpMatrix, parseColor, coreError } from './internal.js';
import { standardFontName } from './annotate.js';
import { parseRanges } from './pdfOps.js';

export const MARK_KINDS = ['headerFooter', 'watermark', 'background', 'bates'];
const CODE = { headerFooter: 'hf', watermark: 'wm', background: 'bg', bates: 'bt' };
const KEY = PDFName.of('ASH_Mark'); // name on each of our stream dictionaries
const ORIG = PDFName.of('ASH_Orig'); // on the wrap-begin stream: how /Contents looked before
const WRAP_BEGIN = 'wrapBegin';
const WRAP_END = 'wrapEnd';
const SLOTS = ['left', 'center', 'right'];

// ---------------------------------------------------------------- text helpers
const winAnsi = StandardFontEmbedder.for(StandardFonts.Helvetica).encoding;

/** Refuse text the standard 14 fonts (WinAnsi) cannot show, instead of printing '?'. */
function assertEncodable(text, what) {
  for (const ch of text) {
    if (!winAnsi.canEncodeUnicodeCodePoint(ch.codePointAt(0))) {
      throw coreError('UNSUPPORTED_TEXT', `${what} contains "${ch}", which the standard PDF fonts cannot show. ` +
        'Only Latin (Western European) text is supported for now; Unicode text such as Arabic comes in a later version.');
    }
  }
}

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
/** Format a page number: '1' arabic, 'i'/'I' roman, 'a'/'A' letters (a..z, aa..zz, like PDF page labels). */
export function formatNumber(n, style = '1') {
  if (style === '1' || n < 1) return String(n);
  if (style === 'i' || style === 'I') {
    let s = '';
    for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; }
    return style === 'I' ? s.toUpperCase() : s;
  }
  if (style === 'a' || style === 'A') {
    const s = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
    return style === 'A' ? s.toUpperCase() : s;
  }
  throw new TypeError(`Unknown number format "${style}" (use 1, i, I, a or A)`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Date with YYYY, YY, MMM, MM, M, DD, D tokens. */
export function formatDate(d, fmt = 'YYYY-MM-DD') {
  const p2 = (x) => String(x).padStart(2, '0');
  const map = { YYYY: d.getFullYear(), YY: p2(d.getFullYear() % 100), MMM: MONTHS[d.getMonth()], MM: p2(d.getMonth() + 1), M: d.getMonth() + 1, DD: p2(d.getDate()), D: d.getDate() };
  return fmt.replace(/YYYY|YY|MMM|MM|M|DD|D/g, (t) => map[t]);
}

/** Replace <<page>>, <<pages>>, <<date>>, <<date:FMT>>, <<file>> in a slot template. */
export function expandTokens(tpl, { page, pages, date, fileName = '' }) {
  return String(tpl ?? '').replace(/<<(page|pages|file|date)(?::([^>]*))?>>/g, (_, t, fmt) => {
    if (t === 'page') return page;
    if (t === 'pages') return pages;
    if (t === 'file') return fileName;
    return formatDate(date, fmt || 'YYYY-MM-DD');
  });
}

// ---------------------------------------------------------------- options
function pageList(pages, n, subset = 'all') {
  let list;
  if (pages === undefined || pages === null || pages === 'all') list = Array.from({ length: n }, (_, i) => i);
  else if (typeof pages === 'string') list = parseRanges(pages, n);
  else if (Array.isArray(pages)) {
    for (const i of pages) if (!Number.isInteger(i) || i < 0 || i >= n) throw new RangeError(`Page index ${i} out of range (0..${n - 1})`);
    list = [...new Set(pages)].sort((a, b) => a - b);
  } else throw new TypeError('pages must be an array of 0-based indices or a range string like "1-3,5"');
  if (subset === 'even') return { range: list, list: list.filter((i) => (i + 1) % 2 === 0) };
  if (subset === 'odd') return { range: list, list: list.filter((i) => (i + 1) % 2 === 1) };
  if (subset !== 'all') throw new TypeError(`subset must be 'all', 'even' or 'odd'`);
  return { range: list, list };
}

function fontOpts(o, defSize) {
  const size = o.fontSize ?? defSize;
  if (!(size > 0)) throw new RangeError('fontSize must be > 0');
  const color = parseColor(o.color ?? '#000000');
  if (!color) throw new TypeError('color is required');
  return { name: standardFontName(o.font ?? 'Helvetica', !!o.bold), size, color };
}

function opacityOf(v) {
  const a = v ?? 1;
  if (!(a >= 0 && a <= 1)) throw new RangeError('opacity must be between 0 and 1');
  return a;
}

const fmt = (x) => (Math.abs(x) < 1e-9 ? '0' : Number(x.toFixed(4)).toString());

// ---------------------------------------------------------------- content streams + resources
function contentsRefs(doc, page) {
  const raw = page.node.get(PDFName.Contents);
  if (!raw) return { refs: [], form: 'None' };
  const v = doc.context.lookup(raw);
  if (v instanceof PDFArray) return { refs: v.asArray(), form: 'Array' };
  return { refs: [raw], form: 'Single' };
}
const tagOf = (doc, ref) => {
  const s = doc.context.lookup(ref);
  const t = s?.dict?.get?.(KEY);
  return t instanceof PDFName ? t.decodeText() : null;
};

function ownResources(doc, page) {
  const node = page.node;
  let res = node.get(PDFName.Resources);
  if (!res) {
    const inherited = doc.context.lookupMaybe(node.getInheritableAttribute(PDFName.Resources), PDFDict);
    res = inherited ? inherited.clone(doc.context) : doc.context.obj({});
    node.set(PDFName.Resources, res);
  }
  return doc.context.lookup(res, PDFDict);
}
function subDict(doc, res, name) {
  let d = res.lookupMaybe(PDFName.of(name), PDFDict);
  if (!d) { d = doc.context.obj({}); res.set(PDFName.of(name), d); }
  return d;
}

/** Next unused `ASH_<code><n>_` prefix over the whole document. */
function nextPrefix(doc, code) {
  let max = 0;
  const re = new RegExp(`^ASH_${code}(\\d+)_`);
  for (const page of doc.getPages()) {
    const res = doc.context.lookupMaybe(page.node.Resources?.() ?? undefined, PDFDict);
    if (!res) continue;
    for (const sub of ['Font', 'XObject', 'ExtGState']) {
      const d = res.lookupMaybe(PDFName.of(sub), PDFDict);
      for (const k of d?.keys() ?? []) { const m = re.exec(k.decodeText()); if (m) max = Math.max(max, Number(m[1])); }
    }
  }
  return `ASH_${code}${max + 1}_`;
}

function tagged(doc, tag, content, extra = {}) {
  const dict = { [KEY.decodeText()]: tag, ...extra };
  return doc.context.register(doc.context.flateStream(content, dict));
}

/**
 * Insert a mark stream into the page. layer: 'over' (appended), 'behind' (just before the
 * wrapped page content), 'bottom' (first of all: backgrounds sit under behind-watermarks).
 * The original content is wrapped in tagged q/Q streams once.
 */
function insertStream(doc, page, ref, layer) {
  let { refs, form } = contentsRefs(doc, page);
  if (!refs.some((r) => tagOf(doc, r) === WRAP_BEGIN)) {
    const begin = tagged(doc, WRAP_BEGIN, 'q\n', { [ORIG.decodeText()]: PDFName.of(form) });
    const end = tagged(doc, WRAP_END, 'Q\n');
    refs = [begin, ...refs, end];
  }
  refs = [...refs];
  if (layer === 'over') refs.push(ref);
  else if (layer === 'bottom') refs.unshift(ref);
  else refs.splice(refs.findIndex((r) => tagOf(doc, r) === WRAP_BEGIN), 0, ref);
  page.node.set(PDFName.Contents, doc.context.obj(refs));
}

function artifact(kind, subtype, body) {
  return `/Artifact <</Type /Pagination /Subtype /${subtype} /ASH_Mark (${kind})>> BDC\n${body}EMC\n`;
}

/** Shared per-call font registry: one font object per standard font, a page-local key each. */
function fontKeyFor(doc, state, res, prefix, fontName) {
  if (!state.fonts.has(fontName)) state.fonts.set(fontName, doc.embedStandardFont(fontName));
  const font = state.fonts.get(fontName);
  const key = `${prefix}F${[...state.fonts.keys()].indexOf(fontName)}`;
  subDict(doc, res, 'Font').set(PDFName.of(key), font.ref);
  return { font, key };
}

function textOp(font, key, size, color, text, x, y) {
  return `BT /${key} ${fmt(size)} Tf ${fmt(color.red)} ${fmt(color.green)} ${fmt(color.blue)} rg ${fmt(x)} ${fmt(y)} Td ${font.encodeText(text).toString()} Tj ET\n`;
}

/** Visible frame of a page: size after /Rotate and the matrix from visible y-up space to PDF space. */
function frame(page) {
  const g = pageGeometry(page);
  return { W: g.width, H: g.height, cm: `${visibleUpMatrix(g).map(fmt).join(' ')} cm\n` };
}

function ascentDescent(fontName, size) {
  const m = StandardFontEmbedder.for(fontName);
  const ascent = m.heightOfFontAtSize(size, { descender: false });
  return { ascent, descent: m.heightOfFontAtSize(size) - ascent };
}

async function finish(doc) { return saveEdited(doc); }

function stripKind(doc, kinds) {
  const removedObjs = new Set();
  for (const page of doc.getPages()) {
    const { refs } = contentsRefs(doc, page);
    if (!refs.some((r) => tagOf(doc, r))) continue;
    const keep = refs.filter((r) => {
      const t = tagOf(doc, r);
      if (t && kinds.includes(t)) { removedObjs.add(r); return false; }
      return true;
    });
    const marksLeft = keep.some((r) => MARK_KINDS.includes(tagOf(doc, r)));
    if (!marksLeft) {
      const begin = keep.find((r) => tagOf(doc, r) === WRAP_BEGIN);
      const form = begin ? doc.context.lookup(begin).dict.get(ORIG)?.decodeText() : 'Array';
      const orig = keep.filter((r) => { const t = tagOf(doc, r); if (t === WRAP_BEGIN || t === WRAP_END) { removedObjs.add(r); return false; } return true; });
      if (form === 'None' && orig.length === 0) page.node.delete(PDFName.Contents);
      else if (form === 'Single' && orig.length === 1) page.node.set(PDFName.Contents, orig[0]);
      else page.node.set(PDFName.Contents, doc.context.obj(orig));
    } else page.node.set(PDFName.Contents, doc.context.obj(keep));
    const res = doc.context.lookupMaybe(page.node.get(PDFName.Resources), PDFDict);
    if (!res) continue;
    const re = new RegExp(`^ASH_(${kinds.map((k) => CODE[k]).join('|')})\\d+_`);
    for (const sub of ['Font', 'XObject', 'ExtGState']) {
      const d = res.lookupMaybe(PDFName.of(sub), PDFDict);
      if (!d) continue;
      for (const k of d.keys()) {
        if (!re.test(k.decodeText())) continue;
        const v = d.get(k);
        if (v instanceof PDFRef) removedObjs.add(v);
        d.delete(k);
      }
      if (d.keys().length === 0) res.delete(PDFName.of(sub));
    }
  }
  for (const r of removedObjs) {
    const smask = doc.context.lookup(r)?.dict?.get?.(PDFName.of('SMask')); // PNG alpha channel
    if (smask instanceof PDFRef) doc.context.delete(smask);
    doc.context.delete(r);
  }
}

function kindsArg(kind) {
  const kinds = kind === undefined || kind === 'all' ? MARK_KINDS : Array.isArray(kind) ? kind : [kind];
  for (const k of kinds) if (!MARK_KINDS.includes(k)) throw new TypeError(`Unknown mark kind "${k}" (use ${MARK_KINDS.join(', ')})`);
  return kinds;
}

// ---------------------------------------------------------------- public API
/** Remove every mark of `kind` ('headerFooter' | 'watermark' | 'background' | 'bates', an array of them, or 'all'). */
export async function removeMarks(bytes, kind = 'all') {
  const kinds = kindsArg(kind);
  const doc = await loadPdf(bytes);
  stripKind(doc, kinds);
  return finish(doc);
}

/** [{kind, pages: number[]}] for every mark kind present in the document. */
export async function listMarks(bytes) {
  const doc = await loadPdf(bytes);
  const found = new Map();
  doc.getPages().forEach((page, i) => {
    for (const r of contentsRefs(doc, page).refs) {
      const t = tagOf(doc, r);
      if (!MARK_KINDS.includes(t)) continue;
      if (!found.has(t)) found.set(t, new Set());
      found.get(t).add(i);
    }
  });
  return MARK_KINDS.filter((k) => found.has(k)).map((kind) => ({ kind, pages: [...found.get(kind)].sort((a, b) => a - b) }));
}

async function begin(bytes, kind, opts) {
  const doc = await loadPdf(bytes);
  if (opts.replace) stripKind(doc, [kind]);
  return doc;
}

/** Lay out the six header/footer slots (or the one Bates slot) of one page as content operators. */
function slotText(doc, state, page, prefix, slots, fo, margins) {
  const { W, H, cm } = frame(page);
  const res = ownResources(doc, page);
  const { font, key } = fontKeyFor(doc, state, res, prefix, fo.name);
  const { ascent, descent } = ascentDescent(fo.name, fo.size);
  const out = {};
  for (const band of ['header', 'footer']) {
    let ops = '';
    for (const slot of SLOTS) {
      const text = slots[band]?.[slot];
      if (!text) continue;
      const w = font.widthOfTextAtSize(text, fo.size);
      const x = slot === 'left' ? margins.left : slot === 'right' ? W - margins.right - w : (W - w) / 2;
      const y = band === 'header' ? H - margins.top - ascent : margins.bottom - descent;
      ops += textOp(font, key, fo.size, fo.color, text, x, y);
    }
    if (ops) out[band] = `q\n${cm}${ops}Q\n`;
  }
  return out;
}

function marginsOf(m = {}) {
  const r = { top: 36, bottom: 36, left: 54, right: 54, ...m };
  for (const k of ['top', 'bottom', 'left', 'right']) if (!(r[k] >= 0)) throw new RangeError(`margin ${k} must be >= 0`);
  return r;
}

/**
 * Header & footer. opts: {header: {left, center, right}, footer: {...}, startNumber=1, numberFormat='1',
 * font, bold, fontSize=10, color, margins: {top,bottom,left,right} (pt), pages, subset, date, fileName, replace}.
 */
export async function addHeaderFooter(bytes, opts = {}) {
  const kind = 'headerFooter';
  for (const band of ['header', 'footer']) for (const s of SLOTS) if (opts[band]?.[s]) assertEncodable(String(opts[band][s]), `The ${band} ${s} text`);
  if (opts.fileName) assertEncodable(String(opts.fileName), 'The file name');
  const fo = fontOpts(opts, 10);
  const margins = marginsOf(opts.margins);
  const start = opts.startNumber ?? 1;
  if (!Number.isInteger(start) || start < 0) throw new RangeError('startNumber must be an integer >= 0');
  formatNumber(1, opts.numberFormat ?? '1');
  const doc = await begin(bytes, kind, opts);
  const { range, list } = pageList(opts.pages, doc.getPageCount(), opts.subset);
  if (!list.length) throw new RangeError('No pages match the page range and even/odd selection');
  const prefix = nextPrefix(doc, CODE[kind]);
  const state = { fonts: new Map() };
  const first = range[0];
  const pages = formatNumber(start + (range[range.length - 1] - first), opts.numberFormat);
  const date = opts.date ?? new Date();
  for (const i of list) {
    const ctx = { page: formatNumber(start + (i - first), opts.numberFormat), pages, date, fileName: opts.fileName };
    const slots = {};
    for (const band of ['header', 'footer']) {
      slots[band] = {};
      for (const s of SLOTS) slots[band][s] = expandTokens(opts[band]?.[s], ctx);
    }
    const page = doc.getPage(i);
    const t = slotText(doc, state, page, prefix, slots, fo, margins);
    const body = (t.header ? artifact(kind, 'Header', t.header) : '') + (t.footer ? artifact(kind, 'Footer', t.footer) : '');
    if (body) insertStream(doc, page, tagged(doc, kind, body), 'over');
  }
  return finish(doc);
}

const POSITIONS = ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];

/** Embed PNG or JPEG bytes (detected from the signature). */
async function embedImage(doc, bytes) {
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new TypeError('image must be PNG or JPEG bytes');
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return doc.embedPng(u);
  if (u[0] === 0xff && u[1] === 0xd8) return doc.embedJpg(u);
  throw coreError('UNSUPPORTED_IMAGE', 'The image must be a PNG or JPEG file.');
}

function opacityGs(doc, res, name, opacity) {
  subDict(doc, res, 'ExtGState').set(PDFName.of(name), doc.context.obj({ Type: 'ExtGState', ca: PDFNumber.of(opacity), CA: PDFNumber.of(opacity) }));
}

/**
 * Watermark: text or image. opts: {text | image (PNG/JPEG bytes), font, bold, fontSize=48,
 * scale (fraction of the page width the text/image spans; default 0.5 for images, fontSize for text),
 * color='#ff0000', opacity=0.3, rotation=45 (degrees anticlockwise), position='center' | 9-point grid,
 * tile=false, tileGap=72, margin=36, layer='over'|'behind', pages, subset, replace}.
 */
export async function addWatermark(bytes, opts = {}) {
  const kind = 'watermark';
  const hasImage = opts.image !== undefined && opts.image !== null;
  const text = String(opts.text ?? '');
  if (!hasImage) {
    if (!text.trim()) throw new TypeError('Watermark text or image is required');
    assertEncodable(text, 'The watermark text');
  }
  const fo = fontOpts({ color: '#ff0000', ...opts }, 48);
  const opacity = opacityOf(opts.opacity ?? 0.3);
  const position = opts.position ?? 'center';
  if (!POSITIONS.includes(position)) throw new TypeError(`position must be one of ${POSITIONS.join(', ')}`);
  const layer = opts.layer ?? 'over';
  if (layer !== 'over' && layer !== 'behind') throw new TypeError("layer must be 'over' or 'behind'");
  if (opts.scale !== undefined && !(opts.scale > 0 && opts.scale <= 2)) throw new RangeError('scale must be in (0, 2]');
  const deg = Number(opts.rotation ?? 45);
  const margin = opts.margin ?? 36, gap = opts.tileGap ?? 72;
  const doc = await begin(bytes, kind, opts);
  const { list } = pageList(opts.pages, doc.getPageCount(), opts.subset);
  const prefix = nextPrefix(doc, CODE[kind]);
  const state = { fonts: new Map() };
  const image = hasImage ? await embedImage(doc, opts.image) : null;
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  for (const i of list) {
    const page = doc.getPage(i);
    const { W, H, cm } = frame(page);
    const res = ownResources(doc, page);
    let tw, th, draw; // unrotated box size, and the operators drawing it centred on the origin
    if (image) {
      tw = W * (opts.scale ?? 0.5);
      th = (tw * image.height) / image.width;
      const im = `${prefix}Im`;
      subDict(doc, res, 'XObject').set(PDFName.of(im), image.ref);
      draw = `q ${fmt(tw)} 0 0 ${fmt(th)} ${fmt(-tw / 2)} ${fmt(-th / 2)} cm /${im} Do Q\n`;
    } else {
      const { font, key } = fontKeyFor(doc, state, res, prefix, fo.name);
      const size = opts.scale ? (opts.scale * W * fo.size) / font.widthOfTextAtSize(text, fo.size) : fo.size;
      tw = font.widthOfTextAtSize(text, size);
      const { ascent, descent } = ascentDescent(fo.name, size);
      th = ascent - descent;
      draw = textOp(font, key, size, fo.color, text, -tw / 2, -(ascent + descent) / 2);
    }
    const bw = Math.abs(tw * c) + Math.abs(th * s), bh = Math.abs(tw * s) + Math.abs(th * c); // rotated bbox
    const gs = `${prefix}GS`;
    opacityGs(doc, res, gs, opacity);
    const centres = [];
    if (opts.tile) {
      const sx = bw + gap, sy = bh + gap;
      const nx = Math.min(30, Math.ceil(W / sx) + 1), ny = Math.min(30, Math.ceil(H / sy) + 1);
      for (let a = -nx; a <= nx; a++) for (let b = -ny; b <= ny; b++) {
        const x = W / 2 + a * sx, y = H / 2 + b * sy;
        if (x + bw / 2 > 0 && x - bw / 2 < W && y + bh / 2 > 0 && y - bh / 2 < H) centres.push([x, y]);
      }
    } else {
      const [v, hz] = position === 'center' ? ['middle', 'center'] : position.split('-');
      const x = hz === 'left' ? margin + bw / 2 : hz === 'right' ? W - margin - bw / 2 : W / 2;
      const y = v === 'top' ? H - margin - bh / 2 : v === 'bottom' ? margin + bh / 2 : H / 2;
      centres.push([x, y]);
    }
    let ops = `q\n${cm}/${gs} gs\n`;
    for (const [x, y] of centres) ops += `q ${fmt(c)} ${fmt(s)} ${fmt(-s)} ${fmt(c)} ${fmt(x)} ${fmt(y)} cm\n${draw}Q\n`;
    ops += 'Q\n';
    insertStream(doc, page, tagged(doc, kind, artifact(kind, 'Watermark', ops)), layer);
  }
  return finish(doc);
}

/**
 * Background: a colour filling the visible page, or an image fitted (aspect kept) and centred,
 * always behind the page content. opts: {color | image (PNG/JPEG bytes), scale=1 (image size as a
 * fraction of the fitted size), opacity=1, pages, subset, replace}.
 */
export async function addBackground(bytes, opts = {}) {
  const kind = 'background';
  const hasImage = opts.image !== undefined && opts.image !== null;
  const color = hasImage ? null : parseColor(opts.color ?? null);
  if (!hasImage && !color) throw new TypeError('Background colour or image is required');
  const opacity = opacityOf(opts.opacity);
  const scale = opts.scale ?? 1;
  if (!(scale > 0 && scale <= 1)) throw new RangeError('scale must be in (0, 1]');
  const doc = await begin(bytes, kind, opts);
  const { list } = pageList(opts.pages, doc.getPageCount(), opts.subset);
  const prefix = nextPrefix(doc, CODE[kind]);
  const image = hasImage ? await embedImage(doc, opts.image) : null;
  for (const i of list) {
    const page = doc.getPage(i);
    const { W, H, cm } = frame(page);
    const res = ownResources(doc, page);
    const gs = `${prefix}GS`;
    opacityGs(doc, res, gs, opacity);
    let draw;
    if (image) {
      const k = Math.min(W / image.width, H / image.height) * scale;
      const w = image.width * k, h = image.height * k;
      const im = `${prefix}Im`;
      subDict(doc, res, 'XObject').set(PDFName.of(im), image.ref);
      draw = `${fmt(w)} 0 0 ${fmt(h)} ${fmt((W - w) / 2)} ${fmt((H - h) / 2)} cm /${im} Do\n`;
    } else {
      draw = `${fmt(color.red)} ${fmt(color.green)} ${fmt(color.blue)} rg 0 0 ${fmt(W)} ${fmt(H)} re f\n`;
    }
    insertStream(doc, page, tagged(doc, kind, artifact(kind, 'Background', `q\n${cm}/${gs} gs\n${draw}Q\n`)), 'bottom');
  }
  return finish(doc);
}

/**
 * Bates numbering. opts: {prefix='', suffix='', startNumber=1, digits=6, position='footer-right'
 * (header|footer - left|center|right), font, bold, fontSize=10, color, margins, pages, subset, replace}.
 * Resolves {bytes, lastNumber}.
 */
export async function addBates(bytes, opts = {}) {
  const kind = 'bates';
  const prefixTxt = String(opts.prefix ?? ''), suffixTxt = String(opts.suffix ?? '');
  assertEncodable(prefixTxt + suffixTxt, 'The Bates prefix/suffix');
  const start = opts.startNumber ?? 1, digits = opts.digits ?? 6;
  if (!Number.isInteger(start) || start < 0) throw new RangeError('startNumber must be an integer >= 0');
  if (!Number.isInteger(digits) || digits < 1 || digits > 15) throw new RangeError('digits must be an integer from 1 to 15');
  const [band, slot] = (opts.position ?? 'footer-right').split('-');
  if (!['header', 'footer'].includes(band) || !SLOTS.includes(slot)) throw new TypeError('position must be header-|footer- left|center|right');
  const fo = fontOpts(opts, 10);
  const margins = marginsOf(opts.margins);
  const doc = await begin(bytes, kind, opts);
  const { list } = pageList(opts.pages, doc.getPageCount(), opts.subset);
  const prefix = nextPrefix(doc, CODE[kind]);
  const state = { fonts: new Map() };
  let n = start;
  for (const i of list) {
    const text = prefixTxt + String(n).padStart(digits, '0') + suffixTxt;
    const page = doc.getPage(i);
    const t = slotText(doc, state, page, prefix, { [band]: { [slot]: text } }, fo, margins);
    insertStream(doc, page, tagged(doc, kind, artifact(kind, band === 'header' ? 'Header' : 'Footer', t[band])), 'over');
    n++;
  }
  return { bytes: await finish(doc), lastNumber: n - 1 };
}
