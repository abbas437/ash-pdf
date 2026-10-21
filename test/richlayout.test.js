import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';
import { layoutRich, measureText, flattenObjects, writeAnnotations } from '../src/core/index.js';
import { makePdf, pageContent, near } from './helpers.js';

const lineText = (l) => l.fragments.map((f) => f.text).join('');

test('layoutRich without runs gives exactly measureText wrapping, baselines, width and height', () => {
  const cases = [
    ['Hello world', 200], ['The quick brown fox jumps over the lazy dog', 80], ['  leading spaces and trailing  ', 60],
    ['Supercalifragilisticexpialidocious', 40], ['one\n\ntwo three four\n', 50], ['', 30], ['tight', undefined],
  ];
  for (const [text, maxWidth] of cases) {
    for (const style of [{}, { font: 'Times', bold: true, fontSize: 15, lineHeight: 1.5 }, { font: 'Courier', italic: true, fontSize: 9 }]) {
      const o = { type: 'text', text, ...style };
      const m = measureText(text, { ...style, maxWidth });
      const L = layoutRich(o, maxWidth);
      assert.deepEqual(L.lines.map(lineText), m.lines, `${text} lines`);
      assert.deepEqual(L.lines.map((l) => l.baseline), m.lines.map((_, i) => m.firstBaseline + i * m.lineHeight), `${text} baselines`);
      assert.equal(L.height, m.height);
      assert.equal(L.width, m.width);
      assert.ok(L.lines.every((l) => l.fragments.length <= 1), 'one fragment per line');
    }
  }
});

test('layoutRich: mixed sizes on one line share the baseline; the line height follows the largest size', () => {
  const o = { type: 'text', fontSize: 12, lineHeight: 1.2, text: 'small BIG\nnext', runs: [{ text: 'small ' }, { text: 'BIG', fontSize: 24 }, { text: '\nnext' }] };
  const L = layoutRich(o, 500);
  assert.equal(L.lines.length, 2);
  const [l0, l1] = L.lines;
  const big = measureText('', { fontSize: 24, lineHeight: 1.2 });
  const small = measureText('', { fontSize: 12, lineHeight: 1.2 });
  near(l0.height, 28.8, 1e-9);
  near(l0.baseline, big.firstBaseline, 1e-9, 'baseline from the big run');
  assert.deepEqual(l0.fragments.map((f) => [f.text, f.style.fontSize, f.baseline]), [['small ', 12, l0.baseline], ['BIG', 24, l0.baseline]]);
  near(l0.fragments[1].x, l0.fragments[0].width, 1e-9, 'second fragment follows the first');
  near(l1.top, 28.8, 1e-9);
  near(l1.baseline, 28.8 + small.firstBaseline, 1e-9);
  near(L.height, 28.8 + 14.4, 1e-9);
});

test('layoutRich wraps across a run boundary and never splits a word spanning two runs', () => {
  const w = (s, o = {}) => measureText(s, o).width;
  // 'aaa bbb' fits, 'aaa bbb ccc' does not; the run boundary is inside 'bbb'
  const o = { type: 'text', text: 'aaa bbb ccc', runs: [{ text: 'aaa b' }, { text: 'bb ccc', bold: true }] };
  const L = layoutRich(o, w('aaa bbb', { bold: true }) + 1);
  assert.deepEqual(L.lines.map(lineText), ['aaa bbb', 'ccc']);
  assert.deepEqual(L.lines[0].fragments.map((f) => [f.text, f.style.bold]), [['aaa b', false], ['bb', true]]);
  assert.deepEqual(L.lines[1].fragments.map((f) => [f.text, f.style.bold]), [['ccc', true]]);
  // 'he' + 'llo' is one word: it moves to the next line whole
  const p = { type: 'text', text: 'xx hello', runs: [{ text: 'xx he' }, { text: 'llo', italic: true }] };
  const P = layoutRich(p, w('xx hel'));
  assert.deepEqual(P.lines.map(lineText), ['xx', 'hello']);
  assert.deepEqual(P.lines[1].fragments.map((f) => f.text), ['he', 'llo']);
});

test("layoutRich: '\\n' breaks lines; center / right alignment per line", () => {
  const o = { type: 'text', text: 'ab\ncdef', runs: [{ text: 'ab\nc', color: '#f00' }, { text: 'def', fontSize: 20 }] };
  const L = layoutRich(o, 200);
  assert.deepEqual(L.lines.map(lineText), ['ab', 'cdef']);
  for (const align of ['center', 'right']) {
    const A = layoutRich({ ...o, align }, 200, { x: 10, y: 5 });
    for (const l of A.lines) {
      const left = align === 'center' ? 10 + (200 - l.width) / 2 : 10 + 200 - l.width;
      near(l.fragments[0].x, left, 1e-9, `${align} line start`);
      const last = l.fragments.at(-1);
      near(last.x + last.width - l.fragments[0].x, l.width, 1e-9, 'fragments add up to the line');
    }
    near(A.lines[0].top, 5, 1e-9, 'origin y');
  }
});

