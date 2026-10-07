// Shared helpers for the PDFium (WebAssembly) spike. Not app code.
//
// The package is deliberately NOT a dependency of the app. Install it into a gitignored prefix
// inside the worktree (node_modules is a symlink shared with other checkouts):
//   mkdir -p .cache/spike-pdfium && npm install --prefix .cache/spike-pdfium @embedpdf/pdfium@2.15.1
// or point PDFIUM_DIR at any directory containing the package root.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PKG_DIR = process.env.PDFIUM_DIR ?? join(ROOT, '.cache', 'spike-pdfium', 'node_modules', '@embedpdf', 'pdfium');
export const WASM_PATH = join(PKG_DIR, 'dist', 'pdfium.wasm');

// PDFium constants (fpdf_edit.h / fpdf_save.h)
export const OBJ = { UNKNOWN: 0, TEXT: 1, PATH: 2, IMAGE: 3, SHADING: 4, FORM: 5 };
export const FPDF_INCREMENTAL = 1;
export const FPDF_NO_INCREMENTAL = 2;

/** Load + init the wasm module. Returns { m, ms } (m = wrapped module with cwrapped FPDF* calls). */
export async function loadPdfium() {
  if (!existsSync(WASM_PATH)) {
    console.error(`@embedpdf/pdfium not found at ${PKG_DIR}\ninstall: mkdir -p .cache/spike-pdfium && npm install --prefix .cache/spike-pdfium @embedpdf/pdfium@2.15.1`);
    process.exit(2);
  }
  const t0 = performance.now();
  const { init } = await import(pathToFileURL(join(PKG_DIR, 'dist', 'index.js')).href);
  const m = await init({ wasmBinary: readFileSync(WASM_PATH) });
  m.PDFiumExt_Init();
  return { m, ms: performance.now() - t0 };
}

const heap = (m) => m.pdfium.HEAPU8; // re-read every time: memory growth replaces the buffer
export const malloc = (m, n) => m.pdfium.wasmExports.malloc(n);
export const free = (m, p) => m.pdfium.wasmExports.free(p);

/** Open a document from bytes. The wasm-side copy must outlive the document (FPDF_LoadMemDocument does not copy). */
export function openDoc(m, bytes) {
  const ptr = malloc(m, bytes.length);
  heap(m).set(bytes, ptr);
  const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, '');
  if (!doc) throw new Error(`FPDF_LoadMemDocument failed, FPDF_GetLastError=${m.FPDF_GetLastError()}`);
  return { doc, close() { m.FPDF_CloseDocument(doc); free(m, ptr); } };
}

/** FPDF_SaveAsCopy through the wrapper's in-memory FPDF_FILEWRITE. flags: 0 | FPDF_INCREMENTAL | FPDF_NO_INCREMENTAL. */
export function saveDoc(m, doc, flags = 0) {
  const w = m.PDFiumExt_OpenFileWriter();
  const ok = m.FPDF_SaveAsCopy(doc, w, flags);
  if (!ok) throw new Error('FPDF_SaveAsCopy failed');
  const size = m.PDFiumExt_GetFileWriterSize(w);
  const p = malloc(m, size);
  m.PDFiumExt_GetFileWriterData(w, p, size);
  const out = heap(m).slice(p, p + size);
  free(m, p);
  m.PDFiumExt_CloseFileWriter(w);
  return out;
}

/** Call an API that fills N floats through out-pointers; returns [ok, ...floats]. */
export function outFloats(m, n, fn) {
  const p = malloc(m, 4 * n);
  const ok = fn(...Array.from({ length: n }, (_, i) => p + 4 * i));
  const vals = Array.from({ length: n }, (_, i) => m.pdfium.getValue(p + 4 * i, 'float'));
  free(m, p);
  return [ok, ...vals];
}

/** Read a UTF-16LE string via the usual PDFium "call with null to get byte length, then fill" pattern. */
export function readUtf16(m, fn) {
  const len = fn(0, 0);
  if (!len) return '';
  const p = malloc(m, len);
  fn(p, len);
  const s = m.pdfium.UTF16ToString(p);
  free(m, p);
  return s;
}

export function readUtf8(m, fn) {
  const len = fn(0, 0);
  if (!len) return '';
  const p = malloc(m, len);
  fn(p, len);
  const s = m.pdfium.UTF8ToString(p);
  free(m, p);
  return s;
}

/** Allocate a NUL-terminated UTF-16LE string (FPDF_WIDESTRING). Caller frees. */
export function wide(m, s) {
  const bytes = (s.length + 1) * 2;
  const p = malloc(m, bytes);
  m.pdfium.stringToUTF16(s, p, bytes);
  return p;
}

