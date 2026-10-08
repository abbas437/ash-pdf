// PDFium edit engine: a module worker owning one PDFium (WebAssembly) instance. See docs/PDFIUM-SPIKE.md.
// Every PDFium call is synchronous, so it must never run on the UI thread. The wasm module is compiled
// by client.js in the document (where the page's CSP applies) and handed over in the 'init' message.
import { init } from '../vendor/pdfium/index.browser.js';
import { encodeError, encodeResult } from './protocol.js';
import { redactDocument } from './redact.js';
import { editLine, textLines } from './textedit.js';

const OBJ_TEXT = 1, FPDF_INCREMENTAL = 1;
let m = null;
const docs = new Map(); // docId -> { doc, ptr }
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
    m.FPDF_CloseDocument(d.doc);
    free(d.ptr);
    docs.delete(docId);
    return true;
  },
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
