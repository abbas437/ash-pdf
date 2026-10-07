import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFArray, PDFHexString } from 'pdf-lib';
import { writeAnnotations, readAnnotations, flattenAnnotations } from '../src/core/annots.js';
import { makePdf, makeGeometryFixture, makeImage, near, pdfjsDoc, renderPage, isColor } from './helpers.js';

const NOW = '2026-10-07T10:00:00.000Z';
const OPTS = { author: 'Ahmad', now: NOW };

function sample(img) {
  return [
    { id: 'r', page: 0, type: 'rect', x: 40, y: 50, w: 80, h: 30, stroke: '#ff0000', fill: '#00ff00', strokeWidth: 2, dash: 'dotted', opacity: 0.8, note: 'check', replies: [{ id: 'r-1', author: 'Bob', date: '2026-10-07T11:00:00.000Z', text: 'Agreed' }], status: 'accepted' },
    { id: 'e', page: 0, type: 'ellipse', x: 150, y: 50, w: 60, h: 40, stroke: '#0000ff', strokeWidth: 1.5 },
    { id: 'l', page: 0, type: 'line', x1: 20, y1: 120, x2: 200, y2: 140, stroke: '#123456', strokeWidth: 3, dash: 'dashed' },
    { id: 'a', page: 0, type: 'arrow', x1: 30, y1: 160, x2: 120, y2: 220, stroke: '#ff00ff', strokeWidth: 2 },
    { id: 'i', page: 0, type: 'ink', points: [[30, 240], [60, 260], [90, 245], [120, 270]], stroke: '#0000ff', strokeWidth: 2, smooth: true },
    { id: 't', page: 0, type: 'text', x: 150, y: 120, w: 120, h: 30, text: 'Hello box', fontSize: 14, font: 'Times', bold: true, color: '#333333' },
    { id: 'c', page: 0, type: 'callout', x: 150, y: 170, w: 100, h: 40, text: 'See this', tx: 300, ty: 260, stroke: '#ff0000', fill: '#ffffff' },
    { id: 's', page: 0, type: 'stamp', x: 200, y: 300, w: 120, h: 40, text: 'APPROVED', color: '#c00000', rotation: 15 },
    { id: 'im', page: 0, type: 'image', x: 40, y: 300, w: 40, h: 20, bytes: img, mime: 'image/png' },
    { id: 'h', page: 0, type: 'highlight', x: 40, y: 350, w: 100, h: 14, color: '#ffff00' },
    { id: 'n', page: 0, type: 'note', x: 260, y: 40, icon: 'Comment', color: '#ffd400', note: 'Sticky text' },
    { id: 'u', page: 0, type: 'underline', quads: [[40, 380, 140, 380, 40, 394, 140, 394]], color: '#00a000' },
    { id: 'so', page: 0, type: 'strikeout', quads: [[40, 400, 140, 400, 40, 414, 140, 414]], color: '#e00000' },
    { id: 'sq', page: 0, type: 'squiggly', quads: [[40, 420, 140, 420, 40, 434, 140, 434]] },
    { id: 'th', page: 0, type: 'textHighlight', quads: [[40, 440, 140, 440, 40, 454, 140, 454], [40, 456, 90, 456, 40, 470, 90, 470]] },
  ];
}

const GEOM = { rect: ['x', 'y', 'w', 'h'], ellipse: ['x', 'y', 'w', 'h'], text: ['x', 'y', 'w', 'h'], callout: ['x', 'y', 'w', 'h', 'tx', 'ty'], stamp: ['x', 'y', 'w', 'h', 'rotation'], image: ['x', 'y', 'w', 'h'], highlight: ['x', 'y', 'w', 'h'], note: ['x', 'y'], line: ['x1', 'y1', 'x2', 'y2'], arrow: ['x1', 'y1', 'x2', 'y2'] };

function sameGeometry(got, want, label) {
  for (const k of GEOM[want.type] ?? []) near(got[k], want[k], 0.01, `${label} ${k}`);
  if (want.points) want.points.forEach((p, i) => { near(got.points[i][0], p[0], 0.01, `${label} pt${i}x`); near(got.points[i][1], p[1], 0.01, `${label} pt${i}y`); });
  if (want.quads) {
    assert.equal(got.quads.length, want.quads.length, `${label} quad count`);
    want.quads.forEach((q, i) => q.forEach((v, k) => near(got.quads[i][k], v, 0.01, `${label} quad${i}[${k}]`)));
  }
}

