import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerTree, layerIds, printPageIndices, pageText, textStats, addStats, snapRect } from '../renderer/ui/viewextras-lib.js';

const cfg = (order, names) => ({ getOrder: () => order, getGroup: (id) => (id in names ? { name: names[id] } : null) });

test('layerTree: flat, nested under previous item, named heading, unknown ids dropped', () => {
  const names = { '1R': 'Walls', '2R': 'Doors', '3R': 'Ducts', '4R': 'Notes' };
  const tree = layerTree(cfg(['1R', { name: null, order: ['2R'] }, { name: 'MEP', order: ['3R', '9R'] }, '4R'], names));
  assert.deepEqual(tree, [
    { id: '1R', name: 'Walls', children: [{ id: '2R', name: 'Doors', children: [] }] },
    { id: null, name: 'MEP', children: [{ id: '3R', name: 'Ducts', children: [] }] },
    { id: '4R', name: 'Notes', children: [] },
  ]);
  assert.deepEqual(layerIds(tree), ['1R', '2R', '3R', '4R']);
});

test('layerTree: no config or no groups means no layers', () => {
  assert.deepEqual(layerTree(null), []);
  assert.deepEqual(layerTree(cfg(null, {})), []);
});

test('printPageIndices: all, current, range, odd, even', () => {
  assert.deepEqual(printPageIndices({ mode: 'all', count: 3 }), [0, 1, 2]);
  assert.deepEqual(printPageIndices({ mode: 'current', current: 1, count: 3 }), [1]);
  assert.deepEqual(printPageIndices({ mode: 'range', range: '2-3', count: 4 }), [1, 2]);
  assert.deepEqual(printPageIndices({ mode: 'odd', count: 5 }), [0, 2, 4]);
  assert.deepEqual(printPageIndices({ mode: 'even', count: 5 }), [1, 3]);
  assert.throws(() => printPageIndices({ mode: 'range', range: '4-9', count: 3 }), RangeError);
});

test('textStats: whitespace-split words, punctuation-only runs ignored, chars with and without spaces', () => {
  assert.deepEqual(textStats('Hello,  world — again\n'), { words: 3, chars: 21, charsNoSpaces: 17 });
  assert.deepEqual(textStats(''), { words: 0, chars: 0, charsNoSpaces: 0 });
  assert.deepEqual(textStats('a\tb\r\nc'), { words: 3, chars: 4, charsNoSpaces: 3 });
});

test('textStats: each CJK character is a word, Arabic counts per space-separated run', () => {
  assert.equal(textStats('日本語のテキスト').words, 8);
  assert.equal(textStats('Windows版 です').words, 4);
  assert.equal(textStats('مرحبا بالعالم').words, 2);
  assert.equal(textStats('مُحَمَّد').words, 1);
  assert.equal(textStats('안녕하세요 세계').words, 2);
  assert.equal(textStats('𠀋').chars, 1); // astral code point counts once
});

test('pageText joins items and breaks after hasEOL; addStats sums', () => {
  assert.equal(pageText({ items: [{ str: 'Two', hasEOL: false }, { str: ' ' }, { str: 'words', hasEOL: true }, { str: 'next' }] }), 'Two words\nnext');
  assert.equal(pageText(null), '');
  assert.deepEqual(addStats(textStats('a b'), textStats('cd')), { words: 3, chars: 5, charsNoSpaces: 4 });
});

test('snapRect: normalised, clamped to the page, null for a click', () => {
  const size = { width: 612, height: 792 };
  assert.deepEqual(snapRect({ x: 200, y: 150 }, { x: 100, y: 100 }, size), { x: 100, y: 100, w: 100, h: 50 });
  assert.deepEqual(snapRect({ x: -20, y: 700 }, { x: 50, y: 900 }, size), { x: 0, y: 700, w: 50, h: 92 });
  assert.equal(snapRect({ x: 10, y: 10 }, { x: 11, y: 80 }, size), null);
});
