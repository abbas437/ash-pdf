// Test helpers: fixture builders (pdf-lib) and pdf.js inspection/rendering.
import { PDFDocument, degrees, concatTransformationMatrix, decodePDFRawStream, PDFArray, PDFRawStream, PDFHexString, PDFName } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

const pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
// pdf.js wants forward slashes and a trailing slash (Windows paths use backslashes).
const STANDARD_FONTS = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replace(/\\/g, '/');

/** Simple doc with `n` pages of given size; page i gets a label. */
export async function makePdf(n = 3, size = [612, 792]) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) {
    const p = doc.addPage(size);
    p.drawText(`Page ${i + 1}`, { x: 50, y: 50, size: 12 });
  }
  return doc.save();
}

/**
 * Page with non-zero-origin MediaBox [50 100 450 700], smaller CropBox
 * [70 120 430 680] (visible 360x560 unrotated), the given /Rotate, and a
 * dangling `cm` in its content stream (no q/Q) to prove isolation.
 */
export async function makeGeometryFixture(rotation) {
  const doc = await PDFDocument.create();
  const p = doc.addPage([400, 600]);
  p.setMediaBox(50, 100, 400, 600);
  p.setCropBox(70, 120, 360, 560);
  p.setRotation(degrees(rotation));
  p.pushOperators(concatTransformationMatrix(2, 0, 0, 2, 13, 17));
  return doc.save();
}

export async function pdfjsDoc(bytes) {
  const pdfjs = await pdfjsPromise;
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: STANDARD_FONTS, verbosity: 0, isEvalSupported: false });
  const doc = await task.promise;
  doc.close = () => task.destroy();
  return doc;
}

/** Text items with their visible-space origin and direction (viewport scale 1). */
export async function visibleText(bytes, pageIndex = 0) {
  const pdfjs = await pdfjsPromise;
  const doc = await pdfjsDoc(bytes);
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = tc.items
    .filter((it) => it.str !== undefined && it.str !== '')
    .map((it) => {
      const m = pdfjs.Util.transform(viewport.transform, it.transform);
      return { str: it.str, x: m[4], y: m[5], dirX: m[0], dirY: m[1] };
    });
  await doc.close();
  return items;
}

/** Render a page at scale 1 and return a pixel sampler ([r,g,b,a] at visible x,y). */
export async function renderPage(bytes, pageIndex = 0, scale = 1) {
  const doc = await pdfjsDoc(bytes);
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  await doc.close();
  const sample = (x, y) => Array.from(ctx.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data);
  return { sample, width: viewport.width / scale, height: viewport.height / scale };
}

/** Concatenated, decoded content streams of a page (for operator checks). */
export async function pageContent(bytes, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  return streams
    .map((s) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') : Buffer.from(s.getContents()).toString('latin1')))
    .join('\n');
}

export function makeImage(type, w = 40, h = 20, color = '#0000ff') {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return new Uint8Array(c.toBuffer(type === 'png' ? 'image/png' : 'image/jpeg'));
}

export function near(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg}: expected ${expected} +/- ${tol}, got ${actual}`);
  }
}

export function isColor(px, [r, g, b], tol = 40) {
  return Math.abs(px[0] - r) <= tol && Math.abs(px[1] - g) <= tol && Math.abs(px[2] - b) <= tol;
}

/**
 * Signed-looking PDF (no real cryptography): a /Sig value dictionary with /ByteRange and
 * /Contents, a signature field + widget on page 1 and AcroForm /SigFlags. `signed: false` leaves
 * the field empty (no /V). Written without object streams so the raw byte-scan fallback of
 * detectSignatures can see the dictionaries too.
 */
export async function makeSignedPdf({ signed = true, sigFlags = 3, pages = 2 } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`Signed page ${i + 1}`, { x: 50, y: 700, size: 18 });
  const ctx = doc.context;
  const page = doc.getPage(0);
  const field = { FT: 'Sig', T: PDFHexString.fromText('Signature1'), Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], F: 132, P: page.ref };
  if (signed) {
    field.V = ctx.register(ctx.obj({
      Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, 1000, 9192, 500], Contents: PDFHexString.of('00'.repeat(64)), M: PDFHexString.fromText('D:20261007120000Z'),
    }));
  }
  const fieldRef = ctx.register(ctx.obj(field));
  page.node.set(PDFName.of('Annots'), ctx.obj([fieldRef]));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [fieldRef], SigFlags: sigFlags }));
  return doc.save({ useObjectStreams: false });
}

/**
 * Every string a reader could recover from the file: each indirect object's dictionaries/arrays with
 * literal and hex strings decoded, and each stream decoded (Flate etc.) with the hex strings inside it
 * decoded too. Raw-byte searches miss pdf-lib's hex strings and compressed streams.
 */
export async function decodedStrings(bytes) {
  const { PDFDocument: D, PDFDict, PDFString } = await import('pdf-lib');
  const doc = await D.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  const parts = [];
  const hexes = (s) => s.replace(/<([0-9A-Fa-f\s]+)>/g, (_, h) => Buffer.from(h.replace(/\s+/g, ''), 'hex').toString('latin1'));
  const walk = (o) => {
    if (o instanceof PDFString || o instanceof PDFHexString) { parts.push(o.decodeText()); parts.push(Buffer.from(o.asBytes()).toString('latin1')); }
    else if (o instanceof PDFArray) o.asArray().forEach(walk);
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) walk(v);
  };
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream) {
      walk(o.dict);
      let data;
      try { data = Buffer.from(decodePDFRawStream(o).decode()); } catch { data = Buffer.from(o.contents); }
      const s = data.toString('latin1');
      parts.push(s, hexes(s));
    } else walk(o);
  }
  return parts.join('\n');
}
