// Promise-based client for the PDFium edit worker (renderer/pdfium/worker.js). Lazy: nothing is fetched,
// compiled or started until the first call, so viewing never pays for PDFium.
//   const id = await pdfium.open(bytes); await pdfium.pageCount(id); await pdfium.textObjects(id, 0);
//   const out = await pdfium.save(id, { incremental: true }); await pdfium.close(id);
// Input bytes are copied before transfer (the caller's array stays usable); results arrive transferred.
// The wasm is compiled HERE, in the document, so the page's CSP (script-src 'wasm-unsafe-eval') governs it;
// a worker served without a CSP header would otherwise not be bound by the <meta> policy.
import { decodeResponse, encodeRequest } from './protocol.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);
const WASM_URL = new URL('../vendor/pdfium/pdfium.wasm', import.meta.url);
let worker = null, starting = null, seq = 0;
const pending = new Map(); // request id -> { resolve, reject }

function post(method, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    const { msg, transfer } = encodeRequest(id, method, args);
    worker.postMessage(msg, transfer);
  });
}
function failAll(err) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  worker?.terminate();
  worker = null; starting = null;
}
function start() {
  starting ??= (async () => {
    const res = await fetch(WASM_URL);
    if (!res.ok) throw new Error(`pdfium: cannot load ${WASM_URL.pathname} (${res.status})`);
    const wasmModule = await WebAssembly.compile(await res.arrayBuffer());
    worker = new Worker(WORKER_URL, { type: 'module', name: 'pdfium' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      try { p.resolve(decodeResponse(data)); } catch (e) { p.reject(e); }
    };
    worker.onerror = (e) => { e.preventDefault?.(); failAll(new Error(`pdfium worker: ${e.message || 'failed to load'}`)); };
    await post('init', [wasmModule]);
  })().catch((err) => { failAll(err); throw err; });
  return starting;
}
async function call(method, ...args) {
  await start();
  return post(method, args);
}
const copy = (bytes) => new Uint8Array(bytes); // own buffer, safe to transfer

export const pdfium = {
  open: (bytes) => call('open', copy(bytes)),
  close: (docId) => call('close', docId),
  pageCount: (docId) => call('pageCount', docId),
  textObjects: (docId, pageIndex) => call('textObjects', docId, pageIndex),
  save: (docId, { incremental = false } = {}) => call('save', docId, { incremental }),
  /** True redaction + full save; resolves to the new bytes. See redact.js. */
  redact: (docId, areas, { fill = [0, 0, 0] } = {}) => call('redact', docId, areas, { fill }),
  /** Image objects of a page: [{id, bbox, matrix, width, height, filter, inForm}] (see imgedit.js). */
  pageImages: (docId, pageIndex) => call('pageImages', docId, pageIndex),
  /** Edit one image and save in full; resolves to the new bytes. op: {transform: matrix} | {remove: true} | {replace: {bytes, kind}}. */
  editImage: (docId, pageIndex, id, op) => call('editImage', docId, pageIndex, id, op.replace ? { replace: { ...op.replace, bytes: copy(op.replace.bytes) } } : op),
  /** Original-text lines of a page: [{ id, text, bbox, font, size, color, embedded, subset, objects, editable, reason? }]. See textedit.js. */
  textLines: (docId, pageIndex) => call('textLines', docId, pageIndex),
  /** Replace a line's text + save (full unless incremental); resolves { ok, substituted, widthBefore, widthAfter, bytes } | { ok: false, reason }. */
  editLine: (docId, pageIndex, lineId, newText, { incremental = false } = {}) => call('editLine', docId, pageIndex, lineId, newText, { incremental }),
  get started() { return !!worker; },
  /** Diagnostics for tests: open a generated 2-page PDF, read it back, save incrementally. */
  async selfTest() {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([612, 792]).drawText('PDFium self-test 4711', { x: 50, y: 700, size: 14, font });
    doc.addPage([612, 792]);
    const bytes = await doc.save();
    const id = await pdfium.open(bytes);
    try {
      const pageCount = await pdfium.pageCount(id);
      const objects = await pdfium.textObjects(id, 0);
      const out = await pdfium.save(id, { incremental: true });
      const originalIsPrefix = out.length > bytes.length && bytes.every((b, i) => out[i] === b);
      return { pageCount, text: objects[0]?.text ?? null, objects, inLength: bytes.length, outLength: out.length, originalIsPrefix };
    } finally { await pdfium.close(id); }
  },
};
