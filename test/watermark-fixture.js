// Synthetic watermark fixture shared by test/watermarks.test.js and test/e2e/watermark-remove.mjs (a
// separate module: importing the test file would run its tests).
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

/**
 * Synthetic fixture (never a third-party file). Page 1: body text, an inline-dict watermark span with a
 * nested BDC/BMC, a named-/Properties watermark span, an /Artifact /Pagination page number, and a form
 * XObject holding a watermark span plus body text. Page 2: an Acrobat-style watermark form (PieceInfo)
 * and a /Watermark annotation. Page 3: an in-text span followed by unpositioned text (must be kept).
 */
export async function watermarkFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const form = ctx.register(ctx.stream('/Artifact <</Subtype /Watermark>> BDC BT /F1 30 Tf 10 10 Td (FORMWM) Tj ET EMC BT /F1 12 Tf 10 60 Td (Form body) Tj ET',
    { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 300], Resources: { Font: { F1: font.ref } } }));
  const acro = ctx.register(ctx.stream('BT /F1 40 Tf 0 0 Td (ACROWM) Tj ET', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 100], Resources: { Font: { F1: font.ref } },
    PieceInfo: { ADBE_CompoundType: { Private: 'Watermark', LastModified: '(D:2026)' } },
  }));
  const page = (content, extra = {}) => {
    const p = doc.addPage([612, 792]);
    p.node.set(PDFName.Resources, ctx.obj({ Font: { F1: font.ref }, XObject: { Fm1: form, Xi0: acro }, Properties: { MC0: { Type: 'Pagination', Subtype: 'Watermark' } }, ...extra }));
    p.node.set(PDFName.Contents, ctx.register(ctx.stream(content)));
    return p;
  };
  page(`BT /F1 12 Tf 50 700 Td (Body text one) Tj ET
/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q 1 0 0 rg BT /F1 48 Tf 100 400 Td (DRAFT) Tj ET /Span <</ActualText (x)>> BDC BT /F1 10 Tf 100 380 Td (NESTEDWM) Tj ET EMC /X BMC 100 100 50 50 re f EMC Q EMC
/Artifact /MC0 BDC BT /F1 20 Tf 100 300 Td (NAMEDWM) Tj ET EMC
/Artifact <</Type /Pagination>> BDC BT /F1 10 Tf 300 30 Td (Page 1) Tj ET EMC
q 1 0 0 1 100 100 cm /Fm1 Do Q
BT /F1 12 Tf 50 650 Td (Body text two) Tj ET`);
  const p2 = page(`BT /F1 12 Tf 50 700 Td (Second body) Tj ET
/OC /MC1 BDC q 1 0 0 1 100 300 cm /Xi0 Do Q EMC`, { Properties: { MC1: { Type: 'OCG', Name: '(Watermark)' } } });
  const wa = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Watermark', Rect: [0, 0, 100, 100] }));
  const sq = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 50, 50] }));
  p2.node.set(PDFName.Annots, ctx.obj([wa, sq]));
  page(`BT /F1 12 Tf 50 700 Td /Artifact <</Subtype /Watermark>> BDC (INTEXTWM) Tj EMC (Tail text) Tj ET`);
  return doc.save();
}