function annotDicts(doc, pageIndex = 0) {
  const arr = doc.getPage(pageIndex).node.Annots();
  return arr ? arr.asArray().map((r) => doc.context.lookup(r)) : [];
}

describe('writeAnnotations / readAnnotations round trip', () => {
  for (const [label, makeSrc] of [['plain Letter page', () => makePdf(1)], ...[0, 90, 180, 270].map((r) => [`CropBox offset, /Rotate ${r}`, () => makeGeometryFixture(r)])]) {
    test(`every type survives write -> read (${label})`, async () => {
      const objs = sample(makeImage('png'));
      const out = await writeAnnotations(await makeSrc(), { add: objs }, OPTS);
      const { objects, skipped } = await readAnnotations(out);
      assert.deepEqual(skipped, []);
      assert.equal(objects.length, objs.length);
      for (const want of objs) {
        const got = objects.find((o) => o.id === want.id);
        assert.ok(got, `${want.id} read back`);
        assert.equal(got.type, want.type, `${want.id} type`);
        assert.equal(got.author, 'Ahmad');
        assert.equal(got.modified, NOW);
        assert.equal(got.source.nm, want.id);
        sameGeometry(got, want, `${label} ${want.id}`);
      }
      const by = Object.fromEntries(objects.map((o) => [o.id, o]));
      assert.equal(by.r.stroke, '#ff0000');
      assert.equal(by.r.fill, '#00ff00');
      assert.equal(by.r.strokeWidth, 2);
      assert.equal(by.r.dash, 'dotted');
      near(by.r.opacity, 0.8, 1e-6, 'opacity');
      assert.equal(by.r.note, 'check');
      assert.deepEqual(by.r.replies, [{ id: 'r-1', author: 'Bob', date: '2026-10-07T11:00:00.000Z', text: 'Agreed' }]);
      assert.equal(by.r.status, 'accepted');
      assert.equal(by.l.dash, 'dashed');
      assert.equal(by.t.text, 'Hello box');
      assert.deepEqual([by.t.font, by.t.bold, by.t.fontSize, by.t.color], ['Times', true, 14, '#333333']);
      assert.equal(by.c.text, 'See this');
      assert.equal(by.s.text, 'APPROVED');
      assert.equal(by.n.note, 'Sticky text');
      assert.equal(by.n.icon, 'Comment');
      assert.deepEqual(by.im.bytes, objs.find((o) => o.id === 'im').bytes);
      assert.equal(by.u.color, '#00a000');
      assert.equal(by.i.smooth, true);
    });
  }

  test('QuadPoints are written in PDF user space (TL, TR, BL, BR)', async () => {
    const out = await writeAnnotations(await makePdf(1), { add: [{ id: 'u', page: 0, type: 'underline', quads: [[40, 380, 140, 380, 40, 394, 140, 394]] }] }, OPTS);
    const doc = await PDFDocument.load(out);
    const qp = annotDicts(doc)[0].lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map((n) => n.asNumber());
    assert.deepEqual(qp, [40, 412, 140, 412, 40, 398, 140, 398]); // 792 - y
  });

  test('whiteout is refused with BURN_IN_ONLY', async () => {
    await assert.rejects(writeAnnotations(await makePdf(1), { add: [{ id: 'w', page: 0, type: 'whiteout', x: 0, y: 0, w: 5, h: 5 }] }), { code: 'BURN_IN_ONLY' });
  });
});

/** Foreign annotations built with pdf-lib low level: no /NM, no /AP, plus a Link and a Widget. */
async function foreignPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const sq = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 600, 200, 700], C: [1, 0, 0], BS: { W: 2 }, T: PDFHexString.fromText('Other tool'), Contents: PDFHexString.fromText('Foreign square') }));
  const hl = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [50, 500, 150, 520], QuadPoints: [50, 520, 150, 520, 50, 500, 150, 500], C: [1, 1, 0] }));
  const reply = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [100, 600, 200, 700], IRT: sq, Contents: PDFHexString.fromText('A reply') }));
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 50, 30], Border: [0, 0, 0] }));
  const widget = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFHexString.fromText('f1'), Rect: [300, 300, 400, 320] }));
  page.node.set(PDFName.of('Annots'), ctx.obj([sq, hl, reply, link, widget]));
  return { bytes: await doc.save(), sq };
}

