// Promise-based client for the core worker (renderer/coreworker/worker.js): the core calls of opening a
// document, run off the UI thread. Lazy: the worker starts on the first call.
//   const { objects } = await coreWorker.readAnnotations(bytes);
// Input bytes are copied before transfer (the caller's array stays usable); results arrive transferred.
// If the worker cannot start, dies (an error event, even with nothing pending) or does not answer a call in
// time (callTimeout: e.g. killed for memory without an error event), it is terminated and every call from
// then on runs on the main thread instead (logged once); the calls it still owed are rerun there too.
import { decodeResponse, encodeRequest } from '../pdfium/protocol.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);
const LOST = Symbol('core worker lost');
let worker = null, starting = null, broken = false, seq = 0;
const pending = new Map(); // request id -> { resolve, reject, timer }
/** Time a call may take before the worker counts as lost: max(floor, 1 s per MB of input). */
const callTimeout = (bytes) => Math.max(coreWorker.timeoutFloorMs, (bytes?.byteLength ?? 0) / 1000);

function post(method, args, ms) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => lose(new Error(`core worker: no answer to ${method} within ${Math.round(ms / 1000)} s`)), ms);
    pending.set(id, { resolve, reject, timer });
    const { msg, transfer } = encodeRequest(id, method, args);
    try { worker.postMessage(msg, transfer); } catch (err) { pending.delete(id); clearTimeout(timer); reject(err); }
  });
}
/** The worker is gone or unusable: settle what it owed with LOST (callers rerun on the main thread). */
function lose(err) {
  if (!broken) console.warn('Core worker unavailable; opening work runs on the main thread', err);
  broken = true;
  const lost = Object.assign(err, { [LOST]: true });
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(lost); }
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
      clearTimeout(p.timer);
      try { p.resolve(decodeResponse(data)); } catch (e) { if (data.error?.code) e.code = data.error.code; p.reject(e); }
    };
    worker.onerror = (e) => { e.preventDefault?.(); lose(new Error(`core worker: ${e.message || 'failed to load'}`)); };
    worker.onmessageerror = () => lose(new Error('core worker: a reply could not be read'));
    await post('ping', [], coreWorker.timeoutFloorMs);
  })();
  return starting;
}

async function call(method, bytes, ...rest) {
  if (!broken) {
    try {
      await start();
      if (!broken) return await post(method, [new Uint8Array(bytes), ...rest], callTimeout(bytes)); // own buffer, safe to transfer
    } catch (err) {
      if (!err?.[LOST]) throw err; // the core's own error (e.g. ENCRYPTED)
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
  /** Minimum time before an unanswered call counts the worker as lost (tests lower it). */
  timeoutFloorMs: 60_000,
  /** For tests: true while calls go to the worker (false before the first call and after a fallback). */
  get inWorker() { return !!worker && !broken; },
};
