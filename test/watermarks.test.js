import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { findWatermarks, removeWatermarks } from '../src/core/watermarks.js';
import { addWatermark } from '../src/core/pagemarks.js';
import { visibleText } from './helpers.js';
import { watermarkFixture } from './watermark-fixture.js';

export { watermarkFixture };

const words = async (bytes, i) => (await visibleText(bytes, i)).map((t) => t.str).join(' ');

test('findWatermarks counts each kind; PDF Studio marks and pagination artifacts are not "other"', async () => {
  const src = await watermarkFixture();
  assert.deepEqual(await findWatermarks(src), { ash: [], other: [0, 1], annots: { count: 1, pages: [1] } });
  const own = await addWatermark(src, { text: 'OURS' });
  const found = await findWatermarks(own);
  assert.deepEqual(found.ash, [0, 1, 2]);
  assert.deepEqual(found.other, [0, 1], 'our own /ASH_Mark watermark is not counted as another program\'s');
});

test('removeWatermarks other: spans (inline, named, nested, in a form) and Acrobat forms go; the rest stays', async () => {
  const src = await watermarkFixture();
  const before = await words(src, 0);
  for (const w of ['DRAFT', 'NESTEDWM', 'NAMEDWM', 'FORMWM']) assert.match(before, new RegExp(w));
  const out = await removeWatermarks(src, { other: true });
  const p1 = await words(out, 0), p2 = await words(out, 1), p3 = await words(out, 2);
  for (const w of ['DRAFT', 'NESTEDWM', 'NAMEDWM', 'FORMWM']) assert.doesNotMatch(p1, new RegExp(w));
  for (const w of ['Body text one', 'Body text two', 'Page 1', 'Form body']) assert.match(p1, new RegExp(w), `${w} kept`);
  assert.doesNotMatch(p2, /ACROWM/);
  assert.match(p2, /Second body/);
  assert.match(p3, /INTEXTWM/, 'a span whose removal would shift the following text is left alone');
  assert.match(p3, /Tail text/);
  const after = await findWatermarks(out);
  assert.deepEqual(after.other, []);
  assert.equal(after.annots.count, 1, 'annotations only go when chosen');
});

test('removeWatermarks keeps the text position of content after a span (state operators stay)', async () => {
  const src = await watermarkFixture();
  const pos = async (b) => (await visibleText(b, 0)).filter((t) => /Body text two|Page 1/.test(t.str)).map((t) => [t.str, Math.round(t.x), Math.round(t.y)]);
  assert.deepEqual(await pos(await removeWatermarks(src, { other: true })), await pos(src));
});

test('removeWatermarks annots removes only /Watermark annotations; ash removes only our own', async () => {
  const src = await watermarkFixture();
  const out = await removeWatermarks(src, { annots: true });
  const doc = await PDFDocument.load(out);
  const subs = doc.getPage(1).node.lookup(PDFName.Annots).asArray().map((r) => doc.context.lookup(r).get(PDFName.of('Subtype')).decodeText());
  assert.deepEqual(subs, ['Square']);
  assert.match(await words(out, 0), /DRAFT/);
  const own = await addWatermark(src, { text: 'OURS' });
  const gone = await removeWatermarks(own, { ash: true });
  assert.doesNotMatch(await words(gone, 0), /OURS/);
  assert.match(await words(gone, 0), /DRAFT/, 'other programs\' watermarks stay unless chosen');
});
