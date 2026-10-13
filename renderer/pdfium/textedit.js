// Line-level editing of a page's ORIGINAL text with PDFium (see docs/PDFIUM-SPIKE.md, item 3). Pure functions of an
// initialised @embedpdf/pdfium module `m` and an open FPDF_DOCUMENT, so the worker and Node tests share them.
//   textLines(m, doc, pageIndex) -> [{ id, text, bbox: [l, b, r, t], font, size, color: [r, g, b, a], embedded, subset,
//                                     rotation, objects: [index | [formIndex, ..., childIndex]], editable, reason? }]
//   await editLine(m, doc, pageIndex, lineId, newText, { loadFont: async (file) => Uint8Array })
//     -> { ok: true, substituted: fontFile | null, widthBefore, widthAfter } | { ok: false, reason }
// Lines: text objects grouped by baseline (same rotation, baseline within 0.3 x font size, gaps < 1.5 x font size),
// at top level and inside Form XObjects (reported, not editable). Edit: the first object keeps its matrix, size and
// colour and takes the new text; the line's other objects are removed. No reflow. A justified line (word gaps wider
// than SPREAD_RATIO x a normal space, justify.js) keeps its extent instead: one text object per word, the first
// starting where the line started, the last ending where it ended, equal gaps (reusing the line's objects in
// place when it was one object per word; else new objects in the line's font, or the substitute). Coverage is verified by reading
// the text back: a subset font silently writes missing glyphs as glyph 0 (read back as dropped chars / U+0000), so
// then the text goes into a new object in a bundled full TrueType font (FONT_FILES) loaded with FPDFText_LoadFont.
// FPDFPage_GenerateContent rewrites the page's whole content stream; the caller saves (worker.js: full save).
import { isSpread, layoutWords, lineWords } from './justify.js';

const OBJ_TEXT = 1, OBJ_FORM = 5, FPDF_FONT_TRUETYPE = 2;

/** Bundled substitute fonts (SIL OFL 1.1, @expo-google-fonts/*): file name in renderer/vendor/fonts/edit/ -> node_modules source.
 *  Carlito ~ Calibri, Caladea ~ Cambria, Arimo ~ Arial/Helvetica, Tinos ~ Times, Cousine ~ Courier (metric-compatible;
 *  Arimo/Tinos/Cousine are the upstream designs of Liberation Sans/Serif/Mono 2.x). */
const FAMILIES = { Carlito: 'carlito', Caladea: 'caladea', Arimo: 'arimo', Tinos: 'tinos', Cousine: 'cousine' };
const STYLES = { Regular: '400Regular', Bold: '700Bold', Italic: '400Regular_Italic', BoldItalic: '700Bold_Italic' };
export const FONT_FILES = Object.fromEntries(Object.entries(FAMILIES).flatMap(([fam, pkg]) => Object.entries(STYLES).map(([st, dir]) =>
  [`${fam}-${st}.ttf`, `@expo-google-fonts/${pkg}/${dir}/${fam}_${dir}.ttf`])));

/** Substitute font file for a PDF font name (subset tag ignored); unknown families -> Arimo. */
export function substituteFont(fontName) {
  const n = String(fontName ?? '').replace(/^[A-Z]{6}\+/, '').toLowerCase();
  const fam = /calibri|carlito/.test(n) ? 'Carlito' : /cambria|caladea/.test(n) ? 'Caladea'
    : /courier|cousine|mono/.test(n) ? 'Cousine' : /times|tinos|serif|roman|georgia/.test(n) ? 'Tinos' : 'Arimo';
  const bold = /bold|black|heavy|semibold|demi/.test(n), italic = /italic|oblique/.test(n);
  return `${fam}-${bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular'}.ttf`;
}

