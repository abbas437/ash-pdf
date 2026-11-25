import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFArray, StandardFonts } from 'pdf-lib';
import { findWatermarks, removeWatermarks, lexContent } from '../src/core/watermarks.js';
import { addWatermark } from '../src/core/pagemarks.js';
import { visibleText, pageContent } from './helpers.js';
import { watermarkFixture } from './watermark-fixture.js';

export { watermarkFixture };

const words = async (bytes, i) => (await visibleText(bytes, i)).map((t) => t.str).join(' ');

test('findWatermarks counts each kind; PDF Studio marks and pagination artifacts are not "other"', async () => {
  const src = await watermarkFixture();
  assert.deepEqual(await findWatermarks(src), { ash: [], other: [0, 1], annots: { count: 1, pages: [1] }, skipped: 0 });
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

// ------------------------------------------------------------ hostile and unusual content streams
const WM = '/Artifact <</Subtype /Watermark>> BDC';
const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
/** One page per entry; an entry is a content string or an array of them (a /Contents array). */
async function pagesOf(...contents) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context, stream = (c) => ctx.register(ctx.stream(enc(c)));
  for (const c of contents) {
    const p = doc.addPage([612, 792]);
    p.node.set(PDFName.Resources, ctx.obj({ Font: { F1: font.ref } }));
    p.node.set(PDFName.Contents, Array.isArray(c) ? ctx.obj(c.map(stream)) : stream(c));
  }
  return doc.save();
}
const ops = (s) => lexContent(enc(s)).map((x) => x.op);
const balanced = (s) => { const o = ops(s); return o.filter((x) => x === 'q').length === o.filter((x) => x === 'Q').length; };

test('state operators inside a span (unbalanced cm, rg, Tf) stay: later content keeps position, size and colour', async () => {
  const src = await pagesOf(`q ${WM} 1 0 0 1 40 -100 cm 0 0 1 rg BT /F1 30 Tf 100 400 Td (WMSTATE) Tj ET EMC BT 100 500 Td (After) Tj ET Q`);
  const out = await removeWatermarks(src, { other: true });
  const after = async (b) => (await visibleText(b, 0)).filter((t) => t.str === 'After').map((t) => [Math.round(t.x), Math.round(t.y), Math.round(t.dirX)]);
  assert.deepEqual(await after(src), [[140, 392, 30]], 'fixture: After is moved by the cm and sized by the Tf');
  assert.deepEqual(await after(out), await after(src));
  const content = await pageContent(out, 0);
  assert.doesNotMatch(content, /WMSTATE/);
  for (const kept of ['1 0 0 1 40 -100 cm', '0 0 1 rg', '/F1 30 Tf']) assert.ok(content.includes(kept), `${kept} kept`);
});

test('a span split across the streams of a /Contents array is removed; the array becomes one stream', async () => {
  const src = await pagesOf([`BT /F1 12 Tf 50 700 Td (Body one) Tj ET ${WM} BT /F1 30 Tf 100 400 Td (SPLITWM)`, 'Tj ET EMC BT /F1 12 Tf 50 650 Td (Body two) Tj ET']);
  assert.deepEqual((await findWatermarks(src)).other, [0]);
  const out = await removeWatermarks(src, { other: true });
  const doc = await PDFDocument.load(out);
  assert.ok(!(doc.getPage(0).node.Contents() instanceof PDFArray), 'one stream');
  const content = await pageContent(out, 0);
  assert.doesNotMatch(content, /SPLITWM/);
  const body = async (b) => (await visibleText(b, 0)).map((t) => [t.str, Math.round(t.x), Math.round(t.y)]);
  assert.deepEqual(await body(out), (await body(src)).filter(([s]) => s !== 'SPLITWM'));
});

test('a watermark annotation listed on two pages leaves both; a structure-tree OBJR to it does not dangle', async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const p1 = doc.addPage(), p2 = doc.addPage();
  const wa = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Watermark', Rect: [0, 0, 100, 100], StructParent: 0 }));
  p1.node.set(PDFName.Annots, ctx.obj([wa]));
  p2.node.set(PDFName.Annots, ctx.obj([wa]));
  const elem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Annot', K: { Type: 'OBJR', Obj: wa, Pg: p1.ref } }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), ctx.register(ctx.obj({ Type: 'StructTreeRoot', K: [elem], ParentTree: { Nums: [0, elem] } })));
  const src = await doc.save();
  assert.deepEqual((await findWatermarks(src)).annots, { count: 2, pages: [0, 1] });
  const out = await PDFDocument.load(await removeWatermarks(src, { annots: true }));
  for (const i of [0, 1]) assert.equal(out.getPage(i).node.lookup(PDFName.Annots, PDFArray).size(), 0, `page ${i + 1}`);
  const root = out.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
  const objr = root.lookup(PDFName.of('K'), PDFArray).lookup(0, PDFDict).lookup(PDFName.of('K'), PDFDict);
  assert.ok(out.context.lookup(objr.get(PDFName.of('Obj'))) instanceof PDFDict, 'OBJR still resolves');
  assert.equal((await findWatermarks(await out.save())).annots.count, 0);
});

