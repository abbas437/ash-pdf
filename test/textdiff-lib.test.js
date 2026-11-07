// Compare revisions: text changes between two revisions of a page (renderer/ui/textdiff-lib.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { pageWords, diffWords, textChangesSummary, viewportTransform, wordKey } from '../renderer/ui/textdiff-lib.js';
import { textItems } from '../renderer/ui/table-extract.js';
import { pdfjsDoc } from './helpers.js';

// Items as textItems() returns them: 0.5 x size per character, word space 0.28 x size.
const CW = 0.5, SP = 0.28;
const item = (str, x, y, size = 10) => ({ str, x, y, w: str.length * size * CW, size });
const sentence = (str, x, y, size = 10) => { // one item per word
  const out = [];
  for (const wd of str.split(' ')) { out.push(item(wd, x, y, size)); x += (wd.length * CW + SP) * size; }
  return out;
};
const VIEW = [0, 0, 600, 800];
const words = (items, view = VIEW, rotate = 0) => pageWords(items, view, rotate);
const texts = (ps) => ps.map((p) => p.text);
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

test('a changed word in a sentence: one removed, one added, at the word', () => {
  const a = words(sentence('Supply air duct 300x200 mm galvanised', 72, 700));
  const b = words(sentence('Supply air duct 400x200 mm galvanised', 72, 700));
  const d = diffWords(a, b);
  assert.deepEqual(texts(d.removed), ['300x200']);
  assert.deepEqual(texts(d.added), ['400x200']);
  assert.equal(d.fallback, false);
  const x = 72 + ('Supply air duct'.length - 2) * CW * 10 + 3 * SP * 10; // after three words
  const box = d.added[0].box;
  assert.ok(near(box.x, x), `x ${box.x} vs ${x}`);
  assert.ok(near(box.w, 7 * CW * 10));
  assert.ok(near(box.y, 800 - 700 - 8) && near(box.h, 10)); // 0.8 x size above the baseline, 0.2 below
});

test('an inserted phrase: one added phrase with the union box, nothing removed', () => {
  const a = words(sentence('Fire damper at wall', 72, 700));
  const b = words(sentence('Fire damper with access panel at wall', 72, 700));
  const d = diffWords(a, b);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(texts(d.added), ['with access panel']);
  const ws = b.filter((w) => ['with', 'panel'].includes(w.text));
  assert.ok(near(d.added[0].box.x, ws[0].box.x));
  assert.ok(near(d.added[0].box.x + d.added[0].box.w, ws[1].box.x + ws[1].box.w));
});

test('a deleted line: removed as one phrase per line, other lines untouched', () => {
  const lines = ['NOTES', 'All ducts to be insulated', 'Refer to schedule M-201', 'Do not scale'];
  const page = (ls) => words(ls.flatMap((l, i) => sentence(l, 72, 700 - i * 14)));
  const d = diffWords(page(lines), page(lines.filter((_, i) => i !== 2)));
  assert.deepEqual(texts(d.removed), ['Refer to schedule M-201']);
  assert.deepEqual(d.added, []);
  assert.ok(near(d.removed[0].box.y, 800 - (700 - 2 * 14) - 8));
});

test('whitespace-only and punctuation-only changes are ignored', () => {
  const a = words(sentence('Provide DN100 valve, see note (3).', 72, 700));
  // Extra spaces inside one item, "DN100" -> "DN 100", comma dropped, brackets dropped, a lone dash added.
  const b = words([item('Provide   DN 100', 72, 700), ...sentence('valve see - note 3', 200, 700)]);
  const d = diffWords(a, b);
  assert.deepEqual(d, { added: [], removed: [], fallback: false });
  // but a changed number or sign inside a word is a change
  const c = words(sentence('Provide DN100 valve, see note (-3).', 72, 700));
  assert.deepEqual(texts(diffWords(a, c).added), ['(-3).']);
  assert.equal(wordKey('1.5'), '1.5');
  assert.equal(wordKey('...'), null);
});

test('a word split across two pdf.js items is joined into one word', () => {
  // "Thermostat" drawn as "Thermo" + "stat" (a kerning change splits the item), then a word gap.
  const x2 = 72 + 6 * CW * 10 + 0.02 * 10;
  const split = [item('Thermo', 72, 700), item('stat', x2, 700), item('TS-01', x2 + 4 * CW * 10 + SP * 10, 700)];
  const ws = words(split);
  assert.deepEqual(ws.map((w) => w.text), ['Thermostat', 'TS-01']);
  assert.ok(near(ws[0].box.x, 72) && near(ws[0].box.x + ws[0].box.w, x2 + 20));
  const d = diffWords(words(sentence('Thermostat TS-01', 72, 700)), ws);
  assert.deepEqual(d, { added: [], removed: [], fallback: false });
});

