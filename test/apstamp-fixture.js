// Synthetic "other app" stamp fixture (no client files): a page with text and a /Stamp annotation
// whose /AP /N form draws a PNG seal (blue disc, alpha via /SMask) and vector ink strokes.
import { deflateSync } from 'node:zlib';
import {
  PDFDocument, PDFName, PDFHexString, StandardFonts, degrees, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
  setStrokingRgbColor, setLineWidth, moveTo, lineTo, stroke,
} from 'pdf-lib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
/**
 * RGBA PNG: a blue disc on a transparent background. `mark`: its top-left quarter red (shows turns and
 * flips). `noise`: low bits of each pixel vary (the image does not compress: a seal photo's size).
 */
export function sealPng(size = 64, { mark = false, noise = false } = {}) {
  const rows = [];
  let seed = 12345;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) < size / 2 - 1;
      const px = !inside ? [0, 0, 0, 0] : mark && x < size / 2 && y < size / 2 ? [220, 30, 30, 255] : [20, 60, 220, 255];
      if (noise && inside) for (let k = 0; k < 3; k++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; px[k] ^= (seed >>> 16) & 15; }
      row.set(px, 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
}

export const STAMP_NAME = '#_TEST STAMP';
export const STAMP_RECT = [100, 500, 250, 650]; // PDF user space

/**
 * PDF with another app's seal stamp; `rotate` = page /Rotate (a number, or one per page). The stamp's form
 * has /BBox [0 0 100 100] (scaled onto the 150pt /Rect) unless `origin` moves the box and `matrix` sets a
 * /Matrix. `pages`: page count; `count`: stamps sharing the one /AP (one per page, then again on page 0
 * shifted). `states`: /AP /N is a state dictionary chosen by /AS /On. `popup`: a /Popup. `author`: false = no /T.
 * `seal`: sealPng options. `ownForms`: each stamp its own copy of the form (as some apps write them). Extra key /ACME_Private (another app's own data).
 */
export async function apStampPdf({ rotate = 0, pages = 1, count = 1, origin = 0, matrix, states = false, popup = false, author = true, seal, ownForms = false } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    const r = Array.isArray(rotate) ? rotate[i] : rotate;
    if (r) page.setRotation(degrees(r));
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPage(0).drawText('Contract page with a company seal', { x: 72, y: 720, size: 14, font, color: rgb(0, 0, 0) });
  const img = await doc.embedPng(sealPng(seal?.size ?? 64, seal));
  const o = origin;
  const form = doc.context.formXObject([
    pushGraphicsState(), concatTransformationMatrix(100, 0, 0, 100, o, o), drawObject('Im1'), popGraphicsState(),
    setStrokingRgbColor(0.05, 0.1, 0.6), setLineWidth(3), moveTo(o + 5, o + 5), lineTo(o + 95, o + 40), lineTo(o + 30, o + 90), stroke(),
  ], { BBox: [o, o, o + 100, o + 100], ...(matrix ? { Matrix: matrix } : {}), Resources: { XObject: { Im1: img.ref } } });
  const formRef = doc.context.register(form);
  const apOf = () => (ownForms ? { N: doc.context.register(form.clone()) } : AP);
  const AP = states ? { N: { On: formRef, Off: doc.context.register(doc.context.formXObject([], { BBox: [0, 0, 1, 1] })) } } : { N: formRef };
  for (let k = 0; k < count; k++) {
    const page = doc.getPage(k % pages);
    const dy = Math.floor(k / pages) * -20;
    const rect = [STAMP_RECT[0], STAMP_RECT[1] + dy, STAMP_RECT[2], STAMP_RECT[3] + dy];
    const ref = doc.context.nextRef();
    const fields = {
      Type: 'Annot', Subtype: 'Stamp', Rect: rect, F: 4, Name: PDFName.of(STAMP_NAME),
      NM: PDFHexString.fromText(k ? `seal-${k + 1}` : 'seal-1'), Contents: PDFHexString.fromText('Company seal'),
      AP: apOf(), P: page.ref, ACME_Private: PDFHexString.fromText('acme-data'),
      ...(author ? { T: PDFHexString.fromText('Other App User') } : {}), ...(states ? { AS: PDFName.of('On') } : {}),
    };
    const list = [ref];
    if (popup) {
      const pr = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Popup', Parent: ref, Rect: [300, 500, 480, 620], Open: false, P: page.ref }));
      fields.Popup = pr;
      list.push(pr);
    }
    doc.context.assign(ref, doc.context.obj(fields));
    const annots = page.node.Annots();
    if (annots) for (const r of list) annots.push(r);
    else page.node.set(PDFName.of('Annots'), doc.context.obj(list));
  }
  return doc.save({ useObjectStreams: false });
}
