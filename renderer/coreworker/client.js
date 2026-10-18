// Promise-based client for the core worker (renderer/coreworker/worker.js): the core calls of opening a
// document, run off the UI thread. Lazy: the worker starts on the first call.
//   const { objects } = await coreWorker.readAnnotations(bytes);
// Input bytes are copied before transfer (the caller's array stays usable); results arrive transferred.
// If the worker cannot start (or dies), every call runs on the main thread instead (logged once).
import { decodeResponse, encodeRequest } from '../pdfium/protocol.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);
const LOST = Symbol('core worker lost');
let worker = null, starting = null, broken = false, seq = 0;
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
  worker = null;
}
function start() {
  starting ??= (async () => {
    worker = new Worker(WORKER_URL, { type: 'module', name: 'core' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      try { p.resolve(decodeResponse(data)); } catch (e) { if (data.error?.code) e.code = data.error.code; p.reject(e); }
    };
    worker.onerror = (e) => { e.preventDefault?.(); failAll(Object.assign(new Error(`core worker: ${e.message || 'failed to load'}`), { [LOST]: true })); };
    await post('ping', []);
  })();
  return starting;
}

async function call(method, bytes, ...rest) {
  if (!broken) {
    try {
      await start();
      return await post(method, [new Uint8Array(bytes), ...rest]); // own buffer, safe to transfer
    } catch (err) {
      if (!err?.[LOST]) throw err; // the core's own error (e.g. ENCRYPTED)
      if (!broken) console.warn('Core worker unavailable; opening work runs on the main thread', err);
      broken = true;
      failAll(err);
    }
  }
  const core = await import('../../src/core/index.js');
  return core[method](bytes, ...rest);
}

export const coreWorker = {
  /** readAnnotations(bytes) -> { objects, skipped } (src/core/annots.js). */
  readAnnotations: (bytes) => call('readAnnotations', bytes),
  /** writeAnnotations(bytes, { add, update, remove }, opts) -> Uint8Array (src/core/annots.js). */
  writeAnnotations: (bytes, edits, opts) => call('writeAnnotations', bytes, edits, opts),
  detectSignatures: (bytes) => call('detectSignatures', bytes),
  docMdpPermission: (bytes) => call('docMdpPermission', bytes),
  /** For tests: true while calls go to the worker (false before the first call and after a fallback). */
  get inWorker() { return !!worker && !broken; },
};