describe('foreign annotations', () => {
  test('read without /NM or /AP; non-markups are skipped', async () => {
    const { bytes, sq } = await foreignPdf();
    const { objects, skipped } = await readAnnotations(bytes);
    assert.deepEqual(skipped.map((s) => s.subtype).sort(), ['Link', 'Widget']);
    const rect = objects.find((o) => o.type === 'rect');
    assert.equal(rect.id, `ref-${sq.objectNumber}-0`);
    assert.equal(rect.source.nm, null);
    assert.deepEqual([rect.x, rect.y, rect.w, rect.h], [101, 93, 98, 98]);
    assert.equal(rect.stroke, '#ff0000');
    assert.equal(rect.author, 'Other tool');
    assert.equal(rect.note, 'Foreign square');
    assert.deepEqual(rect.replies.map((r) => r.text), ['A reply']);
    const th = objects.find((o) => o.type === 'textHighlight');
    assert.deepEqual(th.quads, [[50, 272, 150, 272, 50, 292, 150, 292]]);
  });

  test('updating one annotation leaves the others untouched and keeps its slot', async () => {
    const { bytes } = await foreignPdf();
    const before = await PDFDocument.load(bytes);
    const beforeDicts = annotDicts(before).map((d) => d.toString());
    const { objects } = await readAnnotations(bytes);
    const th = objects.find((o) => o.type === 'textHighlight');
    const out = await writeAnnotations(bytes, { update: [{ ...th, color: '#00ffff' }] }, OPTS);
    const after = await PDFDocument.load(out);
    const afterDicts = annotDicts(after).map((d) => d.toString());
    assert.equal(afterDicts.length, beforeDicts.length);
    for (const i of [0, 2, 3, 4]) assert.equal(afterDicts[i], beforeDicts[i], `annotation ${i} unchanged`);
    assert.notEqual(afterDicts[1], beforeDicts[1]);
    const again = await readAnnotations(out);
    assert.equal(again.objects.find((o) => o.id === th.id).color, '#00ffff');
  });

  test('remove deletes the annotation, its popup and its replies', async () => {
    const src = await writeAnnotations(await makePdf(1), { add: sample(makeImage('png')).filter((o) => ['n', 'r', 'e'].includes(o.id)) }, OPTS);
    const n0 = annotDicts(await PDFDocument.load(src)).length;
    let out = await writeAnnotations(src, { remove: ['n'] }, OPTS);
    let dicts = annotDicts(await PDFDocument.load(out));
    assert.equal(dicts.length, n0 - 2);
    assert.ok(!dicts.some((d) => d.get(PDFName.of('Subtype')) === PDFName.of('Popup')));
    out = await writeAnnotations(out, { remove: ['r'] }, OPTS);
    dicts = annotDicts(await PDFDocument.load(out));
    assert.equal(dicts.length, 1);
    const { objects } = await readAnnotations(out);
    assert.deepEqual(objects.map((o) => o.id), ['e']);
    await assert.rejects(writeAnnotations(out, { remove: ['nope'] }), { code: 'ANNOT_NOT_FOUND' });
  });
});

