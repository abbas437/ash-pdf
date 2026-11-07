import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFHexString, PDFString, PDFNumber, decodePDFRawStream } from 'pdf-lib';
import { buildCompareReport, changeKind, LEGEND_COLORS, MARK_COLORS, MAX_TEXT_MARKS } from '../src/core/compareReport.js';
import { readAnnotations } from '../src/core/annots.js';
import { COLORS } from '../renderer/ui/compare-lib.js';
import { makeImage, pageContent, renderPage, pdfjsDoc, isColor } from './helpers.js';

const N = (s) => PDFName.of(s);
const DATE = new Date('2026-11-08T12:00:00Z');
const META = { older: { name: 'HVAC-SD-001 Rev.00.pdf' }, newer: { name: 'HVAC-SD-001 Rev.01.pdf' }, date: DATE };
const PNG = makeImage('png', 60, 80, '#ffffff');
const JPG = makeImage('jpeg', 60, 80, '#ffffff');

const page = (over = {}) => ({ width: 300, height: 400, image: { bytes: PNG, type: 'png' }, regions: [], status: 'compared', ...over });

const text = (v) => (v instanceof PDFHexString || v instanceof PDFString ? v.decodeText() : undefined);
const nums = (doc, v) => doc.context.lookup(v).asArray().map((x) => doc.context.lookup(x).asNumber());

async function annotsOf(bytes, i = 0) {
  const doc = await PDFDocument.load(bytes);
  const a = doc.getPage(i).node.Annots();
  return { doc, list: a ? a.asArray().map((r) => doc.context.lookup(r)) : [] };
}

test('changeKind: removed >= 2x added is removed, added >= 2x removed is added, else mixed', () => {
  assert.equal(changeKind({ added: 5, removed: 10 }), 'removed');
  assert.equal(changeKind({ added: 0, removed: 3 }), 'removed');
  assert.equal(changeKind({ added: 10, removed: 5 }), 'added');
  assert.equal(changeKind({ added: 9, removed: 5 }), 'mixed');
  assert.deepEqual(LEGEND_COLORS, COLORS, 'legend swatches match the composite colours of compare-lib');
});

test('loads, page count and sizes match, title and producer', async () => {
  const bytes = await buildCompareReport([page(), page({ width: 842, height: 595, image: { bytes: JPG, type: 'jpeg' } })], META);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(doc.getPageCount(), 2);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 300, height: 400 });
  assert.deepEqual(doc.getPage(1).getSize(), { width: 842, height: 595 });
  assert.equal(doc.getTitle(), 'Compare HVAC-SD-001 Rev.00.pdf to HVAC-SD-001 Rev.01.pdf');
  assert.equal(doc.getProducer(), 'ASH PDF Studio');
});

test('one dashed Square per region, colour by the added/removed rule, contents, /AP', async () => {
  const regions = [
    { x: 10, y: 20, w: 40, h: 30, added: 2, removed: 50 },
    { x: 100, y: 100, w: 20, h: 20, added: 40, removed: 1 },
    { x: 150, y: 200, w: 60, h: 10, added: 10, removed: 10 },
  ];
  const textChanges = {
    added: [{ text: 'PUMP P-101', box: { x: 102, y: 105, w: 15, h: 6 } }, { text: 'NOTE 7', box: { x: 250, y: 350, w: 20, h: 6 } }],
    removed: [{ text: 'PUMP P-100', box: { x: 12, y: 25, w: 30, h: 6 } }],
  };
  const bytes = await buildCompareReport([page({ regions, textChanges })], META);
  const { doc, list } = await annotsOf(bytes);
  assert.equal(list.length, 4, '3 regions + 1 text change outside every region');
  const want = [MARK_COLORS.removed, MARK_COLORS.added, MARK_COLORS.mixed, MARK_COLORS.added];
  assert.deepEqual(MARK_COLORS, { removed: [0.86, 0, 0], added: [0, 0.63, 0], mixed: [1, 0.55, 0] });
  const nms = new Set();
  list.forEach((d, k) => {
    assert.equal(d.lookup(N('Subtype')), N('Square'));
    const bs = d.lookup(N('BS'));
    assert.ok(bs instanceof PDFDict, 'has /BS');
    assert.equal(bs.lookup(N('S')), N('D'), `annot ${k} /BS /S /D`);
    assert.deepEqual(nums(doc, bs.get(N('D'))), [3, 2], `annot ${k} /D [3 2]`);
    assert.equal(bs.lookup(N('W')).asNumber(), 1);
    assert.deepEqual(nums(doc, d.get(N('C'))), want[k], `annot ${k} /C`);
    assert.equal(text(d.lookup(N('T'))), 'Compare');
    assert.ok(text(d.lookup(N('M'))).startsWith('D:2026'));
    nms.add(text(d.lookup(N('NM'))));
    const ap = d.lookup(N('AP'));
    const form = doc.context.lookup(ap.get(N('N')));
    assert.ok(form instanceof PDFRawStream, `annot ${k} /AP /N stream`);
    const ops = Buffer.from(decodePDFRawStream(form).decode()).toString('latin1');
    assert.match(ops, /\[3 2\] 0 d/);
    assert.match(ops, / re S/);
  });
  assert.equal(nms.size, 4, '/NM unique');
  const contents = list.map((d) => text(d.lookup(N('Contents'))));
  assert.equal(contents[0], 'Change 1: removed\nText: removed "PUMP P-100"');
  assert.equal(contents[1], 'Change 2: added\nText: added "PUMP P-101"');
  assert.equal(contents[2], 'Change 3: added and removed');
  assert.equal(contents[3], 'Change 4: text added\nText: "NOTE 7"');
  // Rect: the region (top-left points) padded by 2 pt, in PDF space.
  assert.deepEqual(nums(doc, list[0].get(N('Rect'))), [8, 400 - 52, 52, 400 - 18]);
});

