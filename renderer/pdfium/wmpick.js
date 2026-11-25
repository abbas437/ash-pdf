// Top-level page objects for "Pick it on the page…" (ui/wm-pick.js, matching in ui/wm-pick-lib.js), and
// their removal. Pure functions of an initialised @embedpdf/pdfium module `m` and an open FPDF_DOCUMENT.
//   pageObjects(m, doc, pageIndex) -> { width, height, objects: [{ id, type, bbox, quad, text?, fontSize?, pixels?, hash?,
//     segments?, kinds?, points?, geomHash?, stroke?, fill?, lineWidth?, drawMode? }] }
// A path lists its geometry: `kinds` one letter per segment (m move, l line, b Bézier; upper case when the
// segment closes the subpath) and `points` [x0, y0, x1, y1, …] in page space (the object matrix applied).
// Over MAX_POINTS segments it gives `geomHash` instead: the points relative to their lowest x and y, rounded
// to 0.1 pt, hashed with the kinds. Plus its stroke and fill colours [r, g, b, a], line width and draw mode.
//   removeObjects(m, doc, [{ pageIndex, ids }]) -> number removed; regenerates each changed page's content
// `id` is the page object index. Only top-level objects are listed: a form XObject is one object (its
// content hashed), as PDFium does not regenerate a form's own stream. The caller saves in FULL.
const TYPES = { 1: 'text', 2: 'path', 3: 'image', 5: 'form' };
export const MAX_POINTS = 2000;
const KINDS = { 0: 'l', 1: 'b', 2: 'm' };

/** FNV-1a, 32 bit, as hex. */
const fnv = (bytes) => { let h = 0x811c9dc5; for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0; return h.toString(16); };

export function pageObjects(m, doc, pageIndex) {
  const mem = m.pdfium, malloc = (n) => mem.wasmExports.malloc(n), free = (p) => mem.wasmExports.free(p);
  const floats = (n, fn) => {
    const p = malloc(4 * n);
    try { return fn(...Array.from({ length: n }, (_, i) => p + 4 * i)) ? Array.from({ length: n }, (_, i) => mem.getValue(p + 4 * i, 'float')) : null; } finally { free(p); }
  };
  const str = (fn, decode) => { const len = fn(0, 0); if (!len) return ''; const p = malloc(len); try { fn(p, len); return decode(p); } finally { free(p); } };
  const raw = (o) => { const len = m.FPDFImageObj_GetImageDataRaw(o, 0, 0); if (!len) return ''; const p = malloc(len); try { m.FPDFImageObj_GetImageDataRaw(o, p, len); return fnv(mem.HEAPU8.subarray(p, p + len)); } finally { free(p); } };
  const pixels = (o) => { const p = malloc(8); try { return m.FPDFImageObj_GetImagePixelSize(o, p, p + 4) ? [mem.getValue(p, 'i32'), mem.getValue(p + 4, 'i32')] : null; } finally { free(p); } };
  const ints = (n, fn) => { const p = malloc(4 * n); try { return fn(...Array.from({ length: n }, (_, i) => p + 4 * i)) ? Array.from({ length: n }, (_, i) => mem.getValue(p + 4 * i, 'i32') >>> 0) : null; } finally { free(p); } };
  const path = (o) => {
    const n = m.FPDFPath_CountSegments(o), [a, b, c, d, e, f] = floats(6, (p) => m.FPDFPageObj_GetMatrix(o, p)) ?? [1, 0, 0, 1, 0, 0];
    let kinds = '';
    const points = [], xy = malloc(8);
    try {
      for (let k = 0; k < n; k++) {
        const seg = m.FPDFPath_GetPathSegment(o, k), kind = KINDS[m.FPDFPathSegment_GetType(seg)] ?? '?';
        kinds += m.FPDFPathSegment_GetClose(seg) ? kind.toUpperCase() : kind;
        const [x, y] = m.FPDFPathSegment_GetPoint(seg, xy, xy + 4) ? [mem.getValue(xy, 'float'), mem.getValue(xy + 4, 'float')] : [NaN, NaN];
        points.push(a * x + c * y + e, b * x + d * y + f);
      }
    } finally { free(xy); }
    const style = {
      stroke: ints(4, (r, g, bl, al) => m.FPDFPageObj_GetStrokeColor(o, r, g, bl, al)), fill: ints(4, (r, g, bl, al) => m.FPDFPageObj_GetFillColor(o, r, g, bl, al)),
      lineWidth: floats(1, (p) => m.FPDFPageObj_GetStrokeWidth(o, p))?.[0] ?? null, drawMode: ints(2, (fm, st) => m.FPDFPath_GetDrawMode(o, fm, st)),
    };
    if (n <= MAX_POINTS) return { type: 'path', segments: n, kinds, points, ...style };
    let x0 = Infinity, y0 = Infinity;
    for (let k = 0; k < points.length; k += 2) { x0 = Math.min(x0, points[k]); y0 = Math.min(y0, points[k + 1]); }
    const rounded = points.map((v, k) => Math.round(10 * (v - (k % 2 ? y0 : x0))));
    return { type: 'path', segments: n, kinds, geomHash: fnv(new TextEncoder().encode(`${kinds}|${rounded.join(',')}`)), ...style };
  };
  const page = m.FPDF_LoadPage(doc, pageIndex);
  if (!page) throw new Error(`pdfium: cannot load page ${pageIndex}`);
  const tp = m.FPDFText_LoadPage(page);
  try {
    const describe = (o) => {
      const type = TYPES[m.FPDFPageObj_GetType(o)];
      if (type === 'text') return { type, text: str((p, len) => m.FPDFTextObj_GetText(o, tp, p, len), (p) => mem.UTF16ToString(p)), fontSize: floats(1, (p) => m.FPDFTextObj_GetFontSize(o, p))?.[0] ?? 0 };
      if (type === 'image') return { type, pixels: pixels(o), hash: raw(o) };
      if (type === 'path') return path(o);
      if (type === 'form') { // content hash: the children's descriptions and matrices, recursively
        const kids = Array.from({ length: m.FPDFFormObj_CountObjects(o) }, (_, k) => { const c = m.FPDFFormObj_GetObject(o, k); return [describe(c), floats(6, (p) => m.FPDFPageObj_GetMatrix(c, p))?.map((v) => v.toFixed(2))]; });
        return { type, hash: fnv(new TextEncoder().encode(JSON.stringify(kids))) };
      }
      return null;
    };
    const objects = [];
    for (let i = 0, n = m.FPDFPage_CountObjects(page); i < n; i++) {
      const o = m.FPDFPage_GetObject(page, i), d = describe(o);
      const bbox = d && floats(4, (l, b, r, t) => m.FPDFPageObj_GetBounds(o, l, b, r, t));
      if (bbox) objects.push({ id: i, ...d, bbox, quad: floats(8, (p) => m.FPDFPageObj_GetRotatedBounds(o, p)) });
    }
    return { width: m.FPDF_GetPageWidthF(page), height: m.FPDF_GetPageHeightF(page), objects };
  } finally { m.FPDFText_ClosePage(tp); m.FPDF_ClosePage(page); }
}

