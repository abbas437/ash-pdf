// PDFium edit engine: a module worker owning one PDFium (WebAssembly) instance. See docs/PDFIUM-SPIKE.md.
// Every PDFium call is synchronous, so it must never run on the UI thread. The wasm module is compiled
// by client.js in the document (where the page's CSP applies) and handed over in the 'init' message.
import { init } from '../vendor/pdfium/index.browser.js';
import { encodeError, encodeResult } from './protocol.js';
import { redactDocument } from './redact.js';
import { pageImages, transformImage, deleteImage, replaceImage } from './imgedit.js';
import { editLine, textLines } from './textedit.js';
import { pageObjects, removeObjects } from './wmpick.js';
import { renderPage } from './pagerender.js';

const OBJ_TEXT = 1, OBJ_FORM = 5, FPDF_INCREMENTAL = 1;
let m = null;
const docs = new Map(); // docId -> { doc, ptr }
// The one parsed page renderPage keeps (all documents together: a heavy CAD page can hold ~180 MB of the wasm
// heap, which never shrinks), so a zoom re-render of the same page does not parse it again.
let kept = null; // { docId, pageIndex, page } | null
function dropKept() {
  if (kept) m.FPDF_ClosePage(kept.page);
  kept = null;
}
// PDFium has built-in substitutes for these when they are not embedded; any other non-embedded font draws
// nothing here (the wasm build has no system fonts: CJK text vanishes), so such pages stay with pdf.js.
const STANDARD_14 = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold',
  'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Symbol', 'ZapfDingbats']);