test('reading order: lines top to bottom, left to right; a slightly raised item stays on its line', () => {
  const ws = words([item('second', 72, 680), item('B', 120, 700.3), item('A', 72, 700), item('third', 72, 660)]);
  assert.deepEqual(ws.map((w) => w.text), ['A', 'B', 'second', 'third']);
  assert.deepEqual(ws.map((w) => w.line), [0, 0, 1, 2]);
});

test('coordinates: rotate 0 with a crop-box offset, rotate 90, 180 and 270', () => {
  const view = [20, 30, 620, 830]; // 600 x 800 crop box not at the origin
  const it = [item('ABCD', 120, 730)]; // 4 chars x 5 pt = 20 pt wide; glyph box y 722..732 in user space... (baseline 730)
  const box = (r) => words(it, view, r)[0].box;
  // rotate 0: [x - x0, y1 - y]
  assert.deepEqual(roundBox(box(0)), { x: 100, y: 830 - 738, w: 20, h: 10 });
  // rotate 90: displayed page is 800 wide; user (x, y) -> (y - y0, x - x0); text runs down the page
  assert.deepEqual(roundBox(box(90)), { x: 730 - 2 - 30, y: 100, w: 10, h: 20 });
  // rotate 180: (x1 - x, y - y0)
  assert.deepEqual(roundBox(box(180)), { x: 620 - 140, y: 730 - 2 - 30, w: 20, h: 10 });
  // rotate 270: (y1 - y, x1 - x)
  assert.deepEqual(roundBox(box(270)), { x: 830 - 738, y: 620 - 140, w: 10, h: 20 });
  // a sentence on a rotate-90 page still reads as one line in order
  assert.deepEqual(words(sentence('Exhaust fan EF-2', 100, 500), view, 90).map((w) => [w.text, w.line]),
    [['Exhaust', 0], ['fan', 0], ['EF-2', 0]]);
});
const roundBox = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));

test('viewportTransform matches pdf.js page.getViewport({scale: 1}) for every rotation', async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([400, 600]);
  p.setMediaBox(50, 100, 400, 600);
  p.setCropBox(70, 120, 360, 560);
  const pdf = await pdfjsDoc(await doc.save());
  try {
    const page = await pdf.getPage(1);
    for (const r of [0, 90, 180, 270]) {
      const want = page.getViewport({ scale: 1, rotation: r }).transform;
      const got = viewportTransform(page.view, r);
      got.forEach((v, i) => assert.ok(near(v, want[i], 1e-9), `rotate ${r}: ${got} vs ${want}`));
    }
  } finally { await pdf.close(); }
});

test('a large page uses the multiset fallback, keeps positions, and finishes quickly', () => {
  const N = 6000;
  const mk = (change) => {
    const its = [];
    for (let i = 0; i < N; i++) {
      const s = change && i === 4321 ? 'CHANGED' : `w${i % 997}`;
      its.push(item(s, 20 + (i % 20) * 28, 790 - Math.floor(i / 20) * 2.5, 2));
    }
    return words(its, [0, 0, 600, 800]);
  };
  const a = mk(false), b = mk(true);
  const t0 = performance.now();
  const d = diffWords(a, b);
  const ms = performance.now() - t0;
  assert.equal(d.fallback, true);
  assert.deepEqual(texts(d.added), ['CHANGED']);
  assert.deepEqual(texts(d.removed), [a[4321].text]);
  assert.deepEqual(d.added[0].box, b[4321].box);
  assert.ok(ms < 1500, `${ms} ms`);
  // and below the limit, Myers finds the same change
  const small = diffWords(a.slice(0, 4500), b.slice(0, 4500));
  assert.equal(small.fallback, false);
  assert.deepEqual(texts(small.added), ['CHANGED']);
});

test('case: a case change is a change by default, not with caseSensitive: false', () => {
  const a = words(sentence('Damper type MD', 72, 700));
  const b = words(sentence('Damper Type md', 72, 700));
  assert.deepEqual(texts(diffWords(a, b).added), ['Type md']);
  assert.deepEqual(diffWords(a, b, { caseSensitive: false }), { added: [], removed: [], fallback: false });
});

