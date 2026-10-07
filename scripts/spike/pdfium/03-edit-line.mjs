// Item 3: edit the text of one text object in place; remove + re-add; subset-font case.
import { loadPdfium, openDoc, listObjects, makeFixture, saveDoc, wide, free, getMatrix, setMatrix, pdfjsText, renderRGBA, OBJ, check } from './_lib.mjs';

const { m } = await loadPdfium();
const bytes = await makeFixture(1);
const d = openDoc(m, bytes);
const page = m.FPDF_LoadPage(d.doc, 0);
let tp = m.FPDFText_LoadPage(page);
const objs = listObjects(m, page, tp);
const helv = objs.find((o) => o.type === OBJ.TEXT && o.text.includes('4711'));
const sub = objs.find((o) => o.type === OBJ.TEXT && o.text.includes('Total'));
const pub = objs.find((o) => o.type === OBJ.TEXT && o.text.includes('Public'));

// (a) FPDFText_SetText on a standard-font (Helvetica, not embedded) object
let p = wide(m, 'Invoice number 4712 is paid');
check('(a) FPDFText_SetText Helvetica', m.FPDFText_SetText(helv.obj, p)); free(m, p);

// (b) FPDFText_SetText on an EMBEDDED SUBSET font object with glyphs not in the subset
p = wide(m, 'Total 9876 Zebra');
check('(b) FPDFText_SetText subset font', m.FPDFText_SetText(sub.obj, p)); free(m, p);

// (c) remove + re-add with a standard font at the same matrix/size
const mat = getMatrix(m, pub.obj);
const nt = m.FPDFPageObj_NewTextObj(d.doc, 'Helvetica', pub.size);
p = wide(m, 'Replaced line'); m.FPDFText_SetText(nt, p); free(m, p);
setMatrix(m, nt, mat);
m.FPDFPage_InsertObject(page, nt); // page takes ownership
check('(c) FPDFPage_RemoveObject old', m.FPDFPage_RemoveObject(page, pub.obj));
m.FPDFPageObj_Destroy(pub.obj); // caller owns removed objects

check('FPDFPage_GenerateContent', m.FPDFPage_GenerateContent(page));
m.FPDFText_ClosePage(tp); tp = m.FPDFText_LoadPage(page);
const after = listObjects(m, page, tp);
console.log('pdfium sees:', after.filter((o) => o.type === OBJ.TEXT).map((o) => `${JSON.stringify(o.text)} (${o.font})`).join(' | '));
const out = saveDoc(m, d.doc, 0);
const txt = await pdfjsText(out);
console.log('pdf.js extracts:', JSON.stringify(txt));
check('(a) new text extracted, old gone', txt.includes('4712 is paid') && !txt.includes('4711'));
check('(c) re-added text extracted, old gone', txt.includes('Replaced line') && !txt.includes('Public line'));
check('(c) same position', JSON.stringify(getMatrix(m, nt).map(Math.round)) === JSON.stringify(mat.map(Math.round)), `matrix=[${mat.map((v) => Math.round(v))}]`);
console.log(`(b) subset font: pdf.js extracts ${JSON.stringify(txt.match(/Total[^|]*?(?=\s+Invoice|\s+Replaced|\s+SECRET|$)/)?.[0] ?? '?')}`);
// Glyph coverage: render the subset line with PDFium and count ink in the region of the missing glyphs.
const d2 = openDoc(m, out); const pg2 = m.FPDF_LoadPage(d2.doc, 0); const img = renderRGBA(m, pg2, 1);
const ink = (x0, x1) => { let n = 0; for (let y = 792 - 668; y < 792 - 645; y++) for (let x = x0; x < x1; x++) if (img.px(x, y)[0] < 128) n++; return n; };
console.log(`(b) dark pixels rendered: "Total" span=${ink(50, 90)} ; rest-of-line span=${ink(95, 220)}`);
m.FPDF_ClosePage(pg2); d2.close();
m.FPDFText_ClosePage(tp); m.FPDF_ClosePage(page); d.close();
