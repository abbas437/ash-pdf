import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { detectSignatures, mayBeSigned } from '../src/core/index.js';
import { makePdf, makeSignedPdf } from './helpers.js';

describe('detectSignatures', () => {
  test('plain unsigned PDF', async () => {
    assert.deepEqual(await detectSignatures(await makePdf(2)), { signed: false, fields: 0 });
  });

  test('signed PDF: /Sig value with /ByteRange and a signature field', async () => {
    const r = await detectSignatures(await makeSignedPdf());
    assert.equal(r.signed, true);
    assert.equal(r.fields, 1);
  });

  test('signed PDF saved with object streams is still detected', async () => {
    const doc = await PDFDocument.load(await makeSignedPdf());
    assert.deepEqual(await detectSignatures(await doc.save({ useObjectStreams: true })), { signed: true, fields: 1 });
  });

  test('signature dictionary given as a direct object (no SigFlags)', async () => {
    const doc = await PDFDocument.load(await makePdf(1));
    const ctx = doc.context;
    const field = ctx.register(ctx.obj({ FT: 'Sig', T: PDFHexString.fromText('S'), V: { Type: 'Sig', ByteRange: [0, 1, 2, 3] } }));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [field] }));
    assert.deepEqual(await detectSignatures(await doc.save()), { signed: true, fields: 1 });
  });

  test('empty signature field is not a signature', async () => {
    assert.deepEqual(await detectSignatures(await makeSignedPdf({ signed: false, sigFlags: 1 })), { signed: false, fields: 1 });
  });

  test('AcroForm /SigFlags AppendOnly alone marks the file as signed', async () => {
    const doc = await PDFDocument.load(await makePdf(1));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [], SigFlags: 2 }));
    assert.deepEqual(await detectSignatures(await doc.save()), { signed: true, fields: 0 });
  });

  test('unparseable bytes fall back to a raw scan', async () => {
    const bytes = await makeSignedPdf();
    bytes.set(new TextEncoder().encode('%XYZ'), 0); // no PDF header: pdf-lib refuses to parse
    await assert.rejects(PDFDocument.load(bytes.slice()));
    assert.deepEqual(await detectSignatures(bytes), { signed: true, fields: 1 });
  });

  test('never throws: garbage, empty, encrypted and non-byte input', async () => {
    const garbage = new Uint8Array(4096).map((_, i) => (i * 7919) % 251);
    assert.deepEqual(await detectSignatures(garbage), { signed: false, fields: 0 });
    assert.deepEqual(await detectSignatures(new Uint8Array(0)), { signed: false, fields: 0 });
    assert.deepEqual(await detectSignatures(null), { signed: false, fields: 0 });
    assert.deepEqual(await detectSignatures('not bytes'), { signed: false, fields: 0 });
    const doc = await PDFDocument.load(await makeSignedPdf());
    const pad = PDFHexString.of('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A');
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, Length: 40, P: -44, O: pad, U: pad }));
    assert.deepEqual(await detectSignatures(await doc.save({ useObjectStreams: false })), { signed: true, fields: 1 });
  });

  test('does not modify the caller bytes', async () => {
    const bytes = await makeSignedPdf();
    const copy = bytes.slice();
    await detectSignatures(bytes);
    assert.deepEqual(bytes, copy);
  });
});

describe('mayBeSigned (raw scan: false only when no signature can be in the file)', () => {
  const latin = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
  test('signed files, whatever /SigFlags says (0, 2, 3, absent object streams too)', async () => {
    for (const sigFlags of [0, 2, 3]) assert.equal(mayBeSigned(await makeSignedPdf({ sigFlags })), true, `sigFlags ${sigFlags}`);
    assert.equal(mayBeSigned(await makeSignedPdf({ objectStreams: true })), true, 'object streams');
  });
  test('a plain file without object streams or binary data: certainly unsigned', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    assert.equal(mayBeSigned(await doc.save({ useObjectStreams: false })), false);
  });
  test('names it cannot see past or that may name a signature', () => {
    assert.equal(mayBeSigned(latin('1 0 obj << /Type /ObjStm /N 3 /First 20 >> stream')), true, 'object stream');
    assert.equal(mayBeSigned(latin('1 0 obj << /Type /S#69g >> endobj')), true, '#-escaped name');
    assert.equal(mayBeSigned(latin('1 0 obj <</Type/Sig>> endobj')), true, '/Type/Sig without spaces');
    assert.equal(mayBeSigned(latin('1 0 obj <</ByteRange[0 1 2 3]>> endobj')), true, '/ByteRange');
    assert.equal(mayBeSigned(latin('1 0 obj <</SigFlags 0>> endobj')), true, '/SigFlags');
    assert.equal(mayBeSigned(latin('1 0 obj <</Type/Page/Signer 1/ByteRanges 2/ObjStms 1>> endobj')), true, '/Signer starts with Sig');
    assert.equal(mayBeSigned(latin('1 0 obj <</Type/Page/ByteRanges 2/ObjStms 1/Si 3>> endobj')), false, 'similar names only');
  });
});
