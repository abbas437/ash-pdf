import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as ops from '../src/core/pdfOps.js';
import { SIZES, pageSizePoints, nextUntitledName, mmToPt } from '../renderer/ui/newpdf-lib.js';

const sizes = (doc) => doc.getPages().map((p) => { const { width, height } = p.getSize(); return [width, height]; });

describe('createBlankPdf', () => {
  test('pages of the given size, re-openable, stamped like other created documents', async () => {
    const bytes = await ops.createBlankPdf({ width: 595.28, height: 841.89, pages: 3 });
    assert.ok(bytes instanceof Uint8Array);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false }); // load would restamp Producer
    assert.deepEqual(sizes(doc), Array(3).fill([595.28, 841.89]));
    assert.equal(doc.getProducer(), 'ASH PDF Studio');
    assert.equal(doc.getCreator(), 'ASH PDF Studio');
    assert.equal((await ops.getInfo(bytes)).pageCount, 3);
  });
  test('one page by default', async () => {
    assert.equal((await PDFDocument.load(await ops.createBlankPdf({ width: 612, height: 792 }))).getPageCount(), 1);
  });
  test('bounds are inclusive: 72 and 14400 pt, 500 pages', async () => {
    assert.deepEqual(sizes(await PDFDocument.load(await ops.createBlankPdf({ width: 72, height: 14400 }))), [[72, 14400]]);
    assert.equal((await PDFDocument.load(await ops.createBlankPdf({ width: 100, height: 100, pages: 500 }))).getPageCount(), 500);
  });
  test('RangeError for bad sizes and page counts', async () => {
    for (const bad of [
      {}, { width: 600 }, { width: 71.9, height: 800 }, { width: 600, height: 14400.1 }, { width: NaN, height: 800 },
      { width: Infinity, height: 800 }, { width: '600', height: 800 }, { width: 600, height: 800, pages: 0 },
      { width: 600, height: 800, pages: 501 }, { width: 600, height: 800, pages: 1.5 }, { width: 600, height: 800, pages: '2' },
    ]) await assert.rejects(ops.createBlankPdf(bad), RangeError, JSON.stringify(bad));
  });
  test('PAGE_SIZES has the new sizes and keeps A4 / Letter; the UI table matches it', () => {
    assert.deepEqual(ops.PAGE_SIZES.A4, [595.28, 841.89]);
    assert.deepEqual(ops.PAGE_SIZES.Letter, [612, 792]);
    assert.deepEqual(ops.PAGE_SIZES.A3, [841.89, 1190.55]);
    assert.deepEqual(ops.PAGE_SIZES.A5, [419.53, 595.28]);
    assert.deepEqual(ops.PAGE_SIZES.Legal, [612, 1008]);
    assert.deepEqual(JSON.parse(JSON.stringify(SIZES)), JSON.parse(JSON.stringify(ops.PAGE_SIZES)));
  });
});

describe('pageSizePoints', () => {
  test('named sizes, portrait and landscape', () => {
    assert.deepEqual(pageSizePoints({ size: 'A4', orientation: 'portrait' }), [595.28, 841.89]);
    assert.deepEqual(pageSizePoints({ size: 'A4', orientation: 'landscape' }), [841.89, 595.28]);
    assert.deepEqual(pageSizePoints({ size: 'A3', orientation: 'landscape' }), [1190.55, 841.89]);
    assert.deepEqual(pageSizePoints({ size: 'Legal' }), [612, 1008]);
  });
  test('custom mm converts to points; orientation puts the long side the right way', () => {
    assert.ok(Math.abs(mmToPt(25.4) - 72) < 1e-9);
    const [w, h] = pageSizePoints({ size: 'custom', orientation: 'portrait', customW: 300, customH: 100 });
    assert.ok(Math.abs(w - mmToPt(100)) < 1e-9 && Math.abs(h - mmToPt(300)) < 1e-9, `${w}x${h}`);
    const [lw, lh] = pageSizePoints({ size: 'custom', orientation: 'landscape', customW: 100, customH: 300 });
    assert.ok(lw > lh && Math.abs(lw - mmToPt(300)) < 1e-9);
    assert.deepEqual(pageSizePoints({ size: 'custom', orientation: 'landscape', customW: 25.4, customH: 5080 }), [14400, 72]);
  });
  test('RangeError for unknown sizes and custom sides outside 25.4..5080 mm', () => {
    for (const bad of [{ size: 'B5' }, { size: 'toString' }, { size: 'custom', customW: 25.3, customH: 100 },
      { size: 'custom', customW: 100, customH: 5080.1 }, { size: 'custom', customW: NaN, customH: 100 }, { size: 'custom' }]) {
      assert.throws(() => pageSizePoints(bad), RangeError, JSON.stringify(bad));
    }
  });
});

describe('nextUntitledName', () => {
  test('counts up from the counter and skips names already open', () => {
    assert.deepEqual(nextUntitledName([], 1), { name: 'Untitled 1.pdf', next: 2 });
    assert.deepEqual(nextUntitledName(['Untitled 2.pdf', 'Untitled 3.pdf', 'a.pdf'], 2), { name: 'Untitled 4.pdf', next: 5 });
    assert.deepEqual(nextUntitledName(['Untitled 1.pdf'], 3), { name: 'Untitled 3.pdf', next: 4 });
  });
});