test('lexContent: string escapes, nested parens, hex strings with white-space, comments', () => {
  const s = String.raw`(a\)b\(c\101\\) Tj (x(y(z))w) Tj <48 65
6C> Tj % EMC Tj in a comment
[(A) -10 <42 43>] TJ`;
  const got = lexContent(enc(s));
  assert.deepEqual(got.map((x) => [x.op, x.args.map((a) => [a.t, s.slice(a.s, a.e)])]), [
    ['Tj', [['str', String.raw`(a\)b\(c\101\\)`]]], ['Tj', [['str', '(x(y(z))w)']]], ['Tj', [['hex', '<48 65\n6C>']]], ['TJ', [['arr', '[(A) -10 <42 43>]']]],
  ]);
});

test('escaped parens, comments and hex strings inside a span do not end it early', async () => {
  const src = await pagesOf(String.raw`${WM} BT /F1 20 Tf 100 400 Td (WMA \) EMC \( Q) Tj <574d42> Tj % EMC Q
(WMC (EMC) Q) Tj ET EMC BT /F1 12 Tf 50 700 Td (Body) Tj ET`);
  assert.deepEqual(await findWatermarks(src), { ash: [], other: [0], annots: { count: 0, pages: [] }, skipped: 0 });
  const content = await pageContent(await removeWatermarks(src, { other: true }), 0);
  assert.doesNotMatch(content, /WMA|574d42|WMC/);
  assert.match(content, /\(Body\) Tj/);
  assert.ok(balanced(content));
});

for (const withL of [false, true]) {
  test(`an inline image whose data holds "EI" ${withL ? 'with' : 'without'} /L ends at its real EI`, async () => {
    const img = `BI /W 10 /H 1 /BPC 8 /CS /G${withL ? ' /L 10' : ''} ID xx\nEI Q zz EI`;
    assert.deepEqual(ops(`q ${img} Q`), ['q', 'BI', 'Q']);
    const src = await pagesOf(`q ${WM} q 50 0 0 50 0 0 cm ${img} Q EMC Q BT /F1 12 Tf 50 700 Td (Body) Tj ET`);
    assert.deepEqual((await findWatermarks(src)).other, [0]);
    const content = await pageContent(await removeWatermarks(src, { other: true }), 0);
    assert.doesNotMatch(content, /zz|EI/);
    assert.ok(balanced(content), content);
    assert.match(content, /\(Body\) Tj/);
  });
}

test('an inline image EI followed by binary bytes is image data; a wrong /L leaves its span alone', async () => {
  assert.deepEqual(ops('BI /W 4 /H 1 /BPC 8 /CS /G ID \x00\nEI \x80\x81\x02 EI Q'), ['BI', 'Q']);
  const src = await pagesOf(`q ${WM} BI /W 10 /H 1 /BPC 8 /CS /G /L 4 ID xx\nEI Q zz EI Q EMC Q`);
  assert.deepEqual(await findWatermarks(src), { ash: [], other: [], annots: { count: 0, pages: [] }, skipped: 0 });
  assert.equal(await pageContent(await removeWatermarks(src, { other: true }), 0), await pageContent(src, 0));
});

test('malformed content (deep nesting, a giant token, unbalanced EMC, no EI, oversize) is skipped without throwing', async () => {
  const good = `${WM} BT /F1 30 Tf 100 400 Td (GOODWM) Tj ET EMC`;
  const bad = [
    `${WM} BT (BADWM) Tj ET EMC ${'['.repeat(200_000)}`,
    `${WM} BT (BADWM) Tj ET EMC ${'<<'.repeat(200_000)}`,
    `${WM} BT (BADWM) Tj ET EMC /${'A'.repeat(200_000)} gs`,
    `${WM} BT (BADWM) Tj ET EMC ${'9'.repeat(200_000)} w`,
    `${WM} BT (BADWM) Tj ET EMC EMC`,
    `${WM} BI /W 1 /H 1 ID xEMC`,
    `${WM} BT (BADWM) Tj ET EMC ${'0 0 m '.repeat(1_500_000)}`, // over 8 MB
  ];
  const src = await pagesOf(...bad, good);
  const found = await findWatermarks(src);
  assert.deepEqual(found, { ash: [], other: [bad.length], annots: { count: 0, pages: [] }, skipped: bad.length });
  const out = await removeWatermarks(src, { other: true });
  for (let i = 0; i < bad.length - 1; i++) assert.equal(await pageContent(out, i), bad[i], `page ${i + 1} unchanged`);
  assert.doesNotMatch(await pageContent(out, bad.length), /GOODWM/, 'the rest is still checked and cleaned');
});
