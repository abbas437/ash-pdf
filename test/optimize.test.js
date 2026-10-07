import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { optimizePdf, PRESETS } from '../src/core/optimize.js';
import { makePdf, renderPage, isColor } from './helpers.js';

// Node implementations of the injected codec (the renderer uses OffscreenCanvas / createImageBitmap).
const codec = {
  async decodeImage(bytes) {
    const img = await loadImage(Buffer.from(bytes));
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
  },
  async encodeJpeg(src, { width, height, quality }) {
    const s = createCanvas(src.width, src.height);
    const sctx = s.getContext('2d');
    const id = sctx.createImageData(src.width, src.height);
    id.data.set(src.data);
    sctx.putImageData(id, 0, 0);
    const c = createCanvas(width, height);
    c.getContext('2d').drawImage(s, 0, 0, width, height);
    return new Uint8Array(await c.encode('jpeg', Math.round(quality * 100)));
  },
};

/** Photo-like image: smooth gradients plus pixel noise (expensive to compress), red in the top-left quarter. */
function photo(w, h, type = 'jpeg', alpha = false) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, n = rnd() * 60 - 30;
    const red = x < w / 2 && y < h / 2;
    id.data[o] = red ? 220 + n / 3 : 80 + (x / w) * 120 + n;
    id.data[o + 1] = red ? 20 : 60 + (y / h) * 150 + n;
    id.data[o + 2] = red ? 20 : 140 + n;
    id.data[o + 3] = alpha ? 128 + (x % 128) : 255;
  }
  ctx.putImageData(id, 0, 0);
  return type === 'png' ? new Uint8Array(c.toBuffer('image/png')) : new Uint8Array(c.toBuffer('image/jpeg', 95));
}

function imageStreams(doc) {
  return doc.context.enumerateIndirectObjects()
    .filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
}

test('a large photo on a letter page is downsampled to the preset dpi and the file gets smaller', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const img = await doc.embedJpg(photo(2000, 2000));
  page.drawImage(img, { x: 0, y: 90, width: 612, height: 612 });
  const bytes = await doc.save();

  const res = await optimizePdf(bytes, { ...PRESETS.balanced, ...codec });
  assert.equal(res.before, bytes.length);
  assert.equal(res.after, res.bytes.length);
  assert.ok(res.after < res.before, `after ${res.after} < before ${res.before}`);
  assert.equal(res.imagesRecompressed, 1);

  const out = await PDFDocument.load(res.bytes);
  const [[, s]] = imageStreams(out);
  const width = s.dict.get(PDFName.of('Width')).asNumber();
  assert.ok(width <= 1700 && width >= 1500, `width ${width}`); // 11 in x 150 dpi = 1650
  assert.equal(s.dict.get(PDFName.of('Filter')), PDFName.of('DCTDecode'));

  const r = await renderPage(res.bytes, 0);
  assert.ok(isColor(r.sample(100, 792 - 90 - 612 + 100), [220, 20, 20], 60), 'red quarter still rendered');
});

test('a masked image (PNG with alpha) and its soft mask stay byte-identical', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const img = await doc.embedPng(photo(600, 600, 'png', true));
  page.drawImage(img, { x: 0, y: 0, width: 600, height: 600 });
  const bytes = await doc.save();
  const contents = (d) => imageStreams(d).map(([, s]) => Buffer.from(s.getContents()).toString('base64')).sort();
  const beforeStreams = contents(await PDFDocument.load(bytes));
  assert.equal(beforeStreams.length, 2); // image + SMask

  const res = await optimizePdf(bytes, { ...PRESETS.smallest, ...codec });
  assert.equal(res.imagesRecompressed, 0);
  assert.equal(res.skipped, 2);
  assert.deepEqual(contents(await PDFDocument.load(res.bytes)), beforeStreams);
});

test('a PDF without images still loads after optimizing', async () => {
  const bytes = await makePdf(3);
  const res = await optimizePdf(bytes, { ...PRESETS.high, ...codec });
  assert.equal(res.imagesRecompressed, 0);
  assert.ok(res.after <= res.before);
  const out = await PDFDocument.load(res.bytes);
  assert.equal(out.getPageCount(), 3);
});

test('unreferenced objects are dropped', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  doc.context.register(doc.context.flateStream(new Uint8Array(200000).map((_, i) => (i * 7919) % 251)));
  const bytes = await doc.save();
  const res = await optimizePdf(bytes, { ...PRESETS.balanced, ...codec });
  assert.ok(res.after < res.before / 2, `after ${res.after} before ${res.before}`);
  assert.equal((await PDFDocument.load(res.bytes)).getPageCount(), 1);
});
