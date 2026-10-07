import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerTree, layerIds, printPageIndices } from '../renderer/ui/viewextras-lib.js';

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
