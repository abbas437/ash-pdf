import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFHexString, degrees } from 'pdf-lib';
import * as ops from '../src/core/pdfOps.js';
import { makePdf, visibleText, makeImage, near, renderPage } from './helpers.js';

const pageLabels = async (bytes) => {
  const info = await ops.getInfo(bytes);
  const labels = [];
  for (let i = 0; i < info.pageCount; i++) labels.push((await visibleText(bytes, i)).map((t) => t.str).join(''));
  return labels;
};

/** pdf-lib doc with a hand-made Standard security handler /Encrypt dictionary in the trailer. */
async function makeEncryptedPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  const ctx = doc.context;
  const pad = PDFHexString.of('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A');
  ctx.trailerInfo.Encrypt = ctx.register(ctx.obj({ Filter: 'Standard', V: 1, R: 2, Length: 40, P: -44, O: pad, U: pad }));
  return doc.save({ useObjectStreams: false });
}

describe('parseRanges', () => {
  test('mixed list, open-ended and from-start ranges', () => {
    assert.deepEqual(ops.parseRanges('1-3,5,8-', 10), [0, 1, 2, 4, 7, 8, 9]);
    assert.deepEqual(ops.parseRanges('-2', 5), [0, 1]);
  });
  test('sorted and de-duplicated, whitespace tolerated', () => {
    assert.deepEqual(ops.parseRanges(' 5 , 1-2, 2 ,5', 6), [0, 1, 4]);
  });
  for (const bad of ['', '0', '11', '3-2', 'a', '1,,2', '1-2-3', '-', '2-12']) {
    test(`rejects "${bad}" with RangeError`, () => {
      assert.throws(() => ops.parseRanges(bad, 10), RangeError);
    });
  }
});

describe('getInfo and metadata', () => {
  test('page sizes, rotation and boxes', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const p = doc.addPage([400, 600]);
    p.setRotation(degrees(90));
    p.setCropBox(10, 20, 300, 500);
    const info = await ops.getInfo(await doc.save());
    assert.equal(info.pageCount, 2);
    assert.equal(info.isEncrypted, false);
    assert.equal(info.hasForm, false);
    assert.deepEqual(info.pages[0], { width: 612, height: 792, rotation: 0, mediaBox: [0, 0, 612, 792], cropBox: [0, 0, 612, 792] });
    assert.equal(info.pages[1].rotation, 90);
    assert.equal(info.pages[1].width, 500);
    assert.equal(info.pages[1].height, 300);
    assert.deepEqual(info.pages[1].cropBox, [10, 20, 310, 520]);
  });

  test('setMetadata / getMetadata round trip, producer defaults to ASH PDF Studio', async () => {
    const out = await ops.setMetadata(await makePdf(1), { title: 'Shop drawing review', author: 'Ahmad', subject: 'HVAC', keywords: ['duct', 'AHU'], creator: 'Test' });
    const m = await ops.getMetadata(out);
    assert.equal(m.title, 'Shop drawing review');
    assert.equal(m.author, 'Ahmad');
    assert.equal(m.subject, 'HVAC');
    assert.equal(m.keywords, 'duct AHU');
    assert.equal(m.creator, 'Test');
    assert.equal(m.producer, 'ASH PDF Studio');
    assert.equal((await ops.getInfo(out)).metadata.title, 'Shop drawing review');
  });

  test('ordinary edits preserve existing metadata', async () => {
    const withMeta = await ops.setMetadata(await makePdf(2), { title: 'Keep me', producer: 'Origin' });
    const rotated = await ops.rotatePages(withMeta, [0], 90);
    const m = await ops.getMetadata(rotated);
    assert.equal(m.title, 'Keep me');
    assert.equal(m.producer, 'Origin');
  });
});