describe('pdf.js sees the written annotations', () => {
  test('subtypes, refs, appearances, replies and state', async () => {
    const objs = sample(makeImage('png'));
    const out = await writeAnnotations(await makePdf(1), { add: objs }, OPTS);
    const { objects } = await readAnnotations(out);
    const doc = await pdfjsDoc(out);
    const annots = await (await doc.getPage(1)).getAnnotations();
    await doc.close();
    const byRef = new Map(annots.map((a) => [a.id, a]));
    const SUB = { rect: 'Square', ellipse: 'Circle', line: 'Line', arrow: 'Line', ink: 'Ink', text: 'FreeText', callout: 'FreeText', stamp: 'Stamp', image: 'Stamp', highlight: 'Highlight', note: 'Text', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly', textHighlight: 'Highlight' };
    for (const o of objects) {
      const a = byRef.get(o.source.ref.replace(/ 0$/, 'R'));
      assert.ok(a, `pdf.js lists ${o.id}`);
      assert.equal(a.subtype, SUB[o.type], `${o.id} subtype`);
      assert.ok(a.hasAppearance, `${o.id} has an appearance`);
    }
    const parent = byRef.get(objects.find((o) => o.id === 'r').source.ref.replace(/ 0$/, 'R'));
    const kids = annots.filter((a) => a.inReplyTo === parent.id);
    assert.deepEqual(kids.map((k) => k.state ?? null).sort(), ['Accepted', null].sort());
    assert.ok(annots.some((a) => a.subtype === 'Popup'));
  });
});


// ---------------------------------------------------------------- flattenAnnotations and edge cases

const RED = [255, 0, 0];
const WHITE = [255, 255, 255];

async function annotCount(bytes, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  return annotDicts(doc, pageIndex).length;
}

async function opsOf(bytes, pageIndex = 0) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsDoc(bytes);
  const ol = await (await doc.getPage(pageIndex + 1)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
  await doc.close();
  return { fn: ol.fnArray, OPS: pdfjs.OPS };
}

/** Page with hand-made foreign annotations: rotated-Matrix AP, /AS state dict, direct (non-ref) dict, Link, Widget. */
async function foreignFlattenFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const blue = (bbox, matrix) => ctx.register(ctx.stream(`0 0 1 rg ${bbox.join(' ')} re f`, { Type: 'XObject', Subtype: 'Form', BBox: bbox, ...(matrix ? { Matrix: matrix } : {}) }));
  // BBox [0 0 20 10] rotated 90deg by /Matrix -> transformed box x[-10,0] y[0,20]; must fill /Rect [100 400 200 600]
  const sq = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 400, 200, 600], NM: PDFHexString.fromText('rot'), AP: { N: blue([0, 0, 20, 10], [0, 1, -1, 0, 0, 0]) } }));
  const off = ctx.register(ctx.stream('1 0 0 rg 0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
  const st = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [300, 400, 350, 450], NM: PDFHexString.fromText('state'), AS: 'On', AP: { N: { On: blue([0, 0, 10, 10]), Off: off } } }));
  const direct = ctx.obj({ Type: 'Annot', Subtype: 'Circle', Rect: [400, 100, 450, 150], AP: { N: blue([0, 0, 50, 50]) } });
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], Border: [0, 0, 0] }));
  const widget = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Btn', T: PDFHexString.fromText('w'), Rect: [10, 700, 60, 730] }));
  page.node.set(PDFName.of('Annots'), ctx.obj([sq, st, direct, link, widget]));
  return doc.save();
}