/** FS_MATRIX in/out: 6 floats a b c d e f. */
export function getMatrix(m, obj) {
  const [, a, b, c, d, e, f] = outFloats(m, 6, (p) => m.FPDFPageObj_GetMatrix(obj, p));
  return [a, b, c, d, e, f];
}
export function setMatrix(m, obj, [a, b, c, d, e, f]) {
  const p = malloc(m, 24);
  [a, b, c, d, e, f].forEach((v, i) => m.pdfium.setValue(p + 4 * i, v, 'float'));
  const ok = m.FPDFPageObj_SetMatrix(obj, p);
  free(m, p);
  return ok;
}
export function getBounds(m, obj) {
  const [ok, l, b, r, t] = outFloats(m, 4, (pl, pb, pr, pt) => m.FPDFPageObj_GetBounds(obj, pl, pb, pr, pt));
  return ok ? { l, b, r, t } : null;
}

/** Describe every top-level object of a page (text objects get text/font/size). */
export function listObjects(m, page, textPage) {
  const out = [];
  const n = m.FPDFPage_CountObjects(page);
  for (let i = 0; i < n; i++) {
    const obj = m.FPDFPage_GetObject(page, i);
    const type = m.FPDFPageObj_GetType(obj);
    const rec = { i, obj, type, bounds: getBounds(m, obj), matrix: getMatrix(m, obj) };
    if (type === OBJ.TEXT) {
      rec.text = readUtf16(m, (p, len) => m.FPDFTextObj_GetText(obj, textPage, p, len));
      const font = m.FPDFTextObj_GetFont(obj);
      rec.font = readUtf8(m, (p, len) => m.FPDFFont_GetBaseFontName(font, p, len));
      rec.embedded = !!m.FPDFFont_GetIsEmbedded(font);
      rec.size = outFloats(m, 1, (p) => m.FPDFTextObj_GetFontSize(obj, p))[1];
    }
    out.push(rec);
  }
  return out;
}

/** Render a page to RGBA (BGRA from PDFium swapped to RGBA). scale 1 = 72 dpi. */
export function renderRGBA(m, page, scale = 1) {
  const w = Math.ceil(m.FPDF_GetPageWidthF(page) * scale);
  const h = Math.ceil(m.FPDF_GetPageHeightF(page) * scale);
  const bmp = m.FPDFBitmap_Create(w, h, 1); // alpha = 1 -> BGRA
  m.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
  const FPDF_ANNOT = 0x01, FPDF_LCD_TEXT = 0; // flags
  m.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, FPDF_ANNOT | FPDF_LCD_TEXT);
  const stride = m.FPDFBitmap_GetStride(bmp);
  const buf = m.FPDFBitmap_GetBuffer(bmp);
  const src = heap(m);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = buf + y * stride + x * 4, d = (y * w + x) * 4;
      rgba[d] = src[s + 2]; rgba[d + 1] = src[s + 1]; rgba[d + 2] = src[s]; rgba[d + 3] = src[s + 3];
    }
  }
  m.FPDFBitmap_Destroy(bmp);
  return { w, h, rgba, px: (x, y) => Array.from(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)) };
}

/** All text pdf.js extracts from a page, joined with spaces. */
export async function pdfjsText(bytes, pageIndex = 0) {
  const { pdfjsDoc } = await import('../../../test/helpers.js');
  const doc = await pdfjsDoc(bytes);
  const page = await doc.getPage(pageIndex + 1);
  const tc = await page.getTextContent();
  await doc.close();
  return tc.items.map((it) => it.str).join(' ');
}

/**
 * Fixture (pdf-lib): page 1 has
 *   "Invoice number 4711 is overdue"  Helvetica 14 (standard, not embedded)  at (50,700)
 *   "Total 1234"                       Caveat 20, EMBEDDED SUBSET (only these glyphs) at (50,650)
 *   "Public line" + "SECRET 99-1234"   Helvetica 12 on one line at (50,600) / (200,600)
 *   blue 80x40 PNG image drawn at (300,480) size 160x80
 * Every further page repeats the first line with its page number.
 */
export async function makeFixture(pages = 1) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  const { makeImage } = await import('../../../test/helpers.js');
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const caveat = await doc.embedFont(readFileSync(join(ROOT, 'node_modules/@fontsource/caveat/files/caveat-latin-400-normal.woff')), { subset: true });
  const png = await doc.embedPng(makeImage('png', 80, 40, '#0000ff'));
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(i === 0 ? 'Invoice number 4711 is overdue' : `Page ${i + 1} body text line`, { x: 50, y: 700, size: 14, font: helv });
    if (i === 0) {
      p.drawText('Total 1234', { x: 50, y: 650, size: 20, font: caveat });
      p.drawText('Public line', { x: 50, y: 600, size: 12, font: helv });
      p.drawText('SECRET 99-1234', { x: 200, y: 600, size: 12, font: helv });
      p.drawImage(png, { x: 300, y: 480, width: 160, height: 80 });
    }
  }
  return doc.save();
}

export function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${detail ? ' :: ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}
