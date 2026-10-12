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
/** RGBA PNG: a blue disc on a transparent background. */
export function sealPng(size = 64) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) < size / 2 - 1;
      row.set(inside ? [20, 60, 220, 255] : [0, 0, 0, 0], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
}

export const STAMP_NAME = '#_TEST STAMP';
export const STAMP_RECT = [100, 500, 250, 650]; // PDF user space

/** One-page PDF; `rotate` = page /Rotate. The stamp's form has /BBox [0 0 100 100] (scaled onto the 150pt /Rect). */
export async function apStampPdf({ rotate = 0 } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  if (rotate) page.setRotation(degrees(rotate));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Contract page with a company seal', { x: 72, y: 720, size: 14, font, color: rgb(0, 0, 0) });
  const img = await doc.embedPng(sealPng());
  const form = doc.context.formXObject([
    pushGraphicsState(), concatTransformationMatrix(100, 0, 0, 100, 0, 0), drawObject('Im1'), popGraphicsState(),
    setStrokingRgbColor(0.05, 0.1, 0.6), setLineWidth(3), moveTo(5, 5), lineTo(95, 40), lineTo(30, 90), stroke(),
  ], { BBox: [0, 0, 100, 100], Resources: { XObject: { Im1: img.ref } } });
  const formRef = doc.context.register(form);
  const annot = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Stamp', Rect: STAMP_RECT, F: 4, Name: PDFName.of(STAMP_NAME),
    NM: PDFHexString.fromText('seal-1'), T: PDFHexString.fromText('Other App User'), Contents: PDFHexString.fromText('Company seal'),
    AP: { N: formRef }, P: page.ref,
  }));
  page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
  return doc.save({ useObjectStreams: false });
}
