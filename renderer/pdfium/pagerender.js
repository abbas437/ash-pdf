// Page rendering for the main view's heavy pages (renderer/ui/viewer.js): PDFium draws a page into a bitmap
// that lines up pixel-for-pixel with pdf.js's canvas for the same viewport. The caller passes pdf.js's own
// transform (PDF user space -> canvas pixels, y down); FPDF_RenderPageBitmapWithMatrix applies its matrix
// AFTER the page's display matrix at 1 pt = 1 px (CropBox top-left origin, page /Rotate applied, y down),
// so the matrix handed to PDFium is displayBase^-1 followed by the target. Pure helpers are exported for tests.

// No FPDF_ANNOT (0x01: annotations stay off - the viewer draws form fields as HTML) and no FPDF_LCD_TEXT (0x02).
export const RENDER_FLAGS = 0;

/** Matrices are [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. Result applies `first`, then `then`. */
export function concat(first, then) {
  const [a1, b1, c1, d1, e1, f1] = first, [a2, b2, c2, d2, e2, f2] = then;
  return [a1 * a2 + b1 * c2, a1 * b2 + b1 * d2, c1 * a2 + d1 * c2, c1 * b2 + d1 * d2, e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2];
}
export function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (!det) throw new Error('pagerender: matrix is not invertible');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * PDFium's display matrix at scale 1: user space -> page box with its top-left corner at the origin, y down,
 * rotated clockwise by `rotate` (0-3 quarter turns, the page's /Rotate). box = { left, top, right, bottom }.
 */
export function displayBase({ left: l, top: t, right: r, bottom: b }, rotate) {
  switch (((rotate % 4) + 4) % 4) {
    case 1: return [0, 1, 1, 0, -b, -l];
    case 2: return [-1, 0, 0, 1, r, -b];
    case 3: return [0, -1, -1, 0, t, r];
    default: return [1, 0, 0, -1, -l, t];
  }
}

/** The matrix for FPDF_RenderPageBitmapWithMatrix that makes the final mapping equal `target`. */
export const pdfiumMatrix = (box, rotate, target) => concat(invert(displayBase(box, rotate)), target);

/**
 * BGRA/BGRx rows (PDFium bitmap, `stride` bytes per row) -> tightly packed opaque RGBA (ImageData layout).
 * src may live in the wasm heap; the result is a new array.
 */
export function bgraToRgba(src, width, height, stride = width * 4) {
  const out = new Uint8Array(width * height * 4);
  const o32 = new Uint32Array(out.buffer);
  const aligned = src.byteOffset % 4 === 0 && stride % 4 === 0;
  for (let y = 0; y < height; y++) {
    const row = src.byteOffset + y * stride;
    if (aligned) {
      const s32 = new Uint32Array(src.buffer, row, width), base = y * width;
      // little endian: BGRA bytes read as 0xAARRGGBB; RGBA bytes are 0xAABBGGRR
      for (let x = 0; x < width; x++) { const v = s32[x]; o32[base + x] = 0xff000000 | (v & 0x0000ff00) | ((v >>> 16) & 0xff) | ((v & 0xff) << 16); }
    } else {
      const s = new Uint8Array(src.buffer, row, width * 4);
      for (let x = 0, o = y * width * 4; x < width * 4; x += 4, o += 4) { out[o] = s[x + 2]; out[o + 1] = s[x + 1]; out[o + 2] = s[x]; out[o + 3] = 255; }
    }
  }
  return out;
}

/**
 * Render a loaded FPDF_PAGE (PDFium module `m`) into a width x height white bitmap with `matrix` (PDF user
 * space -> bitmap pixels, y down; pdf.js's viewport transform times its output scale). Returns { width, height, rgba }.
 */
export function renderPage(m, page, { width, height, matrix }) {
  const heap = () => m.pdfium.HEAPU8;
  const malloc = (n) => m.pdfium.wasmExports.malloc(n), free = (p) => m.pdfium.wasmExports.free(p);
  const box = malloc(16), mat = malloc(24), clip = malloc(16); // FS_RECTF {left, top, right, bottom}, FS_MATRIX {a..f}
  const bitmap = m.FPDFBitmap_Create(width, height, 0); // BGRx
  if (!bitmap) { free(box); free(mat); free(clip); throw new Error(`pdfium: cannot allocate a ${width}x${height} bitmap`); }
  try {
    if (!m.FPDF_GetPageBoundingBox(page, box)) throw new Error('pdfium: no page box');
    const f = (p, i) => m.pdfium.getValue(p + 4 * i, 'float');
    const bbox = { left: f(box, 0), top: f(box, 1), right: f(box, 2), bottom: f(box, 3) };
    const M = pdfiumMatrix(bbox, m.FPDFPage_GetRotation(page), matrix);
    M.forEach((v, i) => m.pdfium.setValue(mat + 4 * i, v, 'float'));
    [0, 0, width, height].forEach((v, i) => m.pdfium.setValue(clip + 4 * i, v, 'float'));
    m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
    m.FPDF_RenderPageBitmapWithMatrix(bitmap, page, mat, clip, RENDER_FLAGS);
    const stride = m.FPDFBitmap_GetStride(bitmap), buf = m.FPDFBitmap_GetBuffer(bitmap);
    const src = new Uint8Array(heap().buffer, buf, stride * height);
    return { width, height, rgba: bgraToRgba(src, width, height, stride) };
  } finally { m.FPDFBitmap_Destroy(bitmap); free(box); free(mat); free(clip); }
}