describe('page operations', () => {
  test('mergePdfs concatenates page counts in order', async () => {
    const out = await ops.mergePdfs([await makePdf(2), await makePdf(3)]);
    assert.equal((await ops.getInfo(out)).pageCount, 5);
    assert.deepEqual(await pageLabels(out), ['Page 1', 'Page 2', 'Page 1', 'Page 2', 'Page 3']);
  });

  test('splitPdf returns named parts per range string', async () => {
    const parts = await ops.splitPdf(await makePdf(6), ['1-2', '3,5', '6-']);
    assert.deepEqual(parts.map((p) => p.name), ['part-1', 'part-2', 'part-3']);
    assert.deepEqual(await pageLabels(parts[1].bytes), ['Page 3', 'Page 5']);
    assert.deepEqual(await pageLabels(parts[2].bytes), ['Page 6']);
  });

  test('splitPdf rejects an invalid range before producing anything', async () => {
    await assert.rejects(ops.splitPdf(await makePdf(3), ['1', '4']), RangeError);
  });

  test('extractPages keeps the given order', async () => {
    const out = await ops.extractPages(await makePdf(4), [3, 0]);
    assert.deepEqual(await pageLabels(out), ['Page 4', 'Page 1']);
  });

  test('deletePages removes pages', async () => {
    const out = await ops.deletePages(await makePdf(4), [1, 3, 1]);
    assert.deepEqual(await pageLabels(out), ['Page 1', 'Page 3']);
  });

  test('deletePages refuses to delete all pages', async () => {
    await assert.rejects(ops.deletePages(await makePdf(2), [0, 1]), (e) => e.code === 'DELETE_ALL_PAGES');
  });

  test('deletePages rejects out-of-range indices', async () => {
    await assert.rejects(ops.deletePages(await makePdf(2), [5]), RangeError);
  });

  test('rotatePages is relative and normalised to 0..270', async () => {
    let b = await ops.rotatePages(await makePdf(2), [0], 90);
    b = await ops.rotatePages(b, [0], 270);
    b = await ops.rotatePages(b, [1], -90);
    const info = await ops.getInfo(b);
    assert.deepEqual(info.pages.map((p) => p.rotation), [0, 270]);
    await assert.rejects(ops.rotatePages(b, [0], 45), RangeError);
  });

  test('reorderPages applies a permutation', async () => {
    const out = await ops.reorderPages(await makePdf(3), [2, 0, 1]);
    assert.deepEqual(await pageLabels(out), ['Page 3', 'Page 1', 'Page 2']);
  });

  test('reorderPages rejects non-permutations', async () => {
    const src = await makePdf(3);
    await assert.rejects(ops.reorderPages(src, [0, 0, 1]), RangeError);
    await assert.rejects(ops.reorderPages(src, [0, 1]), RangeError);
  });

  test('insertBlankPage defaults to the neighbouring page size', async () => {
    const out = await ops.insertBlankPage(await makePdf(2, [300, 500]), 1);
    const info = await ops.getInfo(out);
    assert.equal(info.pageCount, 3);
    assert.deepEqual([info.pages[1].width, info.pages[1].height], [300, 500]);
    assert.deepEqual(await pageLabels(out), ['Page 1', '', 'Page 2']);
  });

  test('insertBlankPage honours explicit size and uses A4 for an empty document', async () => {
    const a = await ops.getInfo(await ops.insertBlankPage(await makePdf(1), 0, { width: 200, height: 100 }));
    assert.deepEqual([a.pages[0].width, a.pages[0].height], [200, 100]);
    const empty = await (await PDFDocument.create()).save();
    const b = await ops.getInfo(await ops.insertBlankPage(empty, 0));
    near(b.pages[0].width, 595.28, 0.01, 'A4 width');
    near(b.pages[0].height, 841.89, 0.01, 'A4 height');
  });

  test('insertPagesFrom inserts copied pages at the index', async () => {
    const out = await ops.insertPagesFrom(await makePdf(2), await makePdf(3), [2, 1], 1);
    assert.deepEqual(await pageLabels(out), ['Page 1', 'Page 3', 'Page 2', 'Page 2']);
  });

  test('replacePages swaps a run of pages in place, keeping the page count', async () => {
    const out = await ops.replacePages(await makePdf(4), await makePdf(3, [300, 400]), [2, 0], 1);
    assert.deepEqual(await pageLabels(out), ['Page 1', 'Page 3', 'Page 1', 'Page 4']);
    assert.deepEqual((await ops.getInfo(out)).pages.map((p) => [p.width, p.height]), [[612, 792], [300, 400], [300, 400], [612, 792]]);
    await assert.rejects(ops.replacePages(await makePdf(4), await makePdf(3), [0, 1], 3), RangeError);
    await assert.rejects(ops.replacePages(await makePdf(4), await makePdf(3), [], 0), RangeError);
  });

  test('cropPages on an unrotated page sets CropBox from visible margins', async () => {
    const out = await ops.cropPages(await makePdf(1, [600, 800]), [0], { left: 10, top: 20, right: 30, bottom: 40 });
    assert.deepEqual((await ops.getInfo(out)).pages[0].cropBox, [10, 40, 570, 780]);
  });

  test('cropPages accounts for /Rotate 90 (visible top = PDF left edge)', async () => {
    const r = await ops.rotatePages(await makePdf(1, [600, 800]), [0], 90);
    const out = await ops.cropPages(r, [0], { left: 10, top: 20, right: 30, bottom: 40 });
    const p = (await ops.getInfo(out)).pages[0];
    assert.deepEqual(p.cropBox, [20, 10, 560, 770]);
    assert.deepEqual([p.width, p.height], [800 - 40, 600 - 60]);
  });

  test('cropPages rejects margins that remove the whole page', async () => {
    await assert.rejects(ops.cropPages(await makePdf(1, [100, 100]), [0], { left: 60, right: 60 }), RangeError);
  });

  test('imagesToPdf: fit pages to PNG size plus margin', async () => {
    const out = await ops.imagesToPdf([{ bytes: makeImage('png', 40, 20), type: 'png' }], { pageSize: 'fit', margin: 5 });
    const info = await ops.getInfo(out);
    assert.deepEqual([info.pages[0].width, info.pages[0].height], [50, 30]);
    assert.equal(info.metadata.producer, 'ASH PDF Studio');
  });

  test('imagesToPdf: A4 / Letter orientation follows the image', async () => {
    const out = await ops.imagesToPdf(
      [{ bytes: makeImage('jpg', 200, 100), type: 'jpg' }, { bytes: makeImage('png', 100, 200), type: 'png' }],
      { pageSize: 'Letter', margin: 36 },
    );
    const info = await ops.getInfo(out);
    assert.deepEqual([info.pages[0].width, info.pages[0].height], [792, 612]);
    assert.deepEqual([info.pages[1].width, info.pages[1].height], [612, 792]);
    await assert.rejects(ops.imagesToPdf([{ bytes: makeImage('png'), type: 'gif' }]), TypeError);
  });

  test('operations never mutate the input bytes', async () => {
    const src = await makePdf(3);
    const before = Buffer.from(src).toString('base64');
    await ops.rotatePages(src, [0], 90);
    await ops.deletePages(src, [1]);
    await ops.reorderPages(src, [2, 1, 0]);
    await ops.setMetadata(src, { title: 'x' });
    assert.equal(Buffer.from(src).toString('base64'), before);
  });

  test('garbage input fails with code INVALID_PDF', async () => {
    await assert.rejects(ops.getInfo(new Uint8Array([1, 2, 3, 4])), (e) => e.code === 'INVALID_PDF');
  });
});

