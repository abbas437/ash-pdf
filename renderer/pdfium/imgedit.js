// Image object editing with PDFium: list, move/scale, delete, replace. Pure functions of an initialised
// @embedpdf/pdfium module `m` and an open FPDF_DOCUMENT (like redact.js), shared by the worker and Node tests.
//   pageImages(m, doc, pageIndex) -> [{ id, bbox: [l, b, r, t], matrix, width, height, filter, inForm }]
//   transformImage(m, doc, pageIndex, id, matrix)   absolute matrix [a b c d e f] (see boxMatrix)
//   deleteImage(m, doc, pageIndex, id)
//   replaceImage(m, doc, pageIndex, id, { bytes, kind: 'jpeg' | 'png' })
// `id` is the index path of the object: "3" is page object 3, "2/0" child 0 of the Form XObject at
// page object 2. Bounds and matrices are in PDF user space (forms: composed with the form matrices).
// Images inside forms are listed but cannot be edited: PDFium does not regenerate a form's content
// stream (an edit would not be saved), so the edit functions throw for them.
// JPEG replacement uses EPDFImageObj_SetJpeg (the stream keeps /DCTDecode); PNG uses EPDFImageObj_SetPng
// (Flate, alpha as an /SMask). The new image is fitted inside the old placement box, keeping its aspect.
// Every edit regenerates the page content; the caller then saves in full.
const OBJ_IMAGE = 3, OBJ_FORM = 5;

