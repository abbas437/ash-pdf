// Other apps' stamps sharing one appearance (a seal on every page of a contract): copies, page moves and
// flattening draw that appearance once per document, not once per stamp; unusual forms (/Matrix, a /BBox
// off the origin) and a move to another page keep what the other app wrote.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFRef, PDFStream } from 'pdf-lib';
import { writeAnnotations, readAnnotations } from '../src/core/annots.js';
import { flattenObjects } from '../src/core/annotate.js';
import { renderPage, isColor, makePdf } from './helpers.js';
import { apStampPdf } from './apstamp-fixture.js';

const OPTS = { author: 'Editor Person', now: '2026-10-12T10:00:00.000Z' };
const BLUE = [20, 60, 220];
const RED = [220, 30, 30];
const N = (k) => PDFName.of(k);

/** Number of image XObjects (a seal with alpha is two: the image and its /SMask) and the largest one's size. */
async function images(bytes) {
  const doc = await PDFDocument.load(bytes);
  const list = doc.context.enumerateIndirectObjects().filter(([, v]) => v instanceof PDFStream && v.dict.get(N('Subtype')) === N('Image'));
  return { count: list.length, largest: Math.max(0, ...list.map(([, v]) => v.contents.length)) };
}
async function stamps(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p, page) => (p.node.Annots()?.asArray() ?? []).map((r) => ({ ref: r, page, d: doc.context.lookup(r) }))
    .filter((x) => x.d.get(N('Subtype')) === N('Stamp'))).flat().map((x) => ({ ...x, doc }));
}
/** Colour class of a visible point: 'b' blue, 'r' red, '-' other. */
const cls = (px) => (isColor(px, BLUE) ? 'b' : isColor(px, RED) ? 'r' : '-');
/** Colour classes on a 6x6 grid inside box `o` of a render (`dx/dy` = where the box is in that render). */
const grid = (img, o, dx = o.x, dy = o.y) => {
  let s = '';
  for (let i = 1; i < 7; i++) for (let j = 1; j < 7; j++) s += cls(img.sample(dx + (o.w * j) / 7, dy + (o.h * i) / 7));
  return s;
};

describe('20 stamps sharing one appearance', () => {
  const seal = { size: 128, mark: true, noise: true };
  test('read: one appearance bytes object for all of them', async () => {
    const { objects } = await readAnnotations(await apStampPdf({ pages: 20, count: 20, seal }));
    assert.equal(objects.length, 20);
    assert.equal(new Set(objects.map((o) => o.ap)).size, 1);
  });

  test('read: each with its own equal form stream: still one appearance bytes object', async () => {
    const { objects } = await readAnnotations(await apStampPdf({ pages: 20, count: 20, seal, ownForms: true }));
    assert.equal(objects.length, 20);
    assert.equal(new Set(objects.map((o) => o.ap)).size, 1);
  });

  test('19 pasted copies reference the original appearance (no image per copy)', async () => {
    const bytes = await apStampPdf({ pages: 20, count: 20, seal });
    const before = await images(bytes);
    const { objects } = await readAnnotations(bytes);
    // As the editor pastes: no source, its own appearance bytes array (not the read one).
    const add = objects.slice(1).map((o, k) => ({ ...o, source: undefined, ap: o.ap.slice(), id: `copy-${k}`, x: o.x + 200 }));
    const out = await writeAnnotations(bytes, { add }, OPTS);
    assert.equal((await images(out)).count, before.count, 'no image copied');
    assert.ok(out.length - bytes.length < before.largest, `19 copies grew the file by ${out.length - bytes.length} bytes (one image: ${before.largest})`);
    const img = await renderPage(out, 3);
    const c = (await readAnnotations(out)).objects.find((o) => o.id === 'copy-2');
    assert.equal(c.type, 'apStamp');
    assert.equal(grid(img, c), grid(await renderPage(c.ap), c, 0, 0), 'a copy shows the seal as its appearance does');
  });

  test('copies into another document copy the appearance once', async () => {
    const { objects } = await readAnnotations(await apStampPdf({ pages: 20, count: 20, seal }));
    const blank = await makePdf(3);
    const add = objects.map((o, k) => ({ ...o, source: undefined, ap: o.ap.slice(), id: `p-${k}`, page: k % 3, apRotate: 0 }));
    const out = await writeAnnotations(blank, { add }, OPTS);
    assert.equal((await images(out)).count, 2, 'the seal image and its mask, once');
  });

  test('flattening all of them draws one image', async () => {
    const bytes = await apStampPdf({ pages: 20, count: 20, seal });
    const before = await images(bytes);
    const { objects } = await readAnnotations(bytes);
    const bare = await writeAnnotations(bytes, { remove: objects.map((o) => o.id) }, OPTS);
    const out = await flattenObjects(bare, objects.map((o) => ({ ...o, ap: o.ap.slice() })));
    assert.equal((await images(out)).count, before.count);
    assert.ok(out.length < bytes.length + before.largest, `flattened ${out.length} bytes from ${bytes.length}`);
    const img = await renderPage(out, 5);
    assert.equal(grid(img, objects[5]), grid(await renderPage(objects[5].ap), objects[5], 0, 0));
  });
});