export function removeObjects(m, doc, list) {
  let removed = 0;
  for (const { pageIndex, ids } of list) {
    const ints = (n, fn) => { const p = malloc(4 * n); try { return fn(...Array.from({ length: n }, (_, i) => p + 4 * i)) ? Array.from({ length: n }, (_, i) => mem.getValue(p + 4 * i, 'i32') >>> 0) : null; } finally { free(p); } };
  const path = (o) => {
    const n = m.FPDFPath_CountSegments(o), [a, b, c, d, e, f] = floats(6, (p) => m.FPDFPageObj_GetMatrix(o, p)) ?? [1, 0, 0, 1, 0, 0];
    let kinds = '';
    const points = [], xy = malloc(8);
    try {
      for (let k = 0; k < n; k++) {
        const seg = m.FPDFPath_GetPathSegment(o, k), kind = KINDS[m.FPDFPathSegment_GetType(seg)] ?? '?';
        kinds += m.FPDFPathSegment_GetClose(seg) ? kind.toUpperCase() : kind;
        const [x, y] = m.FPDFPathSegment_GetPoint(seg, xy, xy + 4) ? [mem.getValue(xy, 'float'), mem.getValue(xy + 4, 'float')] : [NaN, NaN];
        points.push(a * x + c * y + e, b * x + d * y + f);
      }
    } finally { free(xy); }
    const style = {
      stroke: ints(4, (r, g, bl, al) => m.FPDFPageObj_GetStrokeColor(o, r, g, bl, al)), fill: ints(4, (r, g, bl, al) => m.FPDFPageObj_GetFillColor(o, r, g, bl, al)),
      lineWidth: floats(1, (p) => m.FPDFPageObj_GetStrokeWidth(o, p))?.[0] ?? null, drawMode: ints(2, (fm, st) => m.FPDFPath_GetDrawMode(o, fm, st)),
    };
    if (n <= MAX_POINTS) return { type: 'path', segments: n, kinds, points, ...style };
    let x0 = Infinity, y0 = Infinity;
    for (let k = 0; k < points.length; k += 2) { x0 = Math.min(x0, points[k]); y0 = Math.min(y0, points[k + 1]); }
    const rounded = points.map((v, k) => Math.round(10 * (v - (k % 2 ? y0 : x0))));
    return { type: 'path', segments: n, kinds, geomHash: fnv(new TextEncoder().encode(`${kinds}|${rounded.join(',')}`)), ...style };
  };
  const page = m.FPDF_LoadPage(doc, pageIndex);
    if (!page) throw new Error(`pdfium: cannot load page ${pageIndex}`);
    try {
      for (const id of [...ids].sort((a, b) => b - a)) { // highest first: indexes below stay valid
        const o = m.FPDFPage_GetObject(page, id);
        if (!o || !m.FPDFPage_RemoveObject(page, o)) throw new Error(`pdfium: cannot remove object ${id} on page ${pageIndex + 1}`);
        m.FPDFPageObj_Destroy(o);
        removed++;
      }
      if (!m.FPDFPage_GenerateContent(page)) throw new Error(`pdfium: FPDFPage_GenerateContent failed on page ${pageIndex}`);
    } finally { m.FPDF_ClosePage(page); }
  }
  return removed;
}