/** FNV-1a, hex: line ids change whenever the page's objects or their text change. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
/** Matrix product: apply A, then B (PDF row-vector convention [a b c d e f]). */
const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];
function mapBox([l, b, r, t], M) {
  const pts = [[l, b], [r, b], [l, t], [r, t]].map(([x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function api(m) {
  const mem = m.pdfium, malloc = (n) => mem.wasmExports.malloc(n), free = (p) => mem.wasmExports.free(p);
  const out = (n, type, fn) => {
    const p = malloc(4 * n);
    try { return fn(...Array.from({ length: n }, (_, i) => p + 4 * i)) ? Array.from({ length: n }, (_, i) => mem.getValue(p + 4 * i, type)) : null; } finally { free(p); }
  };
  const str = (fn, decode) => {
    const len = fn(0, 0);
    if (!len) return '';
    const p = malloc(len);
    try { fn(p, len); return decode(p); } finally { free(p); }
  };
  return {
    free,
    wide(s) { const p = malloc(2 * (s.length + 1)); mem.stringToUTF16(s, p, 2 * (s.length + 1)); return p; },
    bytes(u8) { const p = malloc(u8.length); mem.HEAPU8.set(u8, p); return p; },
    matrix: (o) => out(6, 'float', (p) => m.FPDFPageObj_GetMatrix(o, p)),
    bounds: (o) => out(4, 'float', (l, b, r, t) => m.FPDFPageObj_GetBounds(o, l, b, r, t)),
    size: (o) => out(1, 'float', (p) => m.FPDFTextObj_GetFontSize(o, p))?.[0] ?? 0,
    color: (o) => out(4, 'i32', (r, g, b, a) => m.FPDFPageObj_GetFillColor(o, r, g, b, a)) ?? [0, 0, 0, 255],
    text: (o, tp) => str((p, len) => m.FPDFTextObj_GetText(o, tp, p, len), (p) => mem.UTF16ToString(p)),
    glyphWidth: (f, cp, size) => out(1, 'float', (p) => m.FPDFFont_GetGlyphWidth(f, cp, size, p))?.[0] ?? 0,
    fontName: (f) => str((p, len) => m.FPDFFont_GetBaseFontName(f, p, len), (p) => mem.UTF8ToString(p)),
  };
}

/** All text objects of a loaded page, with their path, page-space baseline geometry and font data. */
function collect(m, A, page, tp) {
  const found = [];
  const visit = (count, get, path, ctm) => {
    for (let i = 0; i < count; i++) {
      const o = get(i), type = m.FPDFPageObj_GetType(o), M = A.matrix(o);
      if (!M) continue;
      if (type === OBJ_FORM) { visit(m.FPDFFormObj_CountObjects(o), (k) => m.FPDFFormObj_GetObject(o, k), [...path, i], mul(M, ctm)); continue; }
      if (type !== OBJ_TEXT) continue;
      const own = A.bounds(o);
      if (!own) continue;
      const T = mul(M, ctm), font = m.FPDFTextObj_GetFont(o), raw = A.size(o);
      const rot = Math.round(Math.atan2(T[1], T[0]) * 180 / Math.PI), ux = Math.cos(rot * Math.PI / 180), uy = Math.sin(rot * Math.PI / 180);
      const bbox = path.length ? mapBox(own, ctm) : own;
      const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[2], bbox[1]]].map(([x, y]) => x * ux + y * uy);
      const name = A.fontName(font);
      found.push({
        obj: o, fontHandle: font, hscale: Math.hypot(T[0], T[1]), dir: [ux, uy], path: path.length ? [...path, i] : i, inForm: path.length > 0, container: path.join('/'),
        text: A.text(o, tp), font: name, rawSize: raw, size: raw * Math.hypot(T[2], T[3]), rot, matrix: M,
        along: [Math.min(...corners), Math.max(...corners)], perp: -T[4] * uy + T[5] * ux, bbox,
        color: A.color(o), embedded: !!m.FPDFFont_GetIsEmbedded(font), subset: /^[A-Z]{6}\+/.test(name),
      });
    }
  };
  visit(m.FPDFPage_CountObjects(page), (i) => m.FPDFPage_GetObject(page, i), [], [1, 0, 0, 1, 0, 0]);
  return found;
}

function group(objs, pageIndex) {
  const lines = [];
  for (const o of [...objs].sort((a, b) => a.along[0] - b.along[0])) {
    const s = o.size || 1;
    // A wide gap joins runs only in the same font and size (a justified line split into words); a different
    // font after a gap of more than half an em is another column or cell (a bold label beside body text).
    const line = lines.find((L) => {
      if (L.container !== o.container || L.rot !== o.rot || Math.abs(L.perp - o.perp) >= 0.3 * Math.max(s, L.size) || !(o.along[1] > L.end - 0.01)) return false;
      const sameFont = L.font === o.font && Math.abs(L.lastSize - s) <= 0.05 * Math.max(s, L.lastSize);
      return o.along[0] - L.end < (sameFont ? 1.5 : 0.5) * Math.max(s, L.size);
    });
    if (line) { line.items.push(o); line.end = Math.max(line.end, o.along[1]); line.font = o.font; line.lastSize = s; } else lines.push({ container: o.container, rot: o.rot, perp: o.perp, size: s, end: o.along[1], font: o.font, lastSize: s, items: [o] });
  }
  return lines.map(({ items }) => {
    const first = items[0];
    let text = '';
    items.forEach((o, k) => {
      const gap = k ? o.along[0] - items[k - 1].along[1] : 0;
      if (k && gap > 0.15 * first.size && !/\s$/.test(text) && !/^\s/.test(o.text)) text += ' ';
      text += o.text;
    });
    const objects = items.map((o) => o.path);
    const bbox = [Math.min(...items.map((o) => o.bbox[0])), Math.min(...items.map((o) => o.bbox[1])), Math.max(...items.map((o) => o.bbox[2])), Math.max(...items.map((o) => o.bbox[3]))];
    return {
      id: hash(`${pageIndex}|${JSON.stringify(objects)}|${text}`), text, bbox, font: first.font, size: first.size, color: first.color,
      embedded: first.embedded, subset: first.subset, rotation: first.rot, objects,
      editable: !first.inForm, ...(first.inForm ? { reason: 'the line is inside a Form XObject; editing text there is not supported' } : {}),
      items,
    };
  }).sort((a, b) => b.bbox[3] - a.bbox[3] || a.bbox[0] - b.bbox[0]);
}

function withPage(m, doc, pageIndex, fn) {
  const page = m.FPDF_LoadPage(doc, pageIndex);
  if (!page) throw new Error(`pdfium: cannot load page ${pageIndex}`);
  try { return fn(page); } finally { m.FPDF_ClosePage(page); }
}
function readLines(m, A, page, pageIndex) {
  const tp = m.FPDFText_LoadPage(page);
  try { return group(collect(m, A, page, tp), pageIndex); } finally { m.FPDFText_ClosePage(tp); }
}

export function textLines(m, doc, pageIndex) {
  const A = api(m);
  return withPage(m, doc, pageIndex, (page) => readLines(m, A, page, pageIndex).map(({ items, ...line }) => line));
}

export async function editLine(m, doc, pageIndex, lineId, newText, { loadFont } = {}) {
  const A = api(m);
  const page = m.FPDF_LoadPage(doc, pageIndex);
  if (!page) throw new Error(`pdfium: cannot load page ${pageIndex}`);
  let font = 0;
  try {
    const line = readLines(m, A, page, pageIndex).find((L) => L.id === lineId);
    if (!line) return { ok: false, reason: `no line ${lineId} on page ${pageIndex} (the page changed; list the lines again)` };
    if (!line.editable) return { ok: false, reason: line.reason };
    const [first, ...rest] = line.items;
    // Covered = PDFium reads back every character of each object's text: missing glyphs come back dropped or as U+0000.
    const covered = (objs, texts) => {
      const tp = m.FPDFText_LoadPage(page);
      try { return objs.every((o, i) => { const got = A.text(o, tp); return !/[\u0000�]/.test(got) && got.replace(/\s+/g, '') === String(texts[i]).replace(/\s+/g, ''); }); } finally { m.FPDFText_ClosePage(tp); }
    };
    const setText = (o, text = newText) => { const p = A.wide(String(text)); try { return !!m.FPDFText_SetText(o, p); } finally { A.free(p); } };
    const indexOf = (obj) => Array.from({ length: m.FPDFPage_CountObjects(page) }, (_, i) => m.FPDFPage_GetObject(page, i)).indexOf(obj);
    const substitute = async () => {
      const file = substituteFont(first.font);
      if (!loadFont) throw new Error(`textedit: font ${file} needed but no loadFont given`);
      const ttf = await loadFont(file);
      const p = A.bytes(ttf);
      try { font = m.FPDFText_LoadFont(doc, p, ttf.length, FPDF_FONT_TRUETYPE, true); } finally { A.free(p); }
      if (!font) throw new Error(`textedit: FPDFText_LoadFont failed for ${file}`);
      return file;
    };
    /** New text objects in `f` at the first object's matrix, size and colour, inserted from z-index `at` on. */
    const create = (f, texts, at) => texts.map((text, k) => {
      const o = m.FPDFPageObj_CreateTextObj(doc, f, first.rawSize);
      const mp = A.bytes(new Uint8Array(new Float32Array(first.matrix).buffer));
      try { m.FPDFPageObj_SetMatrix(o, mp); } finally { A.free(mp); }
      const [r, g, b, a] = first.color;
      m.FPDFPageObj_SetFillColor(o, r, g, b, a);
      setText(o, text);
      m.FPDFPage_InsertObjectAtIndex(page, o, at + k);
      return o;
    });
    const drop = (objs) => { for (const o of objs) { m.FPDFPage_RemoveObject(page, o); m.FPDFPageObj_Destroy(o); } };
    const [u, v] = first.dir;
    const along = (o) => { const [l, b, r, t] = A.bounds(o); const c = [l * u + b * v, r * u + b * v, l * u + t * v, r * u + t * v]; return [Math.min(...c), Math.max(...c)]; };
    const generate = () => { if (!m.FPDFPage_GenerateContent(page)) throw new Error(`pdfium: FPDFPage_GenerateContent failed on page ${pageIndex}`); };

    // Justified line: lay the new words out across the line's original extent (justify.js).
    const inked = line.items.filter((o) => o.text.trim() && o.along[1] > o.along[0]);
    const oldWords = lineWords(line.text), newWords = lineWords(newText);
    const space = (f, o = first) => (A.glyphWidth(f, 32, o.rawSize) * o.hscale) || 0.25 * o.size;
    const advance = (o) => [...o.text].reduce((w, ch) => w + (/\s/.test(ch) ? 0 : A.glyphWidth(o.fontHandle, ch.codePointAt(0), o.rawSize)), 0) * o.hscale;
    const start = Math.min(...inked.map((o) => o.along[0])), end = Math.max(...inked.map((o) => o.along[1]));
    if (inked.length && newWords.length > 1
      && isSpread({ extent: end - start, wordsWidth: line.items.reduce((w, o) => w + advance(o), 0), gaps: oldWords.length - 1, space: space(first.fontHandle) })) {
      let words = null, wordFont = first.fontHandle, substituted = null, removed = line.items.map((o) => o.obj);
      if (line.items.length === newWords.length && line.items.every((o) => lineWords(o.text).length === 1)) {
        // One object per word: each keeps its own font, size and colour and takes its new word.
        const objs = line.items.map((o) => o.obj);
        if (objs.every((o, k) => setText(o, newWords[k])) && covered(objs, newWords)) { words = objs; removed = []; } else line.items.forEach((o) => setText(o.obj, o.text));
      }
      if (!words) {
        words = create(first.fontHandle, newWords, indexOf(first.obj));
        if (!covered(words, newWords)) {
          drop(words);
          substituted = await substitute();
          wordFont = font;
          words = create(font, newWords, indexOf(first.obj));
          if (!covered(words, newWords)) throw new Error(`textedit: ${substituted} does not cover "${newText}"`);
        }
      }
      drop(removed);
      const ink = words.map(along);
      const { positions } = layoutWords({ start, end, widths: ink.map(([a, b]) => b - a), space: space(wordFont) });
      words.forEach((o, k) => { const d = positions[k] - ink[k][0]; m.FPDFPageObj_Transform(o, 1, 0, 0, 1, d * u, d * v); });
      generate();
      const span = words.map(along);
      return { ok: true, substituted, justified: true, widthBefore: end - start, widthAfter: Math.max(...span.map((a) => a[1])) - Math.min(...span.map((a) => a[0])) };
    }

    let target = first.obj, substituted = null;
    if (!setText(first.obj) || !covered([first.obj], [newText])) {
      substituted = await substitute();
      [target] = create(font, [newText], indexOf(first.obj)); // same z-order as the replaced object
      rest.unshift(first);
      if (!covered([target], [newText])) throw new Error(`textedit: ${substituted} does not cover "${newText}"`);
    }
    drop(rest.map((o) => o.obj));
    generate();
    const after = A.bounds(target);
    return { ok: true, substituted, widthBefore: line.bbox[2] - line.bbox[0], widthAfter: after ? after[2] - after[0] : null };
  } finally {
    if (font) m.FPDFFont_Close(font);
    m.FPDF_ClosePage(page);
  }
}
