// Core worker: the pdf-lib parses of opening a document (annotation read, view copy, signature checks) run here,
// off the UI thread, so a large file does not freeze the window. Module workers have no import map: this loads
// the copy of src/core that scripts/vendor.js writes to renderer/vendor/core/ with 'pdf-lib' rewritten.
// Messages follow renderer/pdfium/protocol.js; an error also carries the core's `code` (e.g. 'ENCRYPTED').
import { readAnnotations, writeAnnotations } from '../vendor/core/annots.js';
import { detectSignatures } from '../vendor/core/signatures.js';
import { docMdpPermission } from '../vendor/core/incremental.js';
import { encodeError, encodeResult } from '../pdfium/protocol.js';

const methods = { ping: () => true, readAnnotations, writeAnnotations, detectSignatures, docMdpPermission };

self.onmessage = async ({ data: { id, method, args } }) => {
  let reply;
  try {
    const fn = methods[method];
    if (!fn) throw new Error(`core worker: unknown method ${method}`);
    reply = encodeResult(id, await fn(...args));
  } catch (err) {
    reply = encodeError(id, err);
    if (err?.code) reply.msg.error.code = err.code;
  }
  self.postMessage(reply.msg, reply.transfer);
};