test('Arabic: presentation forms equal their NFKC base letters; a real change is found', () => {
  // "مرحبا بكم" in Arabic presentation forms (as some PDF producers emit) vs base letters.
  const pres = 'ﻣﺮﺣﺒﺎ ﺑﻜﻢ';
  const base = 'مرحبا بكم';
  assert.equal(pres.normalize('NFKC'), base);
  const a = words(sentence(`${pres} لوحة`, 72, 700));
  const b = words(sentence(`${base} مخطط`, 72, 700));
  const d = diffWords(a, b);
  assert.deepEqual(texts(d.removed), ['لوحة']);
  assert.deepEqual(texts(d.added), ['مخطط']);
  // a mixed RTL item split into words: boxes stay inside the item
  const [w1, w2] = words([item('مخطط رقم', 72, 700)]);
  assert.ok(w1.box.x >= 72 - 1e-9 && w2.box.x + w2.box.w <= 72 + 40 + 1e-9);
  assert.ok(w1.box.x > w2.box.x, 'first logical word is on the right');
});

test('shiftPt moves removed boxes into the newer frame; added boxes are left alone', () => {
  const a = words(sentence('Grille G-1 400x400', 72, 700));
  const b = words(sentence('Grille G-1 600x600', 82, 695)); // the newer content moved right 10, down 5
  const plain = diffWords(a, b);
  const d = diffWords(a, b, { shiftPt: { dx: 10, dy: 5 } });
  assert.deepEqual(d.added, plain.added);
  assert.deepEqual(d.removed[0].box, { ...plain.removed[0].box, x: plain.removed[0].box.x + 10, y: plain.removed[0].box.y + 5 });
  assert.deepEqual(roundBox(d.removed[0].box), roundBox(d.added[0].box)); // same place in the newer frame
});

test('textChangesSummary: counts and the first N phrases in reading order', () => {
  const a = words([...sentence('one two three', 72, 700), ...sentence('four five', 72, 680)]);
  const b = words([...sentence('one 2 three', 72, 700), ...sentence('four five six seven', 72, 680)]);
  const s = textChangesSummary(diffWords(a, b), 2);
  assert.equal(s.added, 2); assert.equal(s.removed, 1);
  assert.equal(s.addedWords, 3); assert.equal(s.removedWords, 1);
  assert.deepEqual(s.first.map((p) => [p.kind, p.text]), [['added', '2'], ['removed', 'two']]);
  assert.equal(s.more, 1);
});

test('real pdf.js text content: the changed word is found at its place on the page', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [['AHU-01 supply air 12000 m3/h', 'AHU-01 supply air 14500 m3/h'], ['Static pressure 450 Pa', 'Static pressure 450 Pa']];
  for (const rev of [0, 1]) {
    const p = doc.addPage([612, 792]);
    p.setCropBox(36, 36, 540, 720); // display origin at user (36, 756)
    lines.forEach((l, i) => p.drawText(l[rev], { x: 72, y: 700 - i * 20, size: 12, font }));
  }
  const pdf = await pdfjsDoc(await doc.save());
  try {
    const pw = [];
    for (const n of [1, 2]) {
      const page = await pdf.getPage(n);
      pw.push(pageWords(textItems(await page.getTextContent()), page.view, page.rotate));
    }
    const d = diffWords(pw[0], pw[1]);
    assert.deepEqual(texts(d.removed), ['12000']);
    assert.deepEqual(texts(d.added), ['14500']);
    const x = 72 + font.widthOfTextAtSize('AHU-01 supply air ', 12) - 36;
    const w = font.widthOfTextAtSize('14500', 12), box = d.added[0].box;
    // Character boxes share the item's width by count, not by glyph width: the box is near, not exact.
    const overlap = Math.min(box.x + box.w, x + w) - Math.max(box.x, x);
    assert.ok(overlap >= 0.75 * w && Math.abs(box.w - w) < 0.25 * w, `x ${box.x} w ${box.w} vs ${x} ${w}`);
    assert.deepEqual(roundBox(d.removed[0].box), roundBox(box)); // same digit count, same place
    assert.ok(near(box.y, 756 - 700 - 0.8 * 12, 0.5), `y ${box.y}`);
  } finally { await pdf.close(); }
});
