// Client for the compare worker (compare-worker.js): comparePages off the UI thread. Modelled on the core worker's
// client (renderer/coreworker/client.js): lazy start with a ping, a time limit per call, and the main thread as the
// fallback when the worker cannot start, dies or does not answer (then for the rest of the session, logged once).
//   const cmp = await compareWorker.compare(a, b, w, h, opts);
// a and b are transferred (unusable afterwards). If the worker is lost after it took them, compare() rejects with
// err.lost = true and the caller draws the pages again; the next call runs on the main thread. stop() terminates
// the worker (Cancel mid-page, or the end of a run): what it owed rejects with err.stopped = true, and the next
// call starts a fresh one.
import { comparePages, compareRequest } from './compare-lib.js';

const WORKER_URL = new URL('./compare-worker.js', import.meta.url);
let worker = null, starting = null, broken = false, seq = 0;
const pending = new Map(); // request id -> { resolve, reject, timer }
/** Time a call may take before the worker counts as lost: max(floor, 1 s per MB of input), as the core worker. */
const callTimeout = (bytes) => Math.max(compareWorker.timeoutFloorMs, bytes / 1000);

function settleAll(err) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
  worker?.terminate();
  worker = null;
  starting = null;
}
/** The worker is gone or unusable: from now on compares run on the main thread. */
function lose(err) {
  if (!broken) console.warn('Compare worker unavailable; compares run on the main thread', err);
  broken = true;
  settleAll(Object.assign(err, { lost: true }));
}
function post(msg, transfer, ms) {
  return new Promise((resolve, reject) => {
    const id = msg.id;
    const timer = setTimeout(() => lose(new Error(`compare worker: no answer within ${Math.round(ms / 1000)} s`)), ms);
    pending.set(id, { resolve, reject, timer });
    try { worker.postMessage(msg, transfer); } catch (err) { pending.delete(id); clearTimeout(timer); reject(err); }
  });
}
function start() {
  starting ??= (async () => {
    worker = new Worker(WORKER_URL, { type: 'module', name: 'compare' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.error) p.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
      else p.resolve(data.result);
    };
    worker.onerror = (e) => { e.preventDefault?.(); lose(new Error(`compare worker: ${e.message || 'failed to load'}`)); };
    worker.onmessageerror = () => lose(new Error('compare worker: a reply could not be read'));
    await post({ id: ++seq, method: 'ping' }, [], compareWorker.timeoutFloorMs);
  })();
  return starting;
}

async function compare(a, b, width, height, opts = {}) {
  if (!broken && !compareWorker.forceMainThread) {
    try {
      await start();
      if (worker && !broken) {
        const { msg, transfer } = compareRequest(++seq, a, b, width, height, opts);
        const cmp = await post(msg, transfer, callTimeout(a.byteLength + b.byteLength));
        compareWorker.ranOn = 'worker';
        return cmp;
      }
    } catch (err) {
      // The worker's own error (e.g. a RangeError for a bad size), a stop(), or a loss after the pixels were moved:
      // the caller handles it. A loss before (it never started) falls through to the main thread.
      if (!err?.lost || a.byteLength === 0) throw err;
    }
  }
  compareWorker.ranOn = 'main';
  return comparePages(a, b, width, height, opts);
}

export const compareWorker = {
  /** comparePages(a, b, width, height, opts) in the worker, or on the main thread (see the header). */
  compare,
  /** Terminate the worker now (Cancel mid-page; the end of a run). A call it owed rejects with err.stopped. */
  stop: () => settleAll(Object.assign(new Error('compare worker stopped'), { stopped: true })),
  /** Minimum time before an unanswered call counts the worker as lost (tests lower it). */
  timeoutFloorMs: 60_000,
  /** For tests: run every compare on the main thread, as after a fallback. */
  forceMainThread: false,
  /** For tests: where the last compare ran, 'worker' or 'main' (null before the first). */
  ranOn: null,
  /** For tests: true while a worker is running (false before the first compare, after stop() and after a fallback). */
  get inWorker() { return !!worker && !broken; },
};
