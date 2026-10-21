// Text box frame (border, fill, inner margin): inset, standard keys and write -> read round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { writeAnnotations, readAnnotations } from '../src/core/annots.js';
import { textInset, layoutRich } from '../src/core/annotate.js';
import { makePdf } from './helpers.js';

const PLAIN = { id: 't', page: 0, type: 'text', x: 40, y: 50, w: 200, h: 14.4, text: 'Hello', fontSize: 12, color: '#000000' };
const FRAMED = { ...PLAIN, id: 'f', h: 40, borderWidth: 2, borderColor: '#ff0000', fill: '#ffff00', padding: 6 };

const firstAnnot = (doc) => doc.context.lookup(doc.getPage(0).node.Annots().asArray()[0]);
const nums = (d, k) => d.lookup(PDFName.of(k))?.asArray().map((x) => x.asNumber());
const readOne = async (bytes) => { const r = await readAnnotations(bytes); return (r.objects ?? r)[0]; };

test('textInset: padding + border width; 0 for a plain box; text wraps in the inner width', () => {
  assert.equal(textInset(PLAIN), 0);
  assert.equal(textInset(FRAMED), 8);
  assert.equal(textInset({ padding: -3, borderWidth: 0 }), 0);
  const narrow = { ...FRAMED, text: "Hello Hello", w: 70 };
  assert.equal(layoutRich(narrow, narrow.w).lines.length, 1);
  assert.equal(layoutRich(narrow, narrow.w - 2 * textInset(narrow)).lines.length, 2);
});

test('a framed text box round-trips borderWidth, borderColor, fill and padding; standard keys written', async () => {
  const out = await writeAnnotations(await makePdf(1), { add: [FRAMED] });
  const d = firstAnnot(await PDFDocument.load(out));
  assert.match(d.lookup(PDFName.of('DA')).decodeText(), / rg 1 0 0 RG$/);
  assert.deepEqual(nums(d, 'C'), [1, 1, 0]);
  assert.equal(d.lookup(PDFName.of('BS')).lookup(PDFName.of('W')).asNumber(), 2);
  assert.equal(d.lookup(PDFName.of('IC')), undefined);
  const o = await readOne(out);
  for (const k of ['borderWidth', 'borderColor', 'fill', 'padding', 'x', 'y', 'w', 'h']) assert.equal(o[k], FRAMED[k], k);
});

test('standard keys alone (private data removed) restore border and fill', async () => {
  const doc = await PDFDocument.load(await writeAnnotations(await makePdf(1), { add: [FRAMED] }));
  const d = firstAnnot(doc);
  const priv = d.keys().filter((k) => /^ASH/i.test(k.decodeText()));
  assert.ok(priv.length, 'private keys present');
  for (const k of priv) d.delete(k);
  const o = await readOne(await doc.save());
  assert.equal(o.borderWidth, 2);
  assert.equal(o.borderColor, '#ff0000');
  assert.equal(o.fill, '#ffff00');
});

test('a plain text box writes no frame keys and reads back without them', async () => {
  const out = await writeAnnotations(await makePdf(1), { add: [PLAIN] });
  const d = firstAnnot(await PDFDocument.load(out));
  assert.doesNotMatch(d.lookup(PDFName.of('DA')).decodeText(), /RG/);
  assert.equal(d.lookup(PDFName.of('C')), undefined);
  assert.equal(d.lookup(PDFName.of('BS')).lookup(PDFName.of('W')).asNumber(), 0);
  const o = await readOne(out);
  for (const k of ['borderWidth', 'borderColor', 'fill', 'padding']) assert.equal(o[k], undefined, k);
});
