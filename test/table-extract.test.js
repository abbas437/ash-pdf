import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textItems, extractTable, extractLayout, cellValue, rulesFromOps, pageBox, imagesFromOps, placeImages, rgbaPixels, COL_PX, ROW_PX } from '../renderer/ui/table-extract.js';

// Helvetica-ish widths: 0.5 x size per character, word space 0.28 x size.
const word = (str, x, y, size = 10) => ({ str, x, y, w: str.length * size * 0.5, size });
const phrase = (str, x, y, size = 10) => { // one item per word, as many PDF producers emit
  const out = [];
  for (const wd of str.split(' ')) { out.push(word(wd, x, y, size)); x += wd.length * size * 0.5 + size * 0.28; }
  return out;
};

test('extractTable: a 3x4 table -> 3 rows x 4 columns, numbers typed, a two-word cell kept together', () => {
  const xs = [72, 172, 272, 372];
  const rows = [
    ['Item', 'Qty', 'Price', 'Total'],
    ['Net amount', '2', '1,234.50', '2,469'],
    ['Pump', '10', '.75', '-7.5'],
  ];
  const items = rows.flatMap((r, i) => r.flatMap((c, j) => phrase(c, xs[j], 700 - i * 20 + (j % 2) * 1.5)));
  assert.deepEqual(extractTable(items), [
    ['Item', 'Qty', 'Price', 'Total'],
    ['Net amount', 2, 1234.5, 2469],
    ['Pump', 10, 0.75, -7.5],
  ]);
});

test('extractTable: a title row does not fuse the columns; a missing cell is null', () => {
  const items = [
    ...phrase('Quarterly pump schedule for site', 72, 760),
    word('A', 72, 700), word('B', 172, 700), word('C', 272, 700),
    word('x', 72, 680), word('z', 272, 680),
  ];
  assert.deepEqual(extractTable(items), [
    ['Quarterly pump schedule for site', null, null],
    ['A', 'B', 'C'],
    ['x', null, 'z'],
  ]);
});

test('cellValue: only plain numbers become numbers', () => {
  assert.equal(cellValue(' 1,234,567.25 '), 1234567.25);
  assert.equal(cellValue('42'), 42);
  for (const s of ['12,34', '1.2.3', 'SAR 5', '2026-10-07', '-', '.', '1,2345']) assert.equal(cellValue(s), s);
  assert.equal(cellValue('  '), null);
});

test('textItems: pdf.js items -> positioned items, blanks dropped', () => {
  const content = { items: [
    { str: 'Hi', transform: [12, 0, 0, 12, 50, 600], width: 11 },
    { str: ' ', transform: [12, 0, 0, 12, 61, 600], width: 3 },
    { type: 'beginMarkedContent' },
  ] };
  assert.deepEqual(textItems(content), [{ str: 'Hi', x: 50, y: 600, w: 11, size: 12 }]);
  assert.deepEqual(extractTable([]), []);
});

