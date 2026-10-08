import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { markAreas, scrubMetadata } from '../renderer/ui/redact-lib.js';

test('markAreas: overlay boxes to PDF user space, grouped per page (rotated and cropped pages too)', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const p1 = doc.addPage([600, 800]);
  p1.setRotation(degrees(90));
  const p2 = doc.addPage([600, 800]);
  p2.setCropBox(100, 50, 400, 600);
  const bytes = await doc.save();
  const areas = await markAreas(bytes, [
    { type: 'redactMark', page: 2, x: 10, y: 20, w: 30, h: 40 },
    { type: 'redactMark', page: 0, x: 200, y: 180, w: 100, h: 20 },
    { type: 'redactMark', page: 1, x: 0, y: 0, w: 50, h: 10 },
    { type: 'redactMark', page: 0, x: 0, y: 0, w: 0, h: 5 }, // empty: skipped
  ]);
  assert.deepEqual(areas.map((a) => a.pageIndex), [0, 1, 2]);
  assert.deepEqual(areas[0].rects, [[200, 592, 300, 612]]);
  // /Rotate 90: visible x runs along PDF y from the bottom, visible y along PDF x from the left.
  assert.deepEqual(areas[1].rects, [[0, 0, 10, 50]]);
  // Crop box (100,50)-(500,650): visible origin is its top-left corner.
  assert.deepEqual(areas[2].rects, [[110, 590, 140, 630]]);
});

test('scrubMetadata: Info title/author/subject/keywords and the XMP stream are gone from the bytes', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.setTitle('Secret title'); doc.setAuthor('Agent Smith'); doc.setSubject('Hidden subject'); doc.setKeywords(['codeword']);
  const xmp = doc.context.flateStream ? doc.context.stream('<x:xmpmeta>xmp-secret</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }) : null;
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(xmp));
  const before = await doc.save({ useObjectStreams: false });
  assert.ok(Buffer.from(before).includes('xmp-secret'));
  const out = await scrubMetadata(before);
  const s = Buffer.from(out).toString('latin1');
  for (const w of ['xmp-secret', '/Metadata']) assert.ok(!s.includes(w), `${w} left in the bytes`);
  const back = await PDFDocument.load(out, { updateMetadata: false });
  assert.equal(back.getTitle(), undefined);
  assert.equal(back.getAuthor(), undefined);
  assert.equal(back.getSubject(), undefined);
  assert.equal(back.getKeywords(), undefined);
  assert.equal(back.getPageCount(), 1);
});
