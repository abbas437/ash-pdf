import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { appendIncrementalUpdate, writeAnnotations, readAnnotations, rotatePages, detectSignatures } from '../src/core/index.js';
import { makeSignedPdf, pdfjsDoc } from './helpers.js';

const square = (id, x) => ({ id, page: 0, type: 'rect', x, y: 50, w: 80, h: 30, stroke: '#ff0000', strokeWidth: 2 });
const isPrefix = (a, b) => b.length > a.length && Buffer.from(b.subarray(0, a.length)).equals(Buffer.from(a));

/** The signature dictionary's /ByteRange and the bytes it covers. */
async function signedRange(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Sig')) {
      const br = o.lookup(PDFName.of('ByteRange')).asArray().map((n) => n.asNumber());
      return { br, covered: Buffer.concat([bytes.subarray(br[0], br[0] + br[1]), bytes.subarray(br[2], br[2] + br[3])]) };
    }
  }
  return null;
}

async function reopens(bytes) {
  await PDFDocument.load(bytes, { updateMetadata: false });
  const doc = await pdfjsDoc(bytes);
  try { return { pages: doc.numPages, annots: (await (await doc.getPage(1)).getAnnotations()).map((a) => a.subtype) }; } finally { await doc.close(); }
}

describe('appendIncrementalUpdate', () => {
  test('a new square annotation on a signed PDF is appended: the original is an exact prefix', async () => {
    const orig = await makeSignedPdf({ exact: true });
    const sig = await signedRange(orig);
    assert.equal(sig.br[2] + sig.br[3], orig.length, 'fixture /ByteRange covers the whole file');
    const out = await appendIncrementalUpdate(orig, await writeAnnotations(orig, { add: [square('sq1', 40)] }));
    assert.ok(out && isPrefix(orig, out), 'original bytes are an exact prefix');
    const tail = Buffer.from(out.subarray(orig.length)).toString('latin1');
    assert.match(tail, /\nxref\n[\s\S]*trailer\n<<[\s\S]*\/Prev \d+[\s\S]*startxref\n\d+\n%%EOF\n$/);
    const after = await signedRange(out);
    assert.deepEqual(after.br, sig.br, 'same /ByteRange');
    assert.ok(after.covered.equals(sig.covered), '/ByteRange covers the same bytes');
    assert.deepEqual((await readAnnotations(out)).objects.map((o) => [o.id, o.type]), [['sq1', 'rect']]);
    const view = await reopens(out);
    assert.equal(view.pages, 2);
    assert.ok(view.annots.includes('Square'), 'pdf.js reads the new annotation');
    assert.deepEqual(await detectSignatures(out), { signed: true, fields: 1 });
  });

  test('a second update keeps the first output as prefix; deleting an annotation updates /Annots', async () => {
    const orig = await makeSignedPdf({ exact: true });
    const one = await appendIncrementalUpdate(orig, await writeAnnotations(orig, { add: [square('a', 40)] }));
    const two = await appendIncrementalUpdate(one, await writeAnnotations(one, { add: [square('b', 200)] }));
    assert.ok(isPrefix(one, two) && isPrefix(orig, two));
    assert.deepEqual((await readAnnotations(two)).objects.map((o) => o.id).sort(), ['a', 'b']);
    const three = await appendIncrementalUpdate(two, await writeAnnotations(two, { remove: ['a'] }));
    assert.ok(isPrefix(two, three));
    assert.deepEqual((await readAnnotations(three)).objects.map((o) => o.id), ['b']);
    const view = await reopens(three);
    assert.deepEqual(view.annots.filter((s) => s === 'Square'), ['Square'], 'pdf.js sees only the kept square');
    assert.match(Buffer.from(three.subarray(two.length)).toString('latin1'), /0000000000 65535 f|\d{10} \d{5} f/, 'deleted objects are freed');
    assert.ok((await signedRange(three)).covered.equals((await signedRange(orig)).covered));
  });

  test('a page rotation is not an annotation change: null (full save)', async () => {
    const orig = await makeSignedPdf({ exact: true });
    assert.equal(await appendIncrementalUpdate(orig, await rotatePages(orig, [0], 90)), null);
    const both = await rotatePages(await writeAnnotations(orig, { add: [square('s', 40)] }), [1], 90);
    assert.equal(await appendIncrementalUpdate(orig, both), null);
  });

  test('nothing changed: the original is returned and nothing appended', async () => {
    const orig = await makeSignedPdf({ exact: true });
    assert.equal(await appendIncrementalUpdate(orig, orig), orig);
    const resaved = await (await PDFDocument.load(orig, { updateMetadata: false })).save();
    assert.equal(await appendIncrementalUpdate(orig, resaved), orig);
  });
});
