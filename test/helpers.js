// Test helpers: fixture builders (pdf-lib) and pdf.js inspection/rendering.
import { PDFDocument, degrees, concatTransformationMatrix, decodePDFRawStream, PDFArray, PDFRawStream } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

const pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
const STANDARD_FONTS = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));

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
