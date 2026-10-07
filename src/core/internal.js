// Shared helpers for the ASH PDF Studio core library.
// Pure ES module: imports only from 'pdf-lib' so it runs in Node and in the renderer.
import { PDFDocument, EncryptedPDFError, rgb } from 'pdf-lib';

export const PRODUCER = 'ASH PDF Studio';

/** Build an Error carrying a machine-readable `.code`. */
export function coreError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function assertBytes(bytes, label = 'bytes') {
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
    throw new TypeError(`${label} must be a Uint8Array or ArrayBuffer`);
  }
}

/**
 * Load a PDF without touching the caller's bytes (pdf-lib only reads them; we
 * still copy so later caller mutations cannot affect a lazily parsed doc).
 * Encrypted input -> Error{code:'ENCRYPTED'} unless `allowEncrypted` is set
 * (read-only structural inspection, used by getInfo).
 */
export async function loadPdf(bytes, { password, allowEncrypted = false } = {}) {
  assertBytes(bytes);
  const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
  let doc;
  try {
    doc = await PDFDocument.load(copy, { updateMetadata: false, ignoreEncryption: allowEncrypted });
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypted/i.test(String(e && e.message))) {
      throw coreError(
        'ENCRYPTED',
        password
          ? 'This PDF is encrypted. ASH PDF Studio cannot decrypt it for editing, even with a password. ' +
              'Remove the protection in another tool first, or open it read-only in the viewer.'
          : 'This PDF is encrypted (password-protected or permission-restricted). ' +
              'ASH PDF Studio cannot edit encrypted PDFs; it can only be viewed.',
        e,
      );
    }
    throw coreError('INVALID_PDF', `Could not read PDF: ${e && e.message}`, e);
  }
  return doc;
}

/** New document stamped with our producer/creator. */
export async function createPdf() {
  const doc = await PDFDocument.create();
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  return doc;
}

/** Save an edited existing document; bumps ModDate only. */
export async function saveEdited(doc, opts = {}) {
  doc.setModificationDate(new Date());
  return doc.save(opts);
}

export function normRotation(angle) {
  const a = Number(angle) || 0;
  if (a % 90 !== 0) return 0; // same fallback as pdf.js for invalid /Rotate
  return ((a % 360) + 360) % 360;
}

function boxFromRect(r) {
  return [r.x, r.y, r.x + r.width, r.y + r.height];
}

function normBox(b) {
  return {
    xMin: Math.min(b[0], b[2]),
    yMin: Math.min(b[1], b[3]),
    xMax: Math.max(b[0], b[2]),
    yMax: Math.max(b[1], b[3]),
  };
}

/**
 * Geometry of a page as a viewer shows it. The visible area is CropBox
 * intersected with MediaBox (pdf.js behaviour). Visible space: origin top-left,
 * y down, after /Rotate, 1 unit = 1 point.
 */
export function pageGeometry(page) {
  // pdf-lib resolves inherited boxes; CropBox defaults to MediaBox.
  const media = normBox(boxFromRect(page.getMediaBox()));
  const crop = normBox(boxFromRect(page.getCropBox()));
  let view = {
    xMin: Math.max(media.xMin, crop.xMin),
    yMin: Math.max(media.yMin, crop.yMin),
    xMax: Math.min(media.xMax, crop.xMax),
    yMax: Math.min(media.yMax, crop.yMax),
  };
  if (view.xMax <= view.xMin || view.yMax <= view.yMin) view = media;
  const rotation = normRotation(page.getRotation().angle);
  const W = view.xMax - view.xMin;
  const H = view.yMax - view.yMin;
  const swap = rotation === 90 || rotation === 270;
  return {
    rotation,
    media,
    crop,
    view,
    width: swap ? H : W, // visible width
    height: swap ? W : H, // visible height
  };
}

/** PDF user space -> visible space (matches pdf.js viewport at scale 1). */
export function pdfToVisible(g, X, Y) {
  const { xMin, yMin, xMax, yMax } = g.view;
  switch (g.rotation) {
    case 90:
      return { x: Y - yMin, y: X - xMin };
    case 180:
      return { x: xMax - X, y: Y - yMin };
    case 270:
      return { x: yMax - Y, y: xMax - X };
    default:
      return { x: X - xMin, y: yMax - Y };
  }
}

/**
 * Matrix [a,b,c,d,e,f] mapping "visible y-up" space (ux = visible x,
 * uy = visibleHeight - visible y) to PDF user space. It is always a proper
 * rotation + translation, so text drawn in this space reads upright.
 */
export function visibleUpMatrix(g) {
  const { xMin, yMin, xMax, yMax } = g.view;
  switch (g.rotation) {
    case 90:
      return [0, 1, -1, 0, xMax, yMin];
    case 180:
      return [-1, 0, 0, -1, xMax, yMax];
    case 270:
      return [0, -1, 1, 0, xMin, yMax];
    default:
      return [1, 0, 0, 1, xMin, yMin];
  }
}

/** Axis-aligned visible rect of a PDF-space rectangle. */
export function pdfRectToVisible(g, x, y, w, h) {
  const pts = [
    pdfToVisible(g, x, y),
    pdfToVisible(g, x + w, y),
    pdfToVisible(g, x, y + h),
    pdfToVisible(g, x + w, y + h),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/** '#rrggbb' / '#rgb' -> pdf-lib RGB; null/'none'/'transparent' -> null. */
export function parseColor(value, fallback) {
  if (value === undefined) value = fallback;
  if (value === null || value === undefined || value === 'none' || value === 'transparent') return null;
  if (typeof value !== 'string') throw new TypeError(`Invalid colour: ${String(value)}`);
  let m = /^#([0-9a-f]{6})$/i.exec(value);
  let hex;
  if (m) hex = m[1];
  else {
    m = /^#([0-9a-f]{3})$/i.exec(value);
    if (!m) throw new TypeError(`Invalid colour (expected #rrggbb): ${value}`);
    hex = m[1].split('').map((c) => c + c).join('');
  }
  const n = parseInt(hex, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export function assertPageIndices(indices, pageCount, label = 'indices') {
  if (!Array.isArray(indices)) throw new TypeError(`${label} must be an array of page indices`);
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= pageCount) {
      throw new RangeError(`Page index ${i} out of range (0..${pageCount - 1})`);
    }
  }
}