// The owner's report page: prose rows (a left label + a sentence across the page), a blank gap, an
// 8-column table of counts (numbers right-aligned in their columns), a Total row and a note line.
const OWNER_COLS = [72, 150, 200, 250, 300, 350, 400, 480];
const OWNER_HEAD = ['Discipline', 'Code B', 'Code C', 'Code D', 'Total', 'Major', 'Docs reviewed', 'Docs coded C/D'];
const OWNER_DATA = [
  'Architecture', 'Civil', 'Structural', 'Electrical', 'Mechanical', 'HVAC', 'Plumbing', 'Fire Fighting', 'Fire Alarm',
  'Process', 'Instruments', 'Telecom', 'Security', 'Landscape', 'Roads', 'Geotechnical', 'Survey', 'Environment', 'General',
].map((name, i) => (name === 'Electrical' ? [name, 6, 27, 1, 34, 28, 4, 4] : [name, 5 + i, 12 + i, i % 3, 17 + 2 * i, i, 2 + i, 1 + (i % 4)]));
const OWNER_TOTAL = ['Total', 124, 183, 26, 333, 209, 88, 71];
const PROSE1 = ['G-01 / G-02', 'Status and maturity: content is concept-level and several sections are placeholders.'];
const PROSE2 = ['•', 'Comment count by discipline and review code for the documents reviewed this period.'];
const NOTE = 'Note: Code C/D counts include documents resubmitted under Rev.01 and Rev.02 in this cycle.';
const ownerItems = (header = [OWNER_HEAD]) => {
  const items = [...phrase(PROSE1[0], 72, 760), ...phrase(PROSE1[1], 150, 760), word(PROSE2[0], 72, 746), ...phrase(PROSE2[1], 86, 746)];
  let y = 700;
  for (const h of header) { h.forEach((c, j) => c && items.push(...phrase(c, OWNER_COLS[j], y))); y -= 14; }
  for (const row of [...OWNER_DATA, OWNER_TOTAL]) {
    row.forEach((v, j) => {
      if (j === 0) items.push(...phrase(v, OWNER_COLS[0], y));
      else items.push(word(String(v), OWNER_COLS[j] + 30 - String(v).length * 5, y)); // right-aligned
    });
    y -= 14;
  }
  items.push(...phrase(NOTE, 72, y - 6));
  return { items, bottom: y };
};
const pad = (r) => [...r, ...Array(8 - r.length).fill(null)];

test('extractTable: prose rows with a full-width sentence do not fuse the table columns (owner report page)', () => {
  const out = extractTable(ownerItems().items);
  assert.deepEqual(out, [
    pad(PROSE1), pad(PROSE2), pad([]),
    OWNER_HEAD, ...OWNER_DATA, OWNER_TOTAL,
    pad([NOTE]),
  ]);
  assert.deepEqual(out.find((r) => r[0] === 'Electrical'), ['Electrical', 6, 27, 1, 34, 28, 4, 4]);
});

test('extractTable: without rules a header wrapped onto two lines stays two rows', () => {
  const wrapped = [['Discipline', 'Code B', 'Code C', 'Code D', 'Total', 'Major', 'Docs', 'Docs coded'], [null, null, null, null, null, null, 'reviewed', 'C/D']];
  const out = extractTable(ownerItems(wrapped).items);
  assert.deepEqual(out.slice(3, 6), [wrapped[0], wrapped[1], OWNER_DATA[0]]);
});

test('extractTable: ruling lines give the columns and join a header cell wrapped onto two lines', () => {
  const wrapped = [['Discipline', 'Code B', 'Code C', 'Code D', 'Total', 'Major', 'Docs', 'Docs coded'], [null, null, null, null, null, null, 'reviewed', 'C/D']];
  const { items, bottom } = ownerItems(wrapped);
  const top = 712, rowsBottom = bottom + 10; // cells span baseline - 4 .. baseline + 10
  const xs = [66, 145, 195, 245, 295, 345, 395, 475, 550];
  const rules = {
    vertical: xs.map((x) => ({ x, y0: rowsBottom, y1: top })),
    // a rule above the header, under the two header lines, and under every body row
    horizontal: [top, 682, ...Array.from({ length: 20 }, (_, k) => 682 - 14 * (k + 1))].map((y) => ({ y, x0: 66, x1: 550 })),
  };
  const out = extractTable(items, rules);
  assert.deepEqual(out, [
    pad(PROSE1), pad(PROSE2), pad([]),
    [...OWNER_HEAD.slice(0, 6), 'Docs reviewed', 'Docs coded C/D'], ...OWNER_DATA, OWNER_TOTAL,
    pad([NOTE]),
  ]);
});