describe('a form with a /Matrix and a /BBox off the origin', () => {
  for (const rotate of [0, 90, 180, 270]) {
    test(`page /Rotate ${rotate}: the appearance PDF, a copy and a flatten show it as the page does`, async () => {
      const bytes = await apStampPdf({ rotate, origin: 50, matrix: [0, 1, -1, 0, 0, 0], seal: { mark: true } });
      const [o] = (await readAnnotations(bytes)).objects;
      const want = grid(await renderPage(bytes), o);
      assert.match(want, /b/);
      assert.match(want, /r/);
      assert.equal(grid(await renderPage(o.ap), o, 0, 0), want, 'appearance PDF');
      const copied = await writeAnnotations(bytes, { add: [{ ...o, source: undefined, ap: o.ap.slice(), id: 'c', x: 20, y: 20 }] }, OPTS);
      assert.equal(grid(await renderPage(copied), { ...o, x: 20, y: 20 }), want, 'copy');
      const bare = await writeAnnotations(bytes, { remove: [o.id] }, OPTS);
      assert.equal(grid(await renderPage(await flattenObjects(bare, [o])), o), want, 'flatten');
    });
  }
});

describe('a move to another page', () => {
  test('a page turned the same: keeps /AP, /AS, its own keys, /T and its popup', async () => {
    const bytes = await apStampPdf({ pages: 2, states: true, popup: true });
    const [before] = await stamps(bytes);
    const [o] = (await readAnnotations(bytes)).objects;
    const out = await writeAnnotations(bytes, { update: [{ ...o, page: 1, x: 50, y: 60 }] }, OPTS);
    const [s] = await stamps(out);
    assert.equal(s.page, 1);
    assert.equal(s.d.get(N('AS')), N('On'));
    assert.ok(s.d.lookup(N('AP')).lookup(N('N')) instanceof PDFDict, 'the state dictionary');
    assert.equal(s.doc.context.lookup(s.d.lookup(N('AP')).lookup(N('N')).get(N('On'))).getContentsString(),
      before.doc.context.lookup(before.d.lookup(N('AP')).lookup(N('N')).get(N('On'))).getContentsString());
    assert.equal(s.d.lookup(N('ACME_Private')).decodeText(), 'acme-data');
    assert.equal(s.d.lookup(N('T')).decodeText(), 'Other App User');
    const p = s.d.get(N('Popup'));
    assert.ok(p instanceof PDFRef, 'popup kept');
    assert.ok(s.doc.getPage(1).node.Annots().asArray().some((r) => r === p || r.toString() === p.toString()), 'popup on the new page');
    assert.equal(s.doc.context.lookup(p).get(N('P')).toString(), s.doc.getPage(1).ref.toString());
    const [r] = (await readAnnotations(out)).objects;
    assert.equal(r.page, 1);
    assert.equal(r.type, 'apStamp');
    assert.ok(isColor((await renderPage(out, 1)).sample(50 + 0.7 * 150, 60 + 0.8 * 150), BLUE));
  });

  test('a page turned otherwise: its own keys stay, the appearance is drawn upright from the original', async () => {
    const bytes = await apStampPdf({ pages: 2, rotate: [0, 90], states: true, author: false, seal: { mark: true } });
    const [o] = (await readAnnotations(bytes)).objects;
    const want = grid(await renderPage(bytes), o);
    const out = await writeAnnotations(bytes, { update: [{ ...o, page: 1, x: 50, y: 60 }] }, OPTS);
    const [s] = await stamps(out);
    assert.equal(s.page, 1);
    assert.equal(s.d.get(N('AS')), undefined, '/AS dropped with the state dictionary');
    assert.equal(s.d.lookup(N('ACME_Private')).decodeText(), 'acme-data');
    assert.equal(s.d.get(N('T')), undefined, 'no /T added (the editor did not make this seal)');
    assert.equal(grid(await renderPage(out, 1), { ...o, x: 50, y: 60 }), want);
    assert.equal((await images(out)).count, (await images(bytes)).count, 'drawn from the original image');
  });

  test('moved on its page without an author: no /T added', async () => {
    const bytes = await apStampPdf({ author: false });
    const [o] = (await readAnnotations(bytes)).objects;
    const out = await writeAnnotations(bytes, { update: [{ ...o, x: o.x + 10 }] }, OPTS);
    const [s] = await stamps(out);
    assert.equal(s.d.get(N('T')), undefined);
  });
});