describe('reverse, resize, interleave', () => {
  test('reversePages: all pages, and a selection within its positions', async () => {
    const src = await makePdf(5);
    assert.deepEqual(await pageLabels(await ops.reversePages(src)), ['Page 5', 'Page 4', 'Page 3', 'Page 2', 'Page 1']);
    assert.deepEqual(await pageLabels(await ops.reversePages(src, [3, 1, 2])), ['Page 1', 'Page 4', 'Page 3', 'Page 2', 'Page 5']);
  });

  test('resizePages fit: new size, content scaled uniformly and centred', async () => {
    const [W, H] = ops.PAPER_SIZES.A4;
    const out = await ops.resizePages(await makePdf(2), [0], { width: H, height: W, fit: true }); // A4 landscape
    const info = await ops.getInfo(out);
    near(info.pages[0].width, H, 0.01); near(info.pages[0].height, W, 0.01);
    assert.deepEqual([info.pages[1].width, info.pages[1].height], [612, 792], 'other page untouched');
    const s = Math.min(H / 612, W / 792);
    const [t] = await visibleText(out, 0);
    near(t.x, (H - 612 * s) / 2 + 50 * s, 0.5, 'text x centred and scaled');
    near(t.y, W - (W - 792 * s) / 2 - 50 * s, 0.5, 'text y centred and scaled');
    // the page's own centre maps to the new page's centre
    const r = await renderPage(await ops.resizePages(await (async () => {
      const d = await PDFDocument.create(); d.addPage([200, 100]).drawRectangle({ x: 0, y: 0, width: 200, height: 100 }); return d.save();
    })(), [0], { width: 400, height: 400 }));
    assert.deepEqual(r.sample(200, 200).slice(0, 3), [0, 0, 0], 'centre is content');
    assert.deepEqual(r.sample(200, 95).slice(0, 3), [255, 255, 255], 'band above content is empty');
    assert.deepEqual(r.sample(200, 105).slice(0, 3), [0, 0, 0], 'content height scaled to 200');
  });

  test('resizePages without fit keeps 100 % and centres; rotated page uses visible size', async () => {
    const out = await ops.resizePages(await makePdf(1), [0], { width: 812, height: 992, fit: false });
    const [t] = await visibleText(out, 0);
    near(t.x, 150, 0.5); near(t.y, 992 - 100 - 50, 0.5);
    const d = await PDFDocument.load(await makePdf(1)); d.getPage(0).setRotation(degrees(90));
    const info = await ops.getInfo(await ops.resizePages(await d.save(), [0], { width: 595.28, height: 841.89 }));
    near(info.pages[0].width, 595.28, 0.01); near(info.pages[0].height, 841.89, 0.01);
  });

  test('interleavePdfs: A1,B1,A2,B2 and the reverse option; leftovers follow', async () => {
    const a = await makePdf(3);
    const bDoc = await PDFDocument.create();
    for (const k of [1, 2, 3]) bDoc.addPage([612, 792]).drawText(`Back ${k}`, { x: 50, y: 50, size: 12 });
    const b = await bDoc.save();
    assert.deepEqual(await pageLabels(await ops.interleavePdfs(a, b)), ['Page 1', 'Back 1', 'Page 2', 'Back 2', 'Page 3', 'Back 3']);
    assert.deepEqual(await pageLabels(await ops.interleavePdfs(a, b, { reverseB: true })), ['Page 1', 'Back 3', 'Page 2', 'Back 2', 'Page 3', 'Back 1']);
    assert.deepEqual(await pageLabels(await ops.interleavePdfs(await makePdf(1), b)), ['Page 1', 'Back 1', 'Back 2', 'Back 3']);
    assert.deepEqual(await pageLabels(await ops.interleavePdfs(a, await makePdf(1))), ['Page 1', 'Page 1', 'Page 2', 'Page 3']);
  });
});

describe('encrypted PDFs', () => {
  test('getInfo reports isEncrypted with page structure but no metadata', async () => {
    const info = await ops.getInfo(await makeEncryptedPdf());
    assert.equal(info.isEncrypted, true);
    assert.equal(info.pageCount, 1);
    assert.equal(info.metadata, null);
    assert.deepEqual([info.pages[0].width, info.pages[0].height], [300, 400]);
  });

  test('editing operations throw code ENCRYPTED, with or without a password', async () => {
    const enc = await makeEncryptedPdf();
    const calls = [
      () => ops.rotatePages(enc, [0], 90),
      () => ops.mergePdfs([enc]),
      () => ops.getMetadata(enc, { password: 'secret' }),
      () => ops.setMetadata(enc, { title: 'x' }),
      () => ops.splitPdf(enc, ['1']),
    ];
    for (const call of calls) {
      await assert.rejects(call(), (e) => e.code === 'ENCRYPTED' && /encrypted/i.test(e.message));
    }
  });
});