test('legend text is in the content stream; a non-Latin file name does not throw', async () => {
  const bytes = await buildCompareReport([page({ width: 595, height: 842, regions: [{ x: 10, y: 200, w: 10, h: 10, added: 5, removed: 0 }] })], META);
  const content = await pageContent(bytes, 0);
  const shown = [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
  for (const s of ['Compare: HVAC-SD-001 Rev.00.pdf ', '\xae', ' HVAC-SD-001 Rev.01.pdf \xb7 2026-11-08', 'unchanged', 'removed', 'added']) assert.ok(shown.includes(s), `legend shows ${JSON.stringify(s)}: ${shown}`);
  assert.match(content, /\/Helvetica-\d+ 7\.5 Tf/);
  assert.match(content, /\/Symbol-\d+ 7\.5 Tf\n(?:(?!Tf)[^])*?<AE> Tj/, 'the arrow is the Symbol font');

  // a narrow page shortens the names to fit
  const narrow = { ...META, older: { name: `${'X'.repeat(120)}.pdf` } };
  const tight = [...(await pageContent(await buildCompareReport([page()], narrow), 0)).matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
  assert.ok(tight.includes('X\x85 ') && !tight.includes('X'.repeat(120)), tight);

  const arabic = { older: { name: 'مخطط Rev.00.pdf' }, newer: { name: 'رسم 图 Rev.01.pdf' }, date: DATE };
  const b2 = await buildCompareReport([page()], arabic);
  const shown2 = [...(await pageContent(b2, 0)).matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
  assert.ok(shown2.includes('???? Rev.00.pdf'), shown2);
  const doc2 = await PDFDocument.load(b2, { updateMetadata: false });
  assert.equal(doc2.getTitle(), 'Compare مخطط Rev.00.pdf to رسم 图 Rev.01.pdf', 'the title keeps the Unicode names');
});

test('added/removed status pages carry their note', async () => {
  const bytes = await buildCompareReport([page({ status: 'added' }), page({ status: 'removed' }), page()], META);
  const tj = async (i) => [...(await pageContent(bytes, i)).matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('|');
  assert.ok((await tj(0)).includes('Page only in the newer revision'));
  assert.ok((await tj(1)).includes('Page only in the older revision'));
  assert.ok(!(await tj(2)).includes('Page only'));
});

test('source page numbers: bookmarks are named by them and the legend says "Page 5 of <newer>"', async () => {
  const r = [{ x: 10, y: 300, w: 10, h: 10, added: 3, removed: 0 }];
  const bytes = await buildCompareReport([page({ regions: r, newerPage: 5, olderPage: 5 }), page({ regions: r, newerPage: 6, olderPage: 4 }), page({ status: 'removed', olderPage: 7, newerPage: null })], META);
  const doc = await PDFDocument.load(bytes);
  const items = [];
  for (let ref = doc.catalog.lookup(N('Outlines')).get(N('First')); ref; ref = doc.context.lookup(ref).get(N('Next'))) items.push(doc.context.lookup(ref));
  assert.deepEqual(items.map((d) => text(d.lookup(N('Title')))), ['Page 5 – 1 change', 'Page 6 (older 4) – 1 change', 'Older page 7 – only in the older revision']);
  const tj = async (i) => [...(await pageContent(bytes, i)).matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('|');
  assert.ok((await tj(0)).includes('Page 5 of HVAC-SD-001 Rev.01.pdf'), await tj(0));
  assert.ok((await tj(1)).includes('Page 6 of HVAC-SD-001 Rev.01.pdf, page 4 of HVAC-SD-001 Rev.00.pdf'), await tj(1));
  assert.ok((await tj(2)).includes('Page 7 of HVAC-SD-001 Rev.00.pdf'), await tj(2));
});

test('bookmarks: one per page with changes', async () => {
  const r = (n) => Array.from({ length: n }, (_, k) => ({ x: 10 + 20 * k, y: 300, w: 10, h: 10, added: 3, removed: 0 }));
  const bytes = await buildCompareReport([page({ regions: r(1) }), page(), page({ regions: r(5) }), page({ status: 'added' })], META);
  const doc = await PDFDocument.load(bytes);
  const root = doc.catalog.lookup(N('Outlines'));
  assert.ok(root instanceof PDFDict);
  const items = [];
  for (let ref = root.get(N('First')); ref; ref = doc.context.lookup(ref).get(N('Next'))) items.push(doc.context.lookup(ref));
  assert.deepEqual(items.map((d) => text(d.lookup(N('Title')))), ['Page 1 – 1 change', 'Page 3 – 5 changes', 'Page 4 – only in the newer revision']);
  const pages = doc.getPages();
  assert.deepEqual(items.map((d) => pages.findIndex((p) => p.ref === d.lookup(N('Dest')).get(0))), [0, 2, 3]);
  assert.equal(root.lookup(N('Count')).asNumber(), 3);
  // pdf.js reads the outline
  const js = await pdfjsDoc(bytes);
  assert.deepEqual((await js.getOutline()).map((o) => o.title), ['Page 1 – 1 change', 'Page 3 – 5 changes', 'Page 4 – only in the newer revision']);
  await js.close();
});

test('text changes outside regions are bounded per page and the rest summarised', async () => {
  const many = Array.from({ length: MAX_TEXT_MARKS + 7 }, (_, k) => ({ text: `w${k}`, box: { x: (k % 20) * 14, y: 100 + Math.floor(k / 20) * 12, w: 10, h: 6 } }));
  const bytes = await buildCompareReport([page({ textChanges: { added: many, removed: [] } })], META);
  const { list } = await annotsOf(bytes);
  assert.equal(list.length, MAX_TEXT_MARKS);
  assert.ok((await pageContent(bytes, 0)).includes(Buffer.from('7 more text changes on this page not marked', 'latin1').toString('hex').toUpperCase()));
});

test('readAnnotations reads the squares back as editable dashed rectangles', async () => {
  const bytes = await buildCompareReport([page({ regions: [{ x: 10, y: 20, w: 40, h: 30, added: 2, removed: 50 }, { x: 100, y: 100, w: 20, h: 20, added: 40, removed: 1 }] })], META);
  const { objects, skipped } = await readAnnotations(bytes);
  assert.equal(skipped.length, 0);
  assert.equal(objects.length, 2);
  const [a, b] = objects;
  assert.equal(a.type, 'rect');
  assert.equal(a.dash, 'dashed');
  assert.equal(a.stroke, '#db0000');
  assert.equal(b.stroke, '#00a100');
  assert.equal(a.strokeWidth, 1);
  assert.equal(a.note, 'Change 1: removed');
  assert.equal(a.author, 'Compare');
  // geometry: the padded region, inset by half the border width
  assert.deepEqual([a.x, a.y, a.w, a.h], [8.5, 18.5, 43, 33]);
});

test('renders through pdf.js: image, legend box and dashed rectangle', async () => {
  const red = makeImage('png', 300, 400, '#ff00ff');
  const bytes = await buildCompareReport([page({ image: { bytes: red, type: 'png' }, regions: [{ x: 100, y: 200, w: 60, h: 40, added: 0, removed: 9 }] })], META);
  const js = await pdfjsDoc(bytes);
  const anns = await (await js.getPage(1)).getAnnotations();
  await js.close();
  assert.equal(anns.filter((x) => x.subtype === 'Square').length, 1);
  const { sample } = await renderPage(bytes, 0, 4);
  assert.ok(isColor(sample(250, 300), [255, 0, 255]), 'image drawn full page');
  assert.ok(isColor(sample(7.5, 8.5), [255, 255, 255], 20), 'legend box is white');
  // bottom edge of the rectangle: y = 241.5 (region bottom + 2 pad - half the border); its first dash covers x 98.5..101.5
  const edge = sample(100, 241.5);
  assert.ok(isColor(edge, [219, 0, 0], 60), `dashed border drawn: ${edge}`);
});

test('a 30-page report builds in reasonable time', async () => {
  const img = makeImage('png', 600, 800, '#ffffff');
  const regions = Array.from({ length: 20 }, (_, k) => ({ x: 10 + k * 14, y: 50, w: 10, h: 10, added: k, removed: 20 - k }));
  const pages = Array.from({ length: 30 }, () => page({ width: 595, height: 842, image: { bytes: img, type: 'png' }, regions }));
  const t0 = performance.now();
  const bytes = await buildCompareReport(pages, META);
  const ms = performance.now() - t0;
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 30);
  assert.ok(ms < 15000, `built in ${Math.round(ms)} ms`);
});

test('bad input is rejected at the boundary', async () => {
  await assert.rejects(buildCompareReport([], META), TypeError);
  await assert.rejects(buildCompareReport([page({ width: 0 })], META), RangeError);
  await assert.rejects(buildCompareReport([page({ image: { bytes: PNG, type: 'gif' } })], META), TypeError);
});