test('rulesFromOps: stroked segments and thin filled rectangles become rules, through cm and save/restore', () => {
  const OPS = { save: 10, restore: 11, transform: 12, stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28, constructPath: 91, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75 };
  const path = (...d) => [new Float32Array(d)];
  const ops = [
    [OPS.save], [OPS.transform, [1, 0, 0, 1, 100, 0]],
    [OPS.constructPath, [OPS.stroke, path(0, 0, 500, 1, 0, 600), null]], // vertical line x=100
    [OPS.restore],
    [OPS.constructPath, [OPS.fill, path(0, 50, 400, 1, 250, 400, 1, 250, 400.5, 1, 50, 400.5, 4), null]], // thin rect -> horizontal
    [OPS.constructPath, [OPS.fill, path(0, 50, 50, 1, 150, 50, 1, 150, 150, 1, 50, 150, 4), null]], // shading box: ignored
    [OPS.constructPath, [OPS.stroke, path(0, 0, 0, 2, 10, 10, 20, 20, 30, 0), null]], // curve: ignored
    [OPS.constructPath, [OPS.endPath, path(0, 300, 0, 1, 300, 700), null]], // clip path: ignored
  ];
  const r = rulesFromOps({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1] ?? null) }, OPS);
  assert.deepEqual(r.vertical, [{ x: 100, y0: 500, y1: 600 }]);
  assert.deepEqual(r.horizontal, [{ y: 400.25, x0: 50, x1: 250 }]);
});

// ---------------------------------------------------------------- images
const IOPS = { save: 10, restore: 11, transform: 12, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, paintImageXObject: 85, paintInlineImageXObject: 86 };
// save, cm [w 0 0 h x y], paintImageXObject, restore: an image w x h pt with its lower-left corner at (x, y) in PDF user space.
const imageOps = (...imgs) => {
  const fnArray = [], argsArray = [];
  for (const [id, px, cm] of imgs) {
    fnArray.push(IOPS.save, IOPS.transform, IOPS.paintImageXObject, IOPS.restore);
    argsArray.push(null, cm, [id, px[0], px[1]], null);
  }
  return { fnArray, argsArray };
};

test('imagesFromOps: save/cm/paintImageXObject/restore -> the image box on the displayed page (y down)', () => {
  const ops = imageOps(['img_p0_1', [200, 100], [100, 0, 0, 50, 72, 600]], ['img_p0_2', [64, 64], [40, 0, 0, 40, 300, 100]]);
  const got = imagesFromOps(ops, IOPS, pageBox([0, 0, 612, 792], 0));
  assert.deepEqual(got, [
    { id: 'img_p0_1', width: 200, height: 100, box: { left: 72, top: 142, right: 172, bottom: 192 } },
    { id: 'img_p0_2', width: 64, height: 64, box: { left: 300, top: 652, right: 340, bottom: 692 } },
  ]);
  // restore really pops: a second image after the first's restore is not scaled by the first cm
  const nested = { fnArray: [IOPS.save, IOPS.transform, IOPS.restore, IOPS.save, IOPS.transform, IOPS.paintImageXObject, IOPS.restore],
    argsArray: [null, [2, 0, 0, 2, 0, 0], null, null, [10, 0, 0, 10, 0, 0], ['x', 20, 20], null] };
  assert.deepEqual(imagesFromOps(nested, IOPS, pageBox([0, 0, 100, 100]))[0].box, { left: 0, top: 90, right: 10, bottom: 100 });
});

test('imagesFromOps: a /Rotate 90 page maps the image box into the rotated (landscape) page', () => {
  const page = pageBox([0, 0, 612, 792], 90);
  assert.equal(page.width, 792); assert.equal(page.height, 612);
  // 100 x 50 pt at (72, 600): user x -> displayed y, user y -> displayed x (pdf.js PageViewport, rotation 90)
  const [img] = imagesFromOps(imageOps(['a', [200, 100], [100, 0, 0, 50, 72, 600]]), IOPS, page);
  assert.deepEqual(img.box, { left: 600, top: 72, right: 650, bottom: 172 });
  // a view box that does not start at 0 is offset too
  assert.deepEqual(imagesFromOps(imageOps(['b', [20, 20], [10, 0, 0, 10, 50, 60]]), IOPS, pageBox([50, 60, 150, 260], 0))[0].box,
    { left: 0, top: 190, right: 10, bottom: 200 });
});

