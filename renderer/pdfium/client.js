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
// Document ids handed out here -> the current worker's own ids. A restarted worker numbers its documents from
// 1 again, so the old ids are dropped with the old worker: a stale id is an error, never another document.
const docIds = new Map();
let nextDocId = 1;
// renderPage requests wait here and the worker gets ONE at a time (all documents together): a heavy page takes it
// seconds, and the worker cannot stop a render it has begun. So a request cancelled while it waits never reaches
// the worker, the most urgent request goes first (its `priority`: [generation, rank], the latest generation first,
// then the lowest rank - the viewer's latest update, visible pages before their neighbours; requests without one
// come after, newest first), and every other call (editing tools) waits behind at most the one render in flight.
const renders = []; // { docId, pageIndex, opts, key, resolve, reject, signal, onAbort }
let rendering = null; // the request the worker is drawing
const renderStats = { posted: 0, dropped: 0 };
const cancelled = () => Object.assign(new Error('pdfium: render cancelled'), { name: 'AbortError' });
function settle(r) { r.signal?.removeEventListener('abort', r.onAbort); }
function drop(r, err = cancelled()) {
  const k = renders.indexOf(r);
  if (k >= 0) { renders.splice(k, 1); renderStats.dropped++; }
  settle(r);
  r.reject(err);
}
function pumpRenders() {
  if (rendering || !renders.length || !worker) return;
  // a before b: the later generation, then the lower rank; a request without a priority last; ties: the newer one
  const before = (a, b) => {
    const pa = a.priority?.(), pb = b.priority?.();
    if (!pb) return !!pa;
    if (!pa) return false;
    return pa[0] !== pb[0] ? pa[0] > pb[0] : pa[1] < pb[1];
  };
  let k = renders.length - 1;
  for (let j = k - 1; j >= 0; j--) if (before(renders[j], renders[k])) k = j;
  const [r] = renders.splice(k, 1);
  const id = docIds.get(r.docId);
  if (id === undefined) { settle(r); r.reject(new Error(`pdfium: no open document ${r.docId}`)); pumpRenders(); return; }
  rendering = r;
  renderStats.posted++;
  post('renderPage', [id, r.pageIndex, r.opts]).then((v) => { settle(r); r.resolve(v); }, (e) => { settle(r); r.reject(e); })
    .finally(() => { if (rendering === r) { rendering = null; pumpRenders(); } });
}

function post(method, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    const { msg, transfer } = encodeRequest(id, method, args);
    worker.postMessage(msg, transfer);
  });
}
function failAll(err) {
  rendering = null;
  for (const r of renders.splice(0)) { settle(r); r.reject(err); }
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  docIds.clear();
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
/** A call on an open document: docId is translated to the current worker's id. */
async function onDoc(method, docId, ...args) {
  await start();
  const id = docIds.get(docId);
  if (id === undefined) throw new Error(`pdfium: no open document ${docId}`);
  return post(method, [id, ...args]);
}
const copy = (bytes) => new Uint8Array(bytes); // own buffer, safe to transfer

export const pdfium = {
  async open(bytes) {
    await start();
    const w = worker, id = await post('open', [copy(bytes)]);
    if (w !== worker) throw new Error('pdfium: worker restarted');
    docIds.set(nextDocId, id);
    return nextDocId++;
  },
  async close(docId) {
    const id = docIds.get(docId);
    if (id === undefined) return false;
    docIds.delete(docId);
    for (const r of renders.filter((q) => q.docId === docId)) drop(r);
    return post('close', [id]);
  },
  pageCount: (docId) => onDoc('pageCount', docId),
  textObjects: (docId, pageIndex) => onDoc('textObjects', docId, pageIndex),
  save: (docId, { incremental = false } = {}) => onDoc('save', docId, { incremental }),
  /** True redaction + full save; resolves to the new bytes. See redact.js. */
  redact: (docId, areas, { fill = [0, 0, 0] } = {}) => onDoc('redact', docId, areas, { fill }),
  /** Image objects of a page: [{id, bbox, matrix, width, height, filter, inForm}] (see imgedit.js). */
  pageImages: (docId, pageIndex) => onDoc('pageImages', docId, pageIndex),
  /** Edit one image and save in full; resolves to the new bytes. op: {transform: matrix} | {remove: true} | {replace: {bytes, kind}}. */
  editImage: (docId, pageIndex, id, op) => onDoc('editImage', docId, pageIndex, id, op.replace ? { replace: { ...op.replace, bytes: copy(op.replace.bytes) } } : op),
  /** Top-level objects of a page: { width, height, objects: [{ id, type, bbox, quad, … }] } (see wmpick.js). */
  pageObjects: (docId, pageIndex) => onDoc('pageObjects', docId, pageIndex),
  /** Remove page objects and save in full; resolves to the new bytes. list: [{ pageIndex, ids }]. */
  removeObjects: (docId, list) => onDoc('removeObjects', docId, list),
  /** Original-text lines of a page: [{ id, text, bbox, font, size, color, embedded, subset, objects, editable, reason? }]. See textedit.js. */
  textLines: (docId, pageIndex) => onDoc('textLines', docId, pageIndex),
  /** Replace a line's text + save (full unless incremental); resolves { ok, substituted, widthBefore, widthAfter, bytes } | { ok: false, reason }. */
  editLine: (docId, pageIndex, lineId, newText, { incremental = false } = {}) => onDoc('editLine', docId, pageIndex, lineId, newText, { incremental }),
  /**
   * Draw a page: { width, height, rgba } (opaque RGBA), or { ineligible: 'font', font } when PDFium lacks a font the
   * page needs (worker.js). opts: { width, height, matrix } - see pagerender.js. Queued (see `renders`): `signal`
   * aborted rejects with an AbortError at once (a waiting request is never sent; one being drawn is discarded);
   * a newer request with the same `key` (e.g. one view's page) replaces a waiting one. `priority`: () => [generation,
   * rank], asked each time the worker is free (see `renders`).
   */
  async renderPage(docId, pageIndex, { width, height, matrix }, { signal, key, priority } = {}) {
    await start();
    if (signal?.aborted) throw cancelled();
    if (!docIds.has(docId)) throw new Error(`pdfium: no open document ${docId}`);
    return new Promise((resolve, reject) => {
      const r = { docId, pageIndex, opts: { width, height, matrix }, key, priority, resolve, reject, signal, onAbort: () => drop(r) };
      if (key !== undefined) for (const q of renders.filter((q) => q.key === key)) drop(q);
      signal?.addEventListener('abort', r.onAbort);
      renders.push(r);
      pumpRenders();
    });
  },
  get started() { return !!worker; },
  /** Diagnostics for tests: { docs, keptPages } in the worker (without starting it) and the render queue here: { queued, posted, dropped }. */
  stats: async () => ({ ...(worker ? await call('stats') : { docs: 0, keptPages: 0 }), renders: { queued: renders.length, ...renderStats } }),
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
