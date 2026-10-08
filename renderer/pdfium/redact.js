// True redaction with PDFium (see docs/PDFIUM-SPIKE.md, item 4). Pure function of an initialised
// @embedpdf/pdfium module `m` and an open FPDF_DOCUMENT, so the worker and Node tests share it.
//   redactDocument(m, doc, [{ pageIndex, rects: [[x0, y0, x1, y1], ...] }], { fill: [r, g, b] | null })
// Per rect: text chars inside are removed (EPDFText_RedactInRect, char-precise, recurses into forms);
// an image object fully inside is removed; one partly inside has the covered pixels painted black
// (FPDFImageObj_GetBitmap / SetBitmap) when it is axis-aligned, otherwise it is removed whole;
// a vector path object fully inside is removed by RedactInRect too (observed; one crossing the edge is kept, the box covers it);
// annotations whose /Rect intersects are removed (including /Redact marks: they are consumed by the
// apply); then a filled box (unless fill is null) is drawn. The caller must save in FULL
// (never incremental): an incremental save keeps the old content stream recoverable.
const OBJ_IMAGE = 3, FILLMODE_ALTERNATE = 1, BITMAP_BGRA = 4;

const norm = ([x0, y0, x1, y1]) => ({ l: Math.min(x0, x1), b: Math.min(y0, y1), r: Math.max(x0, x1), t: Math.max(y0, y1) });
const hits = (a, R) => a.l < R.r && a.r > R.l && a.b < R.t && a.t > R.b;

export function redactDocument(m, doc, areas, { fill = [0, 0, 0] } = {}) {
  const mem = m.pdfium, malloc = (n) => mem.wasmExports.malloc(n), free = (p) => mem.wasmExports.free(p);
  const floats = (n, fn) => {
    const p = malloc(4 * n);
    try { return fn(...Array.from({ length: n }, (_, i) => p + 4 * i)) ? Array.from({ length: n }, (_, i) => mem.getValue(p + 4 * i, 'float')) : null; } finally { free(p); }
  };
  const bounds = (o) => { const v = floats(4, (l, b, r, t) => m.FPDFPageObj_GetBounds(o, l, b, r, t)); return v && { l: v[0], b: v[1], r: v[2], t: v[3] }; };
  const stats = { pages: 0, images: { removed: 0, blacked: 0 }, annots: 0 };

  for (const { pageIndex, rects } of areas) {
    const list = (rects ?? []).map(norm).filter((R) => R.r > R.l && R.t > R.b);
    if (!list.length) continue;
    const page = m.FPDF_LoadPage(doc, pageIndex);
    if (!page) throw new Error(`pdfium: cannot load page ${pageIndex}`);
    try {
      const rp = malloc(16);
      try {
        for (const R of list) { // FS_RECTF is {left, top, right, bottom}
          [R.l, R.t, R.r, R.b].forEach((v, i) => mem.setValue(rp + 4 * i, v, 'float'));
          m.EPDFText_RedactInRect(page, rp, true, false);
        }
        // Annotations: FPDFAnnot_GetRect fills the same FS_RECTF layout.
        for (let i = m.FPDFPage_GetAnnotCount(page) - 1; i >= 0; i--) {
          const a = m.FPDFPage_GetAnnot(page, i);
          const ok = a && m.FPDFAnnot_GetRect(a, rp);
          const [l, t, r, b] = [0, 1, 2, 3].map((k) => mem.getValue(rp + 4 * k, 'float'));
          if (a) m.FPDFPage_CloseAnnot(a);
          if (ok && list.some((R) => hits(norm([l, b, r, t]), R)) && m.FPDFPage_RemoveAnnot(page, i)) stats.annots++;
        }
      } finally { free(rp); }
      for (let i = m.FPDFPage_CountObjects(page) - 1; i >= 0; i--) {
        const o = m.FPDFPage_GetObject(page, i);
        if (m.FPDFPageObj_GetType(o) !== OBJ_IMAGE) continue;
        const B = bounds(o);
        const over = B ? list.filter((R) => hits(B, R)) : [];
        if (!over.length) continue;
        const inside = over.some((R) => B.l >= R.l && B.r <= R.r && B.b >= R.b && B.t <= R.t);
        if (!inside && blackOutPixels(m, page, o, over, floats)) { stats.images.blacked++; continue; }
        m.FPDFPage_RemoveObject(page, o);
        m.FPDFPageObj_Destroy(o);
        stats.images.removed++;
      }
      if (fill) {
        const [r, g, b] = fill;
        for (const R of list) {
          const box = m.FPDFPageObj_CreateNewRect(R.l, R.b, R.r - R.l, R.t - R.b);
          m.FPDFPageObj_SetFillColor(box, r, g, b, 255);
          m.FPDFPath_SetDrawMode(box, FILLMODE_ALTERNATE, false);
          m.FPDFPage_InsertObject(page, box);
        }
      }
      if (!m.FPDFPage_GenerateContent(page)) throw new Error(`pdfium: FPDFPage_GenerateContent failed on page ${pageIndex}`);
      stats.pages++;
    } finally { m.FPDF_ClosePage(page); }
  }
  return stats;
}