test('imagesFromOps: tiny images, images off the page, and a form matrix', () => {
  const page = pageBox([0, 0, 612, 792]);
  const ops = imageOps(['tiny', [15, 300], [100, 0, 0, 100, 72, 72]], ['off', [100, 100], [50, 0, 0, 50, 700, 100]],
    ['below', [100, 100], [50, 0, 0, 50, 100, -60]]);
  assert.deepEqual(imagesFromOps(ops, IOPS, page), []);
  const form = { fnArray: [IOPS.paintFormXObjectBegin, IOPS.transform, IOPS.paintInlineImageXObject, IOPS.paintFormXObjectEnd],
    argsArray: [[[1, 0, 0, 1, 100, 100], null], [20, 0, 0, 20, 0, 0], [{ width: 32, height: 32, kind: 3 }], null] };
  const [img] = imagesFromOps(form, IOPS, page);
  assert.deepEqual(img.box, { left: 100, top: 672, right: 120, bottom: 692 });
  assert.equal(img.data.width, 32);
});

test('placeImages: an image goes to the sheet row after the text rows above it, column by its left edge', () => {
  // A paragraph line (row 0), a blank row between blocks (1), a 3-row table (2-4), a note (5): baselines, displayed y.
  const rowTops = [92, null, 300, 320, 340, 400];
  const pageWidth = 612; // 8 columns at least -> 512 px for the page width
  const scale = (8 * COL_PX) / pageWidth;
  const [between, below, top] = placeImages([
    { left: 72, top: 120, right: 172, bottom: 170 },  // under the paragraph, above the table
    { left: 306, top: 420, right: 406, bottom: 470 }, // under the note
    { left: 0, top: 10, right: 50, bottom: 40 },      // above everything
  ], rowTops, pageWidth, 4);
  assert.equal(between.row, 1); // after row 0 (the blank separator sits at y 196, below the image's top)
  assert.ok(Math.abs(between.col - (72 * scale) / COL_PX) < 1e-9);
  assert.equal(between.width, Math.round(100 * scale));
  assert.equal(between.height, Math.round(50 * scale));
  assert.equal(below.row, 6);
  assert.ok(Math.abs(below.col - 4) < 1e-9); // the page's middle -> half of 8 columns
  assert.equal(top.row, 0);
  // more used columns -> a larger scale; very large images are capped at 1000 px
  const [wide] = placeImages([{ left: 0, top: 0, right: 612, bottom: 792 }], [], 612, 20);
  assert.equal(wide.height, 1000);
  assert.equal(wide.width, Math.round((612 / 792) * 1000));
});

test('placeImages: an image that would cover one placed before it moves below it', () => {
  const [a, b] = placeImages([{ left: 72, top: 100, right: 300, bottom: 200 }, { left: 72, top: 210, right: 300, bottom: 260 }], [50], 612, 8);
  assert.equal(a.row, 1);
  assert.equal(b.row, 1 + Math.ceil(a.height / ROW_PX));
});

test('extractLayout: each sheet row\'s position; the blank row between blocks is null; ruled lines join', () => {
  const items = [...phrase('A paragraph line that is long enough to be running text on the page', 72, 740),
    word('Qty', 72, 700), word('Price', 172, 700), word('2', 72, 680), word('3', 172, 680)];
  const { rows, at } = extractLayout(items);
  assert.deepEqual(rows, extractTable(items));
  assert.equal(rows.length, at.length);
  assert.deepEqual(at.map((p) => p?.y ?? null), [740, 700, 680]);
});

test('rgbaPixels: 1-bit, RGB and RGBA pdf.js images', () => {
  assert.deepEqual([...rgbaPixels({ width: 2, height: 1, kind: 1, data: new Uint8Array([0b10000000]) })], [255, 255, 255, 255, 0, 0, 0, 255]);
  assert.deepEqual([...rgbaPixels({ width: 1, height: 1, kind: 2, data: new Uint8Array([1, 2, 3]) })], [1, 2, 3, 255]);
  assert.deepEqual([...rgbaPixels({ width: 1, height: 1, kind: 3, data: new Uint8ClampedArray([1, 2, 3, 4]) })], [1, 2, 3, 4]);
});
