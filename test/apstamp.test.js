import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFStream, PDFRawStream } from 'pdf-lib';
import { writeAnnotations, readAnnotations } from '../src/core/annots.js';
import { flattenObjects } from '../src/core/annotate.js';
import { pageGeometry, pdfToVisible } from '../src/core/internal.js';
import { renderPage, isColor } from './helpers.js';
import { apStampPdf, STAMP_NAME, STAMP_RECT } from './apstamp-fixture.js';

const BLUE = [20, 60, 220];
const WHITE = [255, 255, 255];
const OPTS = { author: 'Ahmad', now: '2026-10-12T10:00:00.000Z' };

async function stampDict(bytes) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const annots = page.node.Annots();
  const dicts = annots ? annots.asArray().map((r) => doc.context.lookup(r)) : [];
  const d = dicts.find((x) => x.get(PDFName.of('Subtype'))?.decodeText?.() === 'Stamp');
  if (!d) return null;
  const n = doc.context.lookup(d.lookup(PDFName.of('AP')).get(PDFName.of('N')));
  return { doc, g: pageGeometry(page), d, rect: d.lookup(PDFName.of('Rect')).asArray().map((v) => v.asNumber()), ap: n, apBytes: n instanceof PDFRawStream ? Buffer.from(n.contents).toString('latin1') : null };
}
/** Visible point of a form-space point (form /BBox [0 0 100 100] mapped onto `rect`). */
function formToVisible(g, rect, fx, fy) {
  const X = rect[0] + (fx / 100) * (rect[2] - rect[0]), Y = rect[1] + (fy / 100) * (rect[3] - rect[1]);
  return pdfToVisible(g, X, Y);
}

for (const rotate of [0, 90]) {
  describe(`foreign stamp with an image/vector appearance (page /Rotate ${rotate})`, () => {
    test('imports as apStamp keeping name, author, contents and an upright appearance PDF', async () => {
      const bytes = await apStampPdf({ rotate });
      const { objects } = await readAnnotations(bytes);
      assert.equal(objects.length, 1);
      const o = objects[0];
      assert.equal(o.type, 'apStamp');
      assert.equal(o.name, STAMP_NAME);
      assert.equal(o.id, 'seal-1');
      assert.equal(o.author, 'Other App User');
      assert.equal(o.note, 'Company seal');
      assert.equal(o.apRotate, rotate);
      assert.ok(o.ap instanceof Uint8Array);
      assert.ok(Math.abs(o.w - 150) < 0.01 && Math.abs(o.h - 150) < 0.01);
      // The appearance PDF shows the seal where the page shows it (inside the disc blue, corner blank).
      const { g } = await stampDict(bytes);
      const page = await renderPage(bytes);
      const ap = await renderPage(o.ap);
      const inDisc = formToVisible(g, STAMP_RECT, 70, 20), corner = formToVisible(g, STAMP_RECT, 3, 97);
      assert.ok(isColor(page.sample(inDisc.x, inDisc.y), BLUE), 'page render: seal blue');
      assert.ok(isColor(ap.sample(inDisc.x - o.x, inDisc.y - o.y), BLUE), 'appearance PDF: seal blue at the same spot');
      assert.ok(isColor(ap.sample(corner.x - o.x, corner.y - o.y), WHITE), 'appearance PDF: transparent corner');
    });

    test('a move writes a new /Rect and keeps the same /AP stream', async () => {
      const bytes = await apStampPdf({ rotate });
      const before = await stampDict(bytes);
      const [o] = (await readAnnotations(bytes)).objects;
      const out = await writeAnnotations(bytes, { update: [{ ...o, x: o.x + 40, y: o.y + 30 }] }, OPTS);
      const after = await stampDict(out);
      assert.equal(after.apBytes, before.apBytes, 'same appearance stream bytes');
      assert.equal(after.d.get(PDFName.of('Name')).decodeText(), STAMP_NAME);
      const v0 = pdfToVisible(before.g, before.rect[0], before.rect[1]);
      const v1 = pdfToVisible(after.g, after.rect[0], after.rect[1]);
      assert.ok(Math.abs(v1.x - v0.x - 40) < 0.01 && Math.abs(v1.y - v0.y - 30) < 0.01, `rect moved by (40,30): ${JSON.stringify([v0, v1])}`);
      const [r] = (await readAnnotations(out)).objects;
      assert.equal(r.type, 'apStamp');
      const img = await renderPage(out);
      const p = formToVisible(after.g, after.rect, 70, 20);
      assert.ok(isColor(img.sample(p.x, p.y), BLUE), 'seal drawn at the new place');
    });

    test('a resize scales the original appearance', async () => {
      const bytes = await apStampPdf({ rotate });
      const before = await stampDict(bytes);
      const [o] = (await readAnnotations(bytes)).objects;
      const out = await writeAnnotations(bytes, { update: [{ ...o, w: 300, h: 300 }] }, OPTS);
      const after = await stampDict(out);
      assert.equal(after.apBytes, before.apBytes);
      assert.ok(Math.abs(Math.abs(after.rect[2] - after.rect[0]) - 300) < 0.01);
    });

    test('unedited: left untouched when other annotations are saved', async () => {
      const bytes = await apStampPdf({ rotate });
      const before = await stampDict(bytes);
      const out = await writeAnnotations(bytes, { add: [{ id: 'r1', page: 0, type: 'rect', x: 10, y: 10, w: 20, h: 20 }] }, OPTS);
      const after = await stampDict(out);
      assert.deepEqual(after.rect, before.rect);
      assert.equal(after.apBytes, before.apBytes);
      assert.equal(after.d.lookup(PDFName.of('T')).decodeText(), 'Other App User');
    });

    test('a copy (new object) is written with the appearance and reads back as apStamp', async () => {
      const bytes = await apStampPdf({ rotate });
      const [o] = (await readAnnotations(bytes)).objects;
      const out = await writeAnnotations(bytes, { add: [{ ...o, id: 'copy-1', source: undefined, x: 20, y: 20 }] }, OPTS);
      const objs = (await readAnnotations(out)).objects;
      const c = objs.find((x) => x.id === 'copy-1');
      assert.equal(c?.type, 'apStamp');
      assert.equal(c.name, STAMP_NAME);
      const img = await renderPage(out);
      assert.ok(isColor(img.sample(20 + 0.7 * 150, 20 + 0.8 * 150), BLUE), 'copy shows the seal upright');
    });

    test('flattenObjects burns an apStamp in (print / export / Apply)', async () => {
      const bytes = await apStampPdf({ rotate });
      const [o] = (await readAnnotations(bytes)).objects;
      const bare = await writeAnnotations(bytes, { remove: [o.id] }, OPTS);
      const out = await flattenObjects(bare, [{ ...o, x: 30, y: 40 }]);
      const img = await renderPage(out);
      assert.ok(isColor(img.sample(30 + 0.7 * 150, 40 + 0.8 * 150), BLUE));
      assert.ok(isColor(img.sample(30 + 0.03 * 150, 40 + 0.03 * 150), WHITE));
    });
  });
}
