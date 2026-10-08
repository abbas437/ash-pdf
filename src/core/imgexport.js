// Multi-page image export (File > Export to image… with several pages): the rules shared by
// electron/main.js and renderer/shim.js, so the real IPC and the browser stand-in accept and reject
// exactly the same requests. Pure ESM, no Node or DOM APIs.
//
// Protocol (window.api): imageExportBegin(request) -> { jobId, folder, count } | null (cancelled)
//   request = { baseName, pageCount, pages: [1-based page numbers], format: 'png' | 'jpeg' } and no other key;
//   the folder is always chosen by the user in main (never sent by the renderer), file names are built here.
// imageExportWrite(jobId, index, bytes) writes file `index` of the job; imageExportEnd(jobId) closes it
// (also used for cancel); any later write on that job is rejected.

export const MAX_FILES = 2000;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_BASE_LENGTH = 120;
const MAX_PAGE_COUNT = 1_000_000;
const KEYS = ['baseName', 'format', 'pageCount', 'pages'];
const EXT = { png: 'png', jpeg: 'jpg' };
const SIGNATURE = { png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], jpeg: [0xff, 0xd8, 0xff] };
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** A document name -> a safe file base name: no path, no reserved characters or Windows device names, ≤ 120 chars. */
export function safeBaseName(name) {
  let s = String(name ?? '').split(/[\\/]/).pop();
  s = s.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '');
  s = s.slice(0, MAX_BASE_LENGTH).replace(/[\s.]+$/, '');
  if (!s) return 'document';
  if (RESERVED.test(s.split('.')[0].trim())) s = `_${s}`.slice(0, MAX_BASE_LENGTH);
  return s;
}

/** `<base>-p001.png`: the 1-based page number zero-padded to the width of the document's page count. */
export function imageFileName(base, pageNumber, pageCount, format) {
  return `${safeBaseName(base)}-p${String(pageNumber).padStart(String(pageCount).length, '0')}.${EXT[format]}`;
}

/** Validate a begin request -> { format, names } (one file name per requested page). Throws TypeError/RangeError. */
export function planImageExport(req) {
  if (req === null || typeof req !== 'object' || Array.isArray(req) || Object.getPrototypeOf(req) !== Object.prototype) {
    throw new TypeError('image export request must be an object');
  }
  const keys = Object.keys(req).sort();
  if (keys.join() !== KEYS.join()) throw new TypeError(`image export request must have exactly the keys ${KEYS.join(', ')}`);
  const { baseName, format, pageCount, pages } = req;
  if (typeof baseName !== 'string' || baseName.length > 1024) throw new TypeError('baseName must be a string');
  if (!Object.hasOwn(EXT, format)) throw new TypeError("format must be 'png' or 'jpeg'");
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGE_COUNT) throw new RangeError('pageCount must be a positive integer');
  if (!Array.isArray(pages) || pages.length < 1) throw new TypeError('pages must be a non-empty array');
  if (pages.length > MAX_FILES) throw new RangeError(`At most ${MAX_FILES} pages can be exported at once`);
  const seen = new Set();
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 1 || p > pageCount) throw new RangeError(`page ${p} is outside 1-${pageCount}`);
    if (seen.has(p)) throw new RangeError(`page ${p} is listed twice`);
    seen.add(p);
  }
  return { format, names: pages.map((p) => imageFileName(baseName, p, pageCount, format)) };
}

/** Bytes for one file of a job: a Uint8Array of 1 byte to 50 MB carrying the format's signature. */
export function checkImageBytes(bytes, format) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('image bytes must be a Uint8Array');
  if (bytes.length < 1 || bytes.length > MAX_FILE_BYTES) throw new RangeError('image must be 1 byte to 50 MB');
  if (!SIGNATURE[format].every((b, i) => bytes[i] === b)) throw new TypeError(`bytes are not a ${format.toUpperCase()} image`);
  return bytes;
}

/**
 * Open export jobs, keyed by sender + job id. open() after the folder is chosen; take() checks a write
 * (job open, index in range and not yet written, bytes) and returns the file name; close() ends the job.
 */
export class ImageExportJobs {
  #jobs = new Map();
  #seq = 0;
  open(sender, { format, names, folder }) {
    const jobId = ++this.#seq;
    this.#jobs.set(`${sender}:${jobId}`, { format, names, folder, written: new Set() });
    return jobId;
  }
  take(sender, jobId, index, bytes) {
    const job = Number.isInteger(jobId) ? this.#jobs.get(`${sender}:${jobId}`) : undefined;
    if (!job) throw new Error('image export: no such job (ended or never started)');
    if (!Number.isInteger(index) || index < 0 || index >= job.names.length) throw new RangeError('image export: index out of range');
    if (job.written.has(index)) throw new Error('image export: file already written');
    checkImageBytes(bytes, job.format);
    job.written.add(index);
    return { folder: job.folder, name: job.names[index] };
  }
  close(sender, jobId) {
    return this.#jobs.delete(`${sender}:${jobId}`);
  }
  /** Forget every job of `sender` (its window closed mid-export); returns how many. Written files are not touched. */
  dropJobsFor(sender) {
    let n = 0;
    for (const key of [...this.#jobs.keys()]) if (key.startsWith(`${sender}:`)) { this.#jobs.delete(key); n++; }
    return n;
  }
}
