// Golden output of text boxes and callouts WITHOUT runs, captured before rich-text drawing existed:
// the FreeText appearance stream and the flattened page content must stay byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';
import { writeAnnotations, flattenObjects } from '../src/core/index.js';
import { makePdf, pageContent } from './helpers.js';

const TEXT = { id: 't', page: 0, type: 'text', x: 60, y: 80, w: 110, h: 50, text: 'Golden text box that wraps\nsecond para', fontSize: 13, font: 'Times', bold: true, color: '#336699', align: 'center', lineHeight: 1.3 };
const CALLOUT = { id: 'c', page: 0, type: 'callout', x: 200, y: 200, w: 90, h: 40, text: 'Callout words wrap here', tx: 320, ty: 300, stroke: '#ff0000', fill: '#ffffff', align: 'right' };

const GOLDEN = {
  text: {
    ap: 'q\n\nq\n1 0 0 1 0 0 cm\nq\n/GS-9742682568 gs\nBT\n0.2 0.4 0.6 rg\n/Times-Bold-7098480789 13 Tf\n24 TL\n1 0 0 1 10.943000000000005 39.22099999999999 Tm\n<476F6C64656E207465787420626F78> Tj\nT*\nET\nQ\nq\n/GS-9750469207 gs\nBT\n0.2 0.4 0.6 rg\n/Times-Bold-2000805986 13 Tf\n24 TL\n1 0 0 1 25.2105 22.320999999999984 Tm\n<74686174207772617073> Tj\nT*\nET\nQ\nq\n/GS-8450180107 gs\nBT\n0.2 0.4 0.6 rg\n/Times-Bold-7572533686 13 Tf\n24 TL\n1 0 0 1 21.5965 5.420999999999978 Tm\n<7365636F6E642070617261> Tj\nT*\nET\nQ\nQ\n\nQ\n\n',
    flat: 'q\n\nq\nBT\n0 0 0 rg\n/Helvetica-7098480789 12 Tf\n24 TL\n1 0 0 1 50 50 Tm\n<506167652031> Tj\nT*\nET\nQ\n\nQ\n\nq\n1 0 0 1 0 0 cm\nq\n/GS-9742682568 gs\nBT\n0.2 0.4 0.6 rg\n/Times-Bold-7098480789 13 Tf\n24 TL\n1 0 0 1 70.94300000000001 308.521 Tm\n<476F6C64656E207465787420626F78> Tj\nT*\nET\nQ\nq\n/GS-9750469207 gs\nBT\n0.2 0.4 0.6 rg\n/Times-Bold-2000805986 13 Tf\n24 TL\n1 0 0 1 85.2105 291.621 Tm\n<74686174207772617073> Tj\nT*\nET\nQ\nq\n/GS-8450180107 gs\nBT\n0.2 0.4 0.6 rg\n/Times-Bold-7572533686 13 Tf\n24 TL\n1 0 0 1 81.59649999999999 274.721 Tm\n<7365636F6E642070617261> Tj\nT*\nET\nQ\nQ\n',
  },
  callout: {
    ap: 'q\n\nq\n1 0 0 1 0 0 cm\nq\n1 0 0 RG\n1 w\n[] 0 d\n90.5 67 m\n90.5 67 m\n119.15835921350012 9.683281572999746 l\nS\nQ\nq\n1 0 0 1 0 107.5 cm\n1 0 0 1 0 0 cm\n1 0 0 -1 0 0 cm\n1 0 0 rg\n[] 0 d\n120.5 100.5 m\n115.67 96.207 l\n119.963 94.06 l\nh\nf\nQ\nq\n/GS-7098480789 gs\n1 1 1 rg\n1 0 0 RG\n1 w\n[] 0 d\n1 0 0 1 0.5 67 cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n0 0 m\n0 40 l\n90 40 l\n90 0 l\nh\nB\nQ\nq\n/GS-2000805986 gs\nBT\n1 0 0 rg\n/Helvetica-9742682568 10 Tf\n24 TL\n1 0 0 1 26.03 94.445 Tm\n<43616C6C6F757420776F726473> Tj\nT*\nET\nQ\nq\n/GS-7572533686 gs\nBT\n1 0 0 rg\n/Helvetica-9750469207 10 Tf\n24 TL\n1 0 0 1 42.14 82.445 Tm\n<777261702068657265> Tj\nT*\nET\nQ\nQ\n\nQ\n\n',
    flat: 'q\n\nq\nBT\n0 0 0 rg\n/Helvetica-7098480789 12 Tf\n24 TL\n1 0 0 1 50 50 Tm\n<506167652031> Tj\nT*\nET\nQ\n\nQ\n\nq\n1 0 0 1 0 0 cm\nq\n1 0 0 RG\n1 w\n[] 0 d\n290 160 m\n290 160 m\n318.65835921350015 102.68328157299976 l\nS\nQ\nq\n1 0 0 1 0 400 cm\n1 0 0 1 0 0 cm\n1 0 0 -1 0 0 cm\n1 0 0 rg\n[] 0 d\n320 300 m\n315.17 295.707 l\n319.463 293.56 l\nh\nf\nQ\nq\n/GS-7098480789 gs\n1 1 1 rg\n1 0 0 RG\n1 w\n[] 0 d\n1 0 0 1 200 160 cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n0 0 m\n0 40 l\n90 40 l\n90 0 l\nh\nB\nQ\nq\n/GS-2000805986 gs\nBT\n1 0 0 rg\n/Helvetica-9742682568 10 Tf\n24 TL\n1 0 0 1 225.53 187.445 Tm\n<43616C6C6F757420776F726473> Tj\nT*\nET\nQ\nq\n/GS-7572533686 gs\nBT\n1 0 0 rg\n/Helvetica-9750469207 10 Tf\n24 TL\n1 0 0 1 241.64 175.445 Tm\n<777261702068657265> Tj\nT*\nET\nQ\nQ\n',
  },
};

async function outputs(o) {
  const pdf = await makePdf(1, [400, 400]);
  const out = await writeAnnotations(pdf, { add: [o] }, { author: 'A', now: '2026-10-07T10:00:00.000Z' });
  const doc = await PDFDocument.load(out);
  const annot = doc.context.lookup(doc.getPage(0).node.Annots().asArray()[0]);
  const ap = annot.lookup(PDFName.of('AP')).lookup(PDFName.of('N'));
  return {
    ap: Buffer.from(decodePDFRawStream(ap).decode()).toString('latin1'),
    flat: await pageContent(await flattenObjects(pdf, [o])),
  };
}

for (const o of [TEXT, CALLOUT]) {
  test(`golden: a ${o.type} without runs draws byte-identical appearance and flattened content`, async () => {
    const got = await outputs(o);
    assert.equal(got.ap, GOLDEN[o.type].ap, 'appearance stream');
    assert.equal(got.flat, GOLDEN[o.type].flat, 'flattened page content');
  });
}
