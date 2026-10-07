import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textItems, extractTable, cellValue } from '../renderer/ui/table-extract.js';

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
