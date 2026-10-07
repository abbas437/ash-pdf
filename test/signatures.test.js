import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { detectSignatures } from '../src/core/index.js';
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