/** Paint the image pixels under each rect black and write the bitmap back. False = cannot (skewed/rotated or no bitmap). */
function blackOutPixels(m, page, o, rects, floats) {
  const [a, b, c, d, e, f] = floats(6, (p) => m.FPDFPageObj_GetMatrix(o, p)) ?? [];
  if (!a || !d || Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) return false;
  const src = m.FPDFImageObj_GetBitmap(o);
  if (!src) return false;
  const W = m.FPDFBitmap_GetWidth(src), H = m.FPDFBitmap_GetHeight(src);
  // Copy into a BGRA bitmap so FillRect and SetBitmap see one known format.
  const bmp = m.FPDFBitmap_CreateEx(W, H, BITMAP_BGRA, 0, 0);
  try {
    const sStride = m.FPDFBitmap_GetStride(src), dStride = m.FPDFBitmap_GetStride(bmp), fmt = m.FPDFBitmap_GetFormat(src);
    const bpp = { 1: 1, 2: 3, 3: 4, 4: 4 }[fmt];
    if (!bpp) return false;
    const heap = m.pdfium.HEAPU8, sp = m.FPDFBitmap_GetBuffer(src), dp = m.FPDFBitmap_GetBuffer(bmp);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = sp + y * sStride + x * bpp, t = dp + y * dStride + x * 4;
        if (bpp === 1) { heap[t] = heap[t + 1] = heap[t + 2] = heap[s]; } else { heap[t] = heap[s]; heap[t + 1] = heap[s + 1]; heap[t + 2] = heap[s + 2]; }
        heap[t + 3] = fmt === 4 ? heap[s + 3] : 255;
      }
    }
    // Page space -> image unit square (x right, y up) -> bitmap pixels (row 0 = top).
    for (const R of rects) {
      const ux = [(R.l - e) / a, (R.r - e) / a], uy = [(R.b - f) / d, (R.t - f) / d];
      const x0 = Math.max(0, Math.floor(Math.min(...ux) * W)), x1 = Math.min(W, Math.ceil(Math.max(...ux) * W));
      const y0 = Math.max(0, Math.floor((1 - Math.max(...uy)) * H)), y1 = Math.min(H, Math.ceil((1 - Math.min(...uy)) * H));
      if (x1 > x0 && y1 > y0) m.FPDFBitmap_FillRect(bmp, x0, y0, x1 - x0, y1 - y0, 0xff000000);
    }
    const pp = m.pdfium.wasmExports.malloc(4);
    try {
      m.pdfium.setValue(pp, page, 'i32');
      return !!m.FPDFImageObj_SetBitmap(pp, 1, o, bmp);
    } finally { m.pdfium.wasmExports.free(pp); }
  } finally { m.FPDFBitmap_Destroy(bmp); m.FPDFBitmap_Destroy(src); }
}
