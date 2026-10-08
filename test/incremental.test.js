import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { appendIncrementalUpdate, docMdpPermission, writeAnnotations, readAnnotations, rotatePages, detectSignatures } from '../src/core/index.js';
import { trailerSize } from '../src/core/incremental.js';
import { signedSaveMode } from '../renderer/ui/save-lib.js';
import { makeSignedPdf, makePdf, makeEncryptedPdf, appendXrefStreamUpdate, checkAppendedXref, pdfjsStrict, qpdfCheck, pdfjsDoc } from './helpers.js';

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

  /** The update `out` appends to `orig`: strict xref check, pdf.js without recovery, qpdf --check. */
  async function strictlyValid(orig, out) {
    assert.ok(out && isPrefix(orig, out), 'original bytes are an exact prefix');
    const x = checkAppendedXref(orig, out);
    const view = await pdfjsStrict(out);
    assert.deepEqual(view.warnings, [], 'pdf.js reads it without warnings');
    const q = qpdfCheck(out);
    if (q) assert.ok(q.ok, `qpdf --check: ${q.output}`);
    return { ...x, view };
  }

  test('object-stream original (pdf-lib default save): new objects are numbered from /Size, not over the object stream', async () => {
    for (const orig of [await makePdf(2), await makeSignedPdf({ exact: true, objectStreams: true })]) {
      const size = trailerSize(orig);
      assert.ok(size > 0, 'cross-reference stream /Size read');
      const out = await appendIncrementalUpdate(orig, await writeAnnotations(orig, { add: [square('sq', 40)] }));
      const { numbers, size: newSize, view } = await strictlyValid(orig, out);
      assert.ok(numbers.filter((n) => n >= size).length > 0 && newSize > size, 'new objects get numbers >= the original /Size');
      assert.ok(view.annots.includes('Square'), 'pdf.js shows the square');
      assert.deepEqual((await readAnnotations(out)).objects.map((o) => o.id), ['sq']);
    }
  });

  test('an original with an earlier cross-reference-stream update: numbers and /Size stay above it', async () => {
    const orig = await appendXrefStreamUpdate(await makePdf(2));
    const size = trailerSize(orig);
    const out = await appendIncrementalUpdate(orig, await writeAnnotations(orig, { add: [square('sq', 40)] }));
    const { size: newSize, view } = await strictlyValid(orig, out);
    assert.ok(newSize >= size);
    assert.ok(view.annots.includes('Square'));
    const two = await appendIncrementalUpdate(out, await writeAnnotations(out, { add: [square('sq2', 200)] }));
    await strictlyValid(out, two);
  });

  test('edited bytes whose new objects reuse numbers below the original /Size: null (full save)', async () => {
    const orig = await makePdf(2); // object stream and cross-reference stream hold the top numbers
    const doc = await PDFDocument.load(orig, { updateMetadata: false });
    const page = doc.getPage(0);
    const ref = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 50, 50] }));
    assert.ok(ref.objectNumber < trailerSize(orig), 'pdf-lib alone hands out a taken number');
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
    assert.equal(await appendIncrementalUpdate(orig, await doc.save()), null);
  });

  test('certified original (DocMDP /P 1 or 2): null; /P 3 allows the update', async () => {
    for (const p of [1, 2]) {
      const orig = await makeSignedPdf({ exact: true, mdp: p });
      assert.equal(await docMdpPermission(orig), p);
      assert.equal(await appendIncrementalUpdate(orig, await writeAnnotations(orig, { add: [square('s', 40)] })), null);
    }
    const orig = await makeSignedPdf({ exact: true, mdp: 3 });
    assert.equal(await docMdpPermission(orig), 3);
    await strictlyValid(orig, await appendIncrementalUpdate(orig, await writeAnnotations(orig, { add: [square('s', 40)] })));
    assert.equal(await docMdpPermission(await makeSignedPdf({ exact: true })), null);
  });

  test('encrypted original: null instead of an error', async () => {
    const enc = await makeEncryptedPdf();
    assert.equal(await appendIncrementalUpdate(enc, await makePdf(1)), null);
  });

  test('the first update of the existing signed fixture passes the strict checks', async () => {
    const orig = await makeSignedPdf({ exact: true });
    await strictlyValid(orig, await appendIncrementalUpdate(orig, await writeAnnotations(orig, { add: [square('s', 40)] })));
  });
});

describe('signedSaveMode (saveTab)', () => {
  const bytes = new Uint8Array(1);
  const tab = (o = {}) => ({ path: '/a.pdf', signedPath: '/a.pdf', bytes, fileBytes: bytes, ...o });
  test('annotation-only save over the signed file: update', () => assert.equal(signedSaveMode(tab()), 'update'));
  test('requiresFullSave (applied redactions): never the incremental path', () => {
    assert.equal(signedSaveMode(tab({ requiresFullSave: true })), 'ask');
    assert.equal(signedSaveMode(tab({ requiresFullSave: true, signedPath: null })), 'plain');
  });
  test('certified, page operation: ask; Save As, unsigned, other path: plain', () => {
    assert.equal(signedSaveMode(tab({ certified: true })), 'ask');
    assert.equal(signedSaveMode(tab({ bytes: new Uint8Array(2) })), 'ask');
    assert.equal(signedSaveMode(tab(), true), 'plain');
    assert.equal(signedSaveMode(tab({ signedPath: null })), 'plain');
    assert.equal(signedSaveMode(tab({ signedPath: '/b.pdf' })), 'plain');
  });
});
