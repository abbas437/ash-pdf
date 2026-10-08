import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { deviceToPdf, addTextLayer } from '../src/core/ocr.js';
import { createCanvas } from '@napi-rs/canvas';
import { pdfjsDoc } from './helpers.js';

const SCALE = 300 / 72;

/** One 600x800 page with a crop box offset to (50, 70) and the given /Rotate, plus some visible content. */
async function fixture(rotate) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  page.setCropBox(50, 70, 400, 500);
  page.setRotation(degrees(rotate));
  page.drawRectangle({ x: 100, y: 100, width: 200, height: 50, color: rgb(0, 0, 1) });
  return doc.save();
}

test('device pixels map to PDF user space like pdf.js for every /Rotate, with a crop box offset', async () => {
  for (const rotate of [0, 90, 180, 270]) {
    const page = await (await pdfjsDoc(await fixture(rotate))).getPage(1);
    const vp = page.getViewport({ scale: SCALE });
    const geom = { view: page.view, rotate: page.rotate, scale: SCALE };
    for (const [px, py] of [[0, 0], [123, 456], [vp.width, vp.height], [vp.width / 3, 17]]) {
      const [ex, ey] = vp.convertToPdfPoint(px, py);
      const [x, y] = deviceToPdf(px, py, geom);
      assert.ok(Math.abs(x - ex) < 1e-6 && Math.abs(y - ey) < 1e-6, `rotate ${rotate} (${px},${py}): got ${x},${y} want ${ex},${ey}`);
    }
  }
});

test('Rotate 90 with a crop box offset: device x runs up the PDF y axis, device y along x', () => {
  const geom = { view: [50, 70, 450, 570], rotate: 90, scale: 2 };
  assert.deepEqual(deviceToPdf(0, 0, geom), [50, 70]);
  assert.deepEqual(deviceToPdf(200, 0, geom), [50, 170]);
  assert.deepEqual(deviceToPdf(0, 300, geom), [200, 70]);
});

async function pixels(bytes) {
  const page = await (await pdfjsDoc(bytes)).getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  return Buffer.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

/** Words as getTextContent sees them, with their origin in device pixels. */
async function extracted(bytes) {
  const page = await (await pdfjsDoc(bytes)).getPage(1);
  const vp = page.getViewport({ scale: SCALE });
  const { items } = await page.getTextContent();
  return items.filter((i) => i.str.trim()).map((i) => {
    const [x, y] = vp.convertToViewportPoint(i.transform[4], i.transform[5]);
    return { str: i.str, x, y, w: i.width };
  });
}

test('the text layer is invisible text that pdf.js extracts at the word boxes, also on a rotated cropped page', async () => {
  for (const rotate of [0, 90]) {
    const bytes = await fixture(rotate);
    const page = await (await pdfjsDoc(bytes)).getPage(1);
    const geom = { view: page.view, rotate: page.rotate, scale: SCALE };
    const words = [
      { text: 'drawing', bbox: { x0: 300, y0: 400, x1: 620, y1: 460 } },
      { text: 'HV-101', bbox: { x0: 700, y0: 400, x1: 980, y1: 460 } },
    ];
    const out = await addTextLayer(bytes, [{ index: 0, geom, words }]);
    const got = await extracted(out);
    assert.deepEqual(got.map((g) => g.str), ['drawing', 'HV-101'], `rotate ${rotate}`);
    for (const [k, w] of words.entries()) {
      const g = got[k];
      // Origin at the box's left edge, baseline just above its bottom (within 10 pt = 41.7 px at 300 dpi).
      assert.ok(Math.abs(g.x - w.bbox.x0) < 2, `rotate ${rotate} ${w.text}: x ${g.x} vs ${w.bbox.x0}`);
      assert.ok(g.y <= w.bbox.y1 + 1 && g.y > w.bbox.y0, `rotate ${rotate} ${w.text}: baseline ${g.y} outside ${w.bbox.y0}..${w.bbox.y1}`);
      // Horizontal scaling fits the word to its box width (pdf.js width is in PDF units; its standard-font metrics
      // differ from the Helvetica AFM widths pdf-lib fits with by a few per cent).
      assert.ok(Math.abs(g.w * SCALE / (w.bbox.x1 - w.bbox.x0) - 1) < 0.05, `rotate ${rotate} ${w.text}: width ${g.w * SCALE}`);
    }
    // Render mode 3 (invisible): the rendered page is pixel-identical.
    assert.ok((await pixels(bytes)).equals(await pixels(out)), `rotate ${rotate}: visible pixels changed`);
  }
});

test('the text layer is placed in user space even when the page content leaves the CTM changed', async () => {
  const doc = await PDFDocument.load(await fixture(0));
  const { pushOperators } = doc.getPage(0);
  const { concatTransformationMatrix } = await import('pdf-lib');
  pushOperators.call(doc.getPage(0), concatTransformationMatrix(0.5, 0, 0, 0.5, 30, 40)); // no q/Q around it
  const bytes = await doc.save();
  const page = await (await pdfjsDoc(bytes)).getPage(1);
  const geom = { view: page.view, rotate: page.rotate, scale: SCALE };
  const out = await addTextLayer(bytes, [{ index: 0, geom, words: [{ text: 'HV-101', bbox: { x0: 700, y0: 400, x1: 980, y1: 460 } }] }]);
  const [g] = await extracted(out);
  assert.equal(g.str, 'HV-101');
  assert.ok(Math.abs(g.x - 700) < 2, `x ${g.x}`);
});

test('characters outside the standard font encoding do not fail the layer', async () => {
  const bytes = await fixture(0);
  const page = await (await pdfjsDoc(bytes)).getPage(1);
  const geom = { view: page.view, rotate: page.rotate, scale: SCALE };
  const out = await addTextLayer(bytes, [{ index: 0, geom, words: [{ text: 'a→b', bbox: { x0: 10, y0: 10, x1: 90, y1: 40 } }, { text: ' ', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] }]);
  assert.deepEqual((await extracted(out)).map((g) => g.str), ['a?b']);
});
