// Message format between renderer/pdfium/client.js and renderer/pdfium/worker.js (pure, no DOM).
//   request : { id, method, args }                      client -> worker
//   response: { id, ok: true, result } | { id, ok: false, error: { name, message } }
// Byte arrays travel as transferables (zero-copy); transferList() finds them.

/** ArrayBuffers of the Uint8Arrays in `value` (top level, or one level inside an array/plain object). */
export function transferList(value) {
  const out = new Set();
  const add = (v) => { if (v instanceof Uint8Array && v.buffer instanceof ArrayBuffer) out.add(v.buffer); };
  add(value);
  if (Array.isArray(value)) value.forEach(add);
  else if (value && typeof value === 'object' && !(value instanceof Uint8Array)) Object.values(value).forEach(add);
  return [...out];
}

export const encodeRequest = (id, method, args = []) => ({ msg: { id, method, args }, transfer: transferList(args) });
export const encodeResult = (id, result) => ({ msg: { id, ok: true, result }, transfer: transferList(result) });
export const encodeError = (id, err) => ({
  msg: { id, ok: false, error: { name: err?.name || 'Error', message: String(err?.message ?? err) } }, transfer: [],
});

/** Result of a response message, or throws an Error carrying the worker's name and message. */
export function decodeResponse(msg) {
  if (msg.ok) return msg.result;
  const e = new Error(msg.error?.message ?? 'pdfium: unknown error');
  e.name = msg.error?.name ?? 'Error';
  throw e;
}
