import test from 'node:test';
import assert from 'node:assert/strict';
import { revisionKey, guessOrder, renderScale, pagePairs, pageSummary, diffRows, diffCsv, diffText } from '../renderer/ui/comparerev-lib.js';

test('revisionKey reads Rev.xx, R1 and letter revisions', () => {
  assert.deepEqual(revisionKey('HVAC-SD-001 Rev.00.pdf'), [0, 0]);
  assert.deepEqual(revisionKey('HVAC-SD-001_Rev 1.pdf'), [0, 1]);
  assert.deepEqual(revisionKey('drawing-R2.pdf'), [0, 2]);
  assert.deepEqual(revisionKey('plan_B.pdf'), [1, 66]);
  assert.deepEqual(revisionKey('Rev-A layout.pdf'), [1, 65]);
  assert.equal(revisionKey('report.pdf'), null);
});

test('guessOrder puts the lower revision first, else keeps the given order', () => {
  const r0 = { name: 'x Rev.00.pdf' }, r1 = { name: 'x Rev.01.pdf' };
  assert.deepEqual(guessOrder(r1, r0), [r0, r1]);
  assert.deepEqual(guessOrder(r0, r1), [r0, r1]);
  assert.deepEqual(guessOrder({ name: 'p_B.pdf' }, { name: 'p_A.pdf' }).map((t) => t.name), ['p_A.pdf', 'p_B.pdf']);
  const a = { name: 'one.pdf' }, b = { name: 'two.pdf' };
  assert.deepEqual(guessOrder(a, b), [a, b]);
  assert.deepEqual(guessOrder({ name: 'Rev.1' }, { name: 'p_A' }).map((t) => t.name), ['Rev.1', 'p_A'], 'number vs letter: given order');
});

test('renderScale keeps the dpi when it fits and lowers it when it does not', () => {
  assert.equal(renderScale(2384, 3370, 150), 150 / 72); // A0 at 150 dpi fits
  const s = renderScale(14400, 14400, 200); // 200 in square sheet
  assert.ok(Math.ceil(14400 * s) <= 16384, `side ${Math.ceil(14400 * s)}`);
  const small = renderScale(1000, 1000, 150, (w, h) => w * h <= 1e6);
  assert.ok(Math.ceil(1000 * small) ** 2 <= 1e6 && small > 0.9);
});

test('pagePairs pairs by index and marks pages present in one revision', () => {
  assert.deepEqual(pagePairs(3, 4), [{ index: 0, older: 0, newer: 0 }, { index: 1, older: 1, newer: 1 }, { index: 2, older: 2, newer: 2 }, { index: 3, older: null, newer: 3 }]);
  assert.deepEqual(pagePairs(2, 1, [1, 5]), [{ index: 1, older: 1, newer: null }]);
});

const pages = [
  { index: 0, status: 'compared', regions: [], text: { added: [], removed: [] } },
  { index: 1, status: 'compared', regions: [{ added: 40, removed: 0 }, { added: 5, removed: 5 }], text: { added: [{ text: 'DN150' }], removed: [{ text: 'DN100' }] } },
  { index: 3, status: 'added', regions: [], text: { added: [], removed: [] } },
];

test('pageSummary and diffText list the changed pages only', () => {
  assert.equal(pageSummary(pages[1]), 'Page 2 — 2 areas, text: +1 / −1');
  assert.equal(pageSummary(pages[2]), 'Page 4 — only in the newer revision');
  assert.equal(diffText(pages), 'Page 2 — 2 areas, text: +1 / −1\n  Change 1: added\n  Change 2: added and removed\n  + DN150\n  − DN100\nPage 4 — only in the newer revision');
  assert.equal(diffText([pages[0]]), 'No differences found');
});

test('diffRows and diffCsv: BOM, header, formula guard', () => {
  assert.deepEqual(diffRows(pages).map((r) => r[2]), ['Change 1: added', 'Change 2: added and removed', '+ DN150', '− DN100', 'Page only in the newer revision']);
  const csv = diffCsv([{ index: 0, status: 'compared', regions: [], text: { added: [{ text: '=SUM(A1)' }], removed: [] } }]);
  assert.ok(csv.startsWith('﻿Page,Kind,Item,Text\r\n'));
  assert.ok(csv.includes(",'=SUM(A1)\r\n"), csv);
  assert.ok(csv.includes(",'+ =SUM(A1),"), 'item cell starting with + is guarded too');
});