/** The BaseFont of the first text object (form XObjects included) whose font is neither embedded nor standard, or null. */
function missingFont(page) {
  // The raw wasm exports in the loop: a CAD page has ~1M objects, and the wrapped calls cost ~6x as much (~0.4 s).
  const X = m.pdfium.wasmExports, fonts = new Set(); // FPDF_FONT handles already looked at
  const visit = (count, get) => {
    for (let i = 0; i < count; i++) {
      const o = get(i), type = X.FPDFPageObj_GetType(o);
      if (type === OBJ_FORM) { const r = visit(X.FPDFFormObj_CountObjects(o), (k) => X.FPDFFormObj_GetObject(o, k)); if (r) return r; continue; }
      if (type !== OBJ_TEXT) continue;
      const font = X.FPDFTextObj_GetFont(o);
      if (!font || fonts.has(font)) continue;
      fonts.add(font);
      if (m.FPDFFont_GetIsEmbedded(font)) continue;
      const name = readString((p, len) => m.FPDFFont_GetBaseFontName(font, p, len), (p) => m.pdfium.UTF8ToString(p));
      if (!STANDARD_14.has(name)) return name || '(unnamed)';
    }
    return null;
  };
  return visit(X.FPDFPage_CountObjects(page), (i) => X.FPDFPage_GetObject(page, i));
}
let nextDoc = 1;
const fonts = new Map(); // substitute font file -> Promise<Uint8Array>, fetched from the app's origin on first use
const loadFont = (file) => {
  if (!fonts.has(file)) {
    fonts.set(file, fetch(new URL(`../vendor/fonts/edit/${file}`, import.meta.url)).then(async (res) => {
      if (!res.ok) throw new Error(`pdfium: cannot load font ${file} (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    }));
    fonts.get(file).catch(() => fonts.delete(file));
  }
  return fonts.get(file);
};

const heap = () => m.pdfium.HEAPU8; // re-read: memory growth replaces the buffer
const malloc = (n) => m.pdfium.wasmExports.malloc(n);
const free = (p) => m.pdfium.wasmExports.free(p);
function getDoc(docId) {
  const d = docs.get(docId);
  if (!d) throw new Error(`pdfium: no open document ${docId}`);
  return d;
}
function outFloats(n, fn) {
  const p = malloc(4 * n);
  try {
    const ok = fn(...Array.from({ length: n }, (_, i) => p + 4 * i));
    return ok ? Array.from({ length: n }, (_, i) => m.pdfium.getValue(p + 4 * i, 'float')) : null;
  } finally { free(p); }
}
function readString(fn, decode) { // PDFium's "call with null for the byte length, then fill" pattern
  const len = fn(0, 0);
  if (!len) return '';
  const p = malloc(len);
  try { fn(p, len); return decode(p); } finally { free(p); }
}

const methods = {
  async init(wasmModule) {
    if (m) return true;
    m = await init({
      instantiateWasm(imports, receive) {
        WebAssembly.instantiate(wasmModule, imports).then((inst) => receive(inst, wasmModule));
        return {};
      },
    });
    m.PDFiumExt_Init();
    return true;
  },
  open(bytes) {
    const ptr = malloc(bytes.length);
    heap().set(bytes, ptr); // FPDF_LoadMemDocument does not copy: the wasm copy lives until close()
    const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, '');
    if (!doc) { free(ptr); throw new Error(`pdfium: cannot open document (FPDF_GetLastError ${m.FPDF_GetLastError()})`); }
    const id = nextDoc++;
    docs.set(id, { doc, ptr });
    return id;
  },
  close(docId) {
    const d = docs.get(docId);
    if (!d) return false;
    if (kept?.docId === docId) dropKept();
    m.FPDF_CloseDocument(d.doc);
    free(d.ptr);
    docs.delete(docId);
    return true;
  },
  /**
   * Draw a page for the viewer (pagerender.js): { width, height, rgba } - opaque RGBA, white background,
   * annotations off. opts: { width, height, matrix } with matrix = PDF user space -> bitmap pixels (y down).
   * { ineligible: 'font', font } instead when the page's text uses a font PDFium cannot draw (missingFont);
   * the page is checked when it is parsed, so a kept page is known to be fine.
   */
  renderPage(docId, pageIndex, opts) {
    const d = getDoc(docId);
    if (kept?.docId !== docId || kept.pageIndex !== pageIndex) {
      dropKept();
      const page = m.FPDF_LoadPage(d.doc, pageIndex);
      if (!page) throw new Error(`pdfium: cannot load page ${pageIndex}`);
      const font = missingFont(page);
      if (font) { m.FPDF_ClosePage(page); return { ineligible: 'font', font }; }
      kept = { docId, pageIndex, page };
    }
    return renderPage(m, kept.page, opts);
  },
  /** Diagnostics for tests: open documents and pages kept parsed by renderPage. */
  stats() { return { docs: docs.size, keptPages: kept ? 1 : 0 }; },
  pageCount(docId) { return m.FPDF_GetPageCount(getDoc(docId).doc); },
  textObjects(docId, pageIndex) {
    const page = m.FPDF_LoadPage(getDoc(docId).doc, pageIndex);
    if (!page) throw new Error(`pdfium: cannot load page ${pageIndex}`);
    const tp = m.FPDFText_LoadPage(page);
    try {
      const out = [];
      const n = m.FPDFPage_CountObjects(page);
      for (let index = 0; index < n; index++) {
        const obj = m.FPDFPage_GetObject(page, index);
        if (m.FPDFPageObj_GetType(obj) !== OBJ_TEXT) continue;
        const font = m.FPDFTextObj_GetFont(obj);
        out.push({
          index,
          text: readString((p, len) => m.FPDFTextObj_GetText(obj, tp, p, len), (p) => m.pdfium.UTF16ToString(p)),
          font: readString((p, len) => m.FPDFFont_GetBaseFontName(font, p, len), (p) => m.pdfium.UTF8ToString(p)),
          size: outFloats(1, (p) => m.FPDFTextObj_GetFontSize(obj, p))?.[0] ?? null,
          matrix: outFloats(6, (p) => m.FPDFPageObj_GetMatrix(obj, p)),
          bounds: outFloats(4, (l, b, r, t) => m.FPDFPageObj_GetBounds(obj, l, b, r, t)), // [left, bottom, right, top]
        });
      }
      return out;
    } finally { m.FPDFText_ClosePage(tp); m.FPDF_ClosePage(page); }
  },
  /** True redaction (redact.js), then a FULL save: returns the new bytes. areas: [{ pageIndex, rects: [[x0,y0,x1,y1]] }], fill [r,g,b] | null. */
  redact(docId, areas, { fill = [0, 0, 0] } = {}) {
    redactDocument(m, getDoc(docId).doc, areas, { fill });
    return methods.save(docId, { incremental: false });
  },
  /** Image objects of a page (imgedit.js). */
  pageImages(docId, pageIndex) { return pageImages(m, getDoc(docId).doc, pageIndex); },
  /** Image edits (imgedit.js), then a FULL save: return the new bytes. op: {transform: matrix} | {remove: true} | {replace: {bytes, kind}}. */
  editImage(docId, pageIndex, id, op) {
    const doc = getDoc(docId).doc;
    if (op.transform) transformImage(m, doc, pageIndex, id, op.transform);
    else if (op.remove) deleteImage(m, doc, pageIndex, id);
    else if (op.replace) replaceImage(m, doc, pageIndex, id, op.replace);
    else throw new Error('pdfium: editImage needs transform, remove or replace');
    return methods.save(docId, { incremental: false });
  },
  /** Top-level page objects with their descriptions for picking a repeated mark (wmpick.js). */
  pageObjects(docId, pageIndex) { return pageObjects(m, getDoc(docId).doc, pageIndex); },
  /** Remove page objects (wmpick.js), then a FULL save: returns the new bytes. list: [{ pageIndex, ids }]. */
  removeObjects(docId, list) {
    removeObjects(m, getDoc(docId).doc, list);
    return methods.save(docId, { incremental: false });
  },
  /** Visual lines of original text on a page (textedit.js). */
  textLines(docId, pageIndex) { return textLines(m, getDoc(docId).doc, pageIndex); },
  /** Replace one line's text (textedit.js), then save: { ok, substituted, widthBefore, widthAfter, bytes } | { ok: false, reason }. */
  async editLine(docId, pageIndex, lineId, newText, { incremental = false } = {}) {
    const r = await editLine(m, getDoc(docId).doc, pageIndex, lineId, newText, { loadFont });
    return r.ok ? { ...r, bytes: methods.save(docId, { incremental }) } : r;
  },
  save(docId, { incremental = false } = {}) {
    const doc = getDoc(docId).doc;
    const w = m.PDFiumExt_OpenFileWriter();
    try {
      if (!m.FPDF_SaveAsCopy(doc, w, incremental ? FPDF_INCREMENTAL : 0)) throw new Error('pdfium: FPDF_SaveAsCopy failed');
      const size = m.PDFiumExt_GetFileWriterSize(w);
      const p = malloc(size);
      try { m.PDFiumExt_GetFileWriterData(w, p, size); return heap().slice(p, p + size); } finally { free(p); }
    } finally { m.PDFiumExt_CloseFileWriter(w); }
  },
};

self.onmessage = async ({ data: { id, method, args } }) => {
  let reply;
  try {
    if (!Object.hasOwn(methods, method)) throw new Error(`pdfium: unknown method ${method}`);
    if (!m && method !== 'init') throw new Error('pdfium: not initialised');
    reply = encodeResult(id, await methods[method](...args));
  } catch (err) { reply = encodeError(id, err); }
  self.postMessage(reply.msg, reply.transfer);
};