/** Matrix product: apply A, then B (PDF row-vector convention). */
const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];
/** Axis-aligned box [l, b, r, t] of the unit square mapped by M (an image's placement). */
export function unitBox(M) {
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
/** New matrix that maps the image from box `from` to box `to` ([l, b, r, t], PDF space): move and scale, rotation kept. */
export function boxMatrix(M, from, to) {
  const sx = (to[2] - to[0]) / (from[2] - from[0] || 1), sy = (to[3] - to[1]) / (from[3] - from[1] || 1);
  return mul(M, [sx, 0, 0, sy, to[0] - from[0] * sx, to[1] - from[1] * sy]);
}

function tools(m) {
  const mem = m.pdfium, malloc = (n) => mem.wasmExports.malloc(n), free = (p) => mem.wasmExports.free(p);
  const floats = (n, fn) => {
    const p = malloc(4 * n);
    try { return fn(...Array.from({ length: n }, (_, i) => p + 4 * i)) ? Array.from({ length: n }, (_, i) => mem.getValue(p + 4 * i, 'float')) : null; } finally { free(p); }
  };
  return { mem, malloc, free, floats, matrix: (o) => floats(6, (p) => m.FPDFPageObj_GetMatrix(o, p)) };
}
function withPage(m, doc, pageIndex, fn) {
  const page = m.FPDF_LoadPage(doc, pageIndex);
  if (!page) throw new Error(`pdfium: cannot load page ${pageIndex}`);
  try { return fn(page); } finally { m.FPDF_ClosePage(page); }
}

export function pageImages(m, doc, pageIndex) {
  const t = tools(m);
  const info = (o, ctm, id, inForm) => {
    const M = t.matrix(o), ip = t.malloc(8);
    let width = 0, height = 0;
    try { if (m.FPDFImageObj_GetImagePixelSize(o, ip, ip + 4)) { width = t.mem.getValue(ip, 'i32'); height = t.mem.getValue(ip + 4, 'i32'); } } finally { t.free(ip); }
    const n = m.FPDFImageObj_GetImageFilterCount(o);
    const filter = n ? (() => {
      const len = m.FPDFImageObj_GetImageFilter(o, n - 1, 0, 0), p = t.malloc(len);
      try { m.FPDFImageObj_GetImageFilter(o, n - 1, p, len); return t.mem.UTF8ToString(p); } finally { t.free(p); }
    })() : null;
    const matrix = mul(M, ctm);
    return { id, bbox: unitBox(matrix), matrix, width, height, filter, inForm };
  };
  const walk = (count, get, ctm, prefix, inForm, out) => {
    for (let i = 0; i < count; i++) {
      const o = get(i), type = m.FPDFPageObj_GetType(o), id = prefix + i;
      if (type === OBJ_IMAGE) out.push(info(o, ctm, id, inForm));
      else if (type === OBJ_FORM) {
        const M = t.matrix(o);
        if (M) walk(m.FPDFFormObj_CountObjects(o), (k) => m.FPDFFormObj_GetObject(o, k), mul(M, ctm), `${id}/`, true, out);
      }
    }
    return out;
  };
  return withPage(m, doc, pageIndex, (page) => walk(m.FPDFPage_CountObjects(page), (i) => m.FPDFPage_GetObject(page, i), [1, 0, 0, 1, 0, 0], '', false, []));
}

/** Resolve id on a loaded page to a top-level image object; throws a clear error otherwise. */
function imageAt(m, page, id) {
  const path = String(id).split('/').map(Number);
  if (path.length > 1) throw new Error('This image is inside a form XObject and cannot be edited');
  const o = Number.isInteger(path[0]) && path[0] >= 0 && path[0] < m.FPDFPage_CountObjects(page) ? m.FPDFPage_GetObject(page, path[0]) : 0;
  if (!o || m.FPDFPageObj_GetType(o) !== OBJ_IMAGE) throw new Error(`pdfium: no image object ${id} on this page`);
  return o;
}
function generate(m, page, pageIndex) {
  if (!m.FPDFPage_GenerateContent(page)) throw new Error(`pdfium: FPDFPage_GenerateContent failed on page ${pageIndex}`);
}

export function transformImage(m, doc, pageIndex, id, matrix) {
  const t = tools(m);
  withPage(m, doc, pageIndex, (page) => {
    const o = imageAt(m, page, id);
    const p = t.malloc(24);
    try {
      matrix.forEach((v, i) => t.mem.setValue(p + 4 * i, v, 'float'));
      if (!m.FPDFPageObj_SetMatrix(o, p)) throw new Error('pdfium: FPDFPageObj_SetMatrix failed');
    } finally { t.free(p); }
    generate(m, page, pageIndex);
  });
}

export function deleteImage(m, doc, pageIndex, id) {
  withPage(m, doc, pageIndex, (page) => {
    const o = imageAt(m, page, id);
    if (!m.FPDFPage_RemoveObject(page, o)) throw new Error('pdfium: FPDFPage_RemoveObject failed');
    m.FPDFPageObj_Destroy(o);
    generate(m, page, pageIndex);
  });
}

export function replaceImage(m, doc, pageIndex, id, { bytes, kind }) {
  const set = { jpeg: 'EPDFImageObj_SetJpeg', png: 'EPDFImageObj_SetPng' }[kind];
  if (!set) throw new Error(`Only PNG and JPEG images can be used (got ${kind})`);
  const t = tools(m);
  withPage(m, doc, pageIndex, (page) => {
    const o = imageAt(m, page, id);
    const M = t.matrix(o);
    const dp = t.malloc(bytes.length), pp = t.malloc(4);
    try {
      t.mem.HEAPU8.set(bytes, dp);
      t.mem.setValue(pp, page, 'i32');
      if (!m[set](pp, 1, o, dp, bytes.length)) throw new Error('The image could not be read');
    } finally { t.free(dp); t.free(pp); }
    // Fit the new pixel aspect inside the old placement parallelogram (sides u = (a,b), v = (c,d)), centred.
    const ip = t.malloc(8);
    let w = 1, h = 1;
    try { if (m.FPDFImageObj_GetImagePixelSize(o, ip, ip + 4)) { w = t.mem.getValue(ip, 'i32'); h = t.mem.getValue(ip + 4, 'i32'); } } finally { t.free(ip); }
    const [a, b, c, d, e, f] = M, U = Math.hypot(a, b), V = Math.hypot(c, d), r = w / h;
    let N = M;
    if (U && V) {
      if (r > U / V) { const s = U / r / V; N = [a, b, c * s, d * s, e + c * (1 - s) / 2, f + d * (1 - s) / 2]; }
      else { const s = r * V / U; N = [a * s, b * s, c, d, e + a * (1 - s) / 2, f + b * (1 - s) / 2]; }
    }
    const p = t.malloc(24);
    try { N.forEach((v, i) => t.mem.setValue(p + 4 * i, v, 'float')); m.FPDFPageObj_SetMatrix(o, p); } finally { t.free(p); }
    generate(m, page, pageIndex);
  });
}
