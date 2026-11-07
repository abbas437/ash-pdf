import test from 'node:test';
import assert from 'node:assert/strict';
import { revisionKey, guessOrder, renderScale, pagePairs, pageLabel, pageSummary, diffRows, diffCsv, diffText } from '../renderer/ui/comparerev-lib.js';

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
  assert.deepEqual(diffRows(pages).map((r) => r[3]), ['Change 1: added', 'Change 2: added and removed', '+ DN150', '− DN100', 'Page only in the newer revision']);
  const csv = diffCsv([{ index: 0, status: 'compared', regions: [], text: { added: [{ text: '=SUM(A1)' }], removed: [] } }]);
  assert.ok(csv.startsWith('﻿Newer page,Older page,Kind,Item,Text\r\n'));
  assert.ok(csv.includes(",'=SUM(A1)\r\n"), csv);
  assert.ok(csv.includes(",'+ =SUM(A1),"), 'item cell starting with + is guarded too');
});

test('a page range: labels, Copy list and CSV use the source page numbers, not the output position', () => {
  const ranged = [
    { index: 0, olderPage: 5, newerPage: 5, status: 'compared', regions: [{ added: 4, removed: 0 }], text: { added: [{ text: 'DN150' }], removed: [] } },
    { index: 1, olderPage: 4, newerPage: 6, status: 'compared', regions: [{ added: 4, removed: 0 }], text: { added: [], removed: [] } },
    { index: 2, olderPage: 7, newerPage: null, status: 'removed', regions: [], text: { added: [], removed: [] } },
  ];
  assert.deepEqual(ranged.map(pageLabel), ['Page 5', 'Page 6 (older 4)', 'Older page 7']);
  assert.equal(pageLabel({ index: 2 }), 'Page 3', 'no source pages (reopened compare PDF): the output page');
  assert.equal(pageSummary(ranged[0]), 'Page 5 — 1 area, text: +1 / −0');
  assert.match(diffText(ranged), /^Page 5 — .*\n[\s\S]*\nPage 6 \(older 4\) — 1 area\n[\s\S]*\nOlder page 7 — only in the older revision$/);
  const csv = diffCsv(ranged).split('\r\n');
  assert.deepEqual(csv.slice(1, 5), ['5,5,area,Change 1: added,', "5,5,text added,'+ DN150,DN150", '6,4,area,Change 1: added,', ',7,page,Page only in the older revision,']);
});