// a bold red word, an underlined word, a struck word
const RICH = {
  id: 'r', page: 0, type: 'text', x: 40, y: 60, w: 300, h: 40, fontSize: 12, color: '#000000',
  text: 'Plain Bold under gone',
  runs: [{ text: 'Plain ' }, { text: 'Bold', bold: true, color: '#ff0000' }, { text: ' ' }, { text: 'under', underline: true }, { text: ' ' }, { text: 'gone', strike: true }],
};

/** [x, y, w, h] of each filled rectangle drawn by pdf-lib drawRectangle (cm translate + 4-point path). */
function rects(content) {
  const re = /1 0 0 1 (-?[\d.e-]+) (-?[\d.e-]+) cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n0 0 m\n0 (-?[\d.e-]+) l\n(-?[\d.e-]+) -?[\d.e-]+ l/g;
  return [...content.matchAll(re)].map((m) => [+m[1], +m[2], +m[4], +m[3]]);
}

function expectRich(content, fonts, ox, oy, vh) {
  assert.ok(fonts.some((f) => f === 'Helvetica-Bold'), `Helvetica-Bold font resource: ${fonts}`);
  assert.ok(fonts.some((f) => f === 'Helvetica'), 'Helvetica font resource');
  const tfs = [...content.matchAll(/\/(Helvetica[-A-Za-z]*)-\d+ 12 Tf/g)].map((m) => m[1]);
  assert.ok(tfs.includes('Helvetica-Bold') && tfs.includes('Helvetica'), `Tf switches: ${tfs}`);
  assert.match(content, /\n1 0 0 rg\n\/Helvetica-Bold-\d+ 12 Tf/, 'red colour op on the bold word');
  const L = layoutRich(RICH, RICH.w, { x: ox, y: oy });
  const frs = L.lines[0].fragments;
  const want = [];
  for (const fr of frs) for (const d of fr.decorations) want.push([d.type, fr.text, fr.x, vh - d.y - d.thickness / 2, fr.width, d.thickness]);
  assert.deepEqual(want.map((w) => [w[0], w[1]]), [['underline', 'under'], ['strike', 'gone']]);
  const got = rects(content);
  assert.equal(got.length, 2, `two decoration rectangles: ${JSON.stringify(got)}`);
  want.forEach(([type, , x, y, w, h], i) => {
    near(got[i][0], x, 1e-6, `${type} x`); near(got[i][1], y, 1e-6, `${type} y`);
    near(got[i][2], w, 1e-6, `${type} width`); near(got[i][3], h, 1e-6, `${type} thickness`);
  });
  // underline below the baseline, strike above it (y-up)
  const base = vh - frs[0].baseline;
  assert.ok(got[0][1] + got[0][3] < base && got[0][1] > base - 0.2 * 12, 'underline just below the baseline');
  assert.ok(got[1][1] > base + 0.15 * 12 && got[1][1] < base + 0.35 * 12, 'strike through the x-height');
}

const fontNames = (resources) => {
  const f = resources.lookup(PDFName.of('Font'));
  return f.keys().map((k) => f.lookup(k).lookup(PDFName.of('BaseFont')).decodeText());
};

test('flatten draws runs: font switches, colour, underline and strike bars', async () => {
  const out = await flattenObjects(await makePdf(1, [400, 400]), [RICH]);
  const doc = await PDFDocument.load(out);
  expectRich(await pageContent(out), fontNames(doc.getPage(0).node.Resources()), RICH.x, RICH.y, 400);
});

test('FreeText appearance draws runs the same way', async () => {
  const out = await writeAnnotations(await makePdf(1, [400, 400]), { add: [RICH] }, { author: 'A', now: '2026-10-07T10:00:00.000Z' });
  const doc = await PDFDocument.load(out);
  const ap = doc.context.lookup(doc.getPage(0).node.Annots().asArray()[0]).lookup(PDFName.of('AP')).lookup(PDFName.of('N'));
  const bbox = ap.dict.lookup(PDFName.of('BBox')).asArray().map((n) => n.asNumber());
  expectRich(Buffer.from(decodePDFRawStream(ap).decode()).toString('latin1'), fontNames(ap.dict.lookup(PDFName.of('Resources'))), 0, 0, bbox[3]);
});