describe('flattenAnnotations', () => {
  test('rotated page: appearance burned in at the same place, annotation + popup + replies + status removed', async () => {
    const src = await makeGeometryFixture(90);
    const objs = [
      { id: 'r', page: 0, type: 'rect', x: 40, y: 50, w: 80, h: 30, stroke: '#ff0000', fill: '#ff0000', strokeWidth: 2, replies: [{ id: 'r-1', author: 'Bob', text: 'ok' }], status: 'rejected' },
      { id: 'n', page: 0, type: 'note', x: 200, y: 200, note: 'hi' },
    ];
    const written = await writeAnnotations(src, { add: objs }, OPTS);
    assert.equal(await annotCount(written), 4 + 1, 'rect, reply, status, note, popup');
    const before = await renderPage(written);
    assert.ok(isColor(before.sample(80, 65), RED), 'annotation renders red before flattening');
    const out = await flattenAnnotations(written);
    assert.equal(await annotCount(out), 0);
    assert.deepEqual(await readAnnotations(out), { objects: [], skipped: [] });
    const after = await renderPage(out);
    assert.ok(isColor(after.sample(80, 65), RED), 'burned-in content renders red at the same visible spot');
    assert.ok(isColor(after.sample(80, 150), WHITE), 'nothing outside the box');
    const { fn, OPS } = await opsOf(out);
    assert.ok(fn.includes(OPS.paintFormXObjectBegin), 'page content paints the appearance XObject');
  });

  test('BBox x Matrix is mapped onto /Rect; /AS state; direct dicts; Link and Widget untouched', async () => {
    const out = await flattenAnnotations(await foreignFlattenFixture());
    const doc = await PDFDocument.load(out);
    assert.deepEqual(annotDicts(doc).map((d) => d.lookup(PDFName.of('Subtype')).decodeText()), ['Link', 'Widget']);
    const px = await renderPage(out);
    const BLUE = [0, 0, 255];
    for (const [x, y] of [[105, 792 - 405], [195, 792 - 595], [150, 792 - 500]]) assert.ok(isColor(px.sample(x, y), BLUE), `rotated AP fills Rect at ${x},${y}`);
    assert.ok(isColor(px.sample(150, 792 - 620), WHITE), 'nothing above Rect');
    assert.ok(isColor(px.sample(325, 792 - 425), BLUE), '/AS /On state drawn, not /Off');
    assert.ok(isColor(px.sample(425, 792 - 125), BLUE), 'direct annotation dict flattened');
  });

  test('pages and ids select what is flattened', async () => {
    const src = await makePdf(2);
    const box = (id, page, x) => ({ id, page, type: 'rect', x, y: 50, w: 40, h: 40, stroke: '#ff0000' });
    const written = await writeAnnotations(src, { add: [box('a', 0, 40), box('b', 0, 140), box('c', 1, 40)] }, OPTS);
    const byPage = await flattenAnnotations(written, { pages: [1] });
    assert.deepEqual((await readAnnotations(byPage)).objects.map((o) => o.id).sort(), ['a', 'b']);
    const byId = await flattenAnnotations(written, { ids: ['b'] });
    assert.deepEqual((await readAnnotations(byId)).objects.map((o) => o.id).sort(), ['a', 'c']);
    assert.equal(await flattenAnnotations(written, { ids: ['nope'] }), written, 'nothing selected -> input returned');
  });
});

describe('writeAnnotations edge cases', () => {
  for (const status of ['rejected', 'cancelled', 'completed', 'none']) {
    test(`status "${status}" round trips`, async () => {
      const out = await writeAnnotations(await makePdf(1), { add: [{ id: 'r', page: 0, type: 'rect', x: 10, y: 10, w: 20, h: 20, status }] }, OPTS);
      const [o] = (await readAnnotations(out)).objects;
      assert.equal(o.status, status);
    });
  }

  test('multi-stroke ink keeps every stroke (write, read, appearance)', async () => {
    const paths = [[[30, 40], [80, 40]], [[30, 90], [80, 90], [80, 130]]];
    const out = await writeAnnotations(await makePdf(1), { add: [{ id: 'k', page: 0, type: 'ink', points: paths[0], paths, stroke: '#ff0000', strokeWidth: 4 }] }, OPTS);
    const [o] = (await readAnnotations(out)).objects;
    assert.equal(o.paths.length, 2);
    paths.forEach((p, i) => p.forEach(([x, y], k) => { near(o.paths[i][k][0], x, 0.01, `s${i}p${k}x`); near(o.paths[i][k][1], y, 0.01, `s${i}p${k}y`); }));
    const flat = await renderPage(await flattenAnnotations(out));
    assert.ok(isColor(flat.sample(55, 40), RED), 'stroke 1 drawn');
    assert.ok(isColor(flat.sample(80, 110), RED), 'stroke 2 drawn');
  });

  test('a direct (non-reference) annotation dict is read and can be updated and removed', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 200, 150], C: [1, 0, 0], NM: PDFHexString.fromText('d') })]));
    const src = await doc.save();
    const [o] = (await readAnnotations(src)).objects;
    assert.equal(o.id, 'd');
    assert.equal(o.source.ref, null);
    const upd = await writeAnnotations(src, { update: [{ ...o, w: 10 }] }, OPTS);
    const back = (await readAnnotations(upd)).objects;
    assert.equal(back.length, 1);
    near(back[0].w, 10, 0.01, 'updated width');
    assert.equal(await annotCount(await writeAnnotations(src, { remove: ['d'] }, OPTS)), 0);
  });
});
